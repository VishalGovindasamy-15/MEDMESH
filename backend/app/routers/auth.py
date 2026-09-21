"""Authentication.

Citizens never need this. The four operational roles do, and each role's token
carries its scope so downstream routers never have to re-derive "which hospital
is this person allowed to touch" from a join.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import District, Hospital, User, UserRole, utcnow
from ..schemas import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse
from ..security import (
    current_user,
    decode_token,
    hash_password,
    issue_access_token,
    issue_refresh_token,
    verify_password,
)
from ..services import audit

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_payload(db: Session, user: User) -> dict:
    hospital = db.get(Hospital, user.hospital_id) if user.hospital_id else None
    district = db.get(District, user.district_id) if user.district_id else None
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "phone": user.phone,
        "role": user.role.value,
        "hospital_id": user.hospital_id,
        "hospital_name": hospital.name if hospital else None,
        "district_id": user.district_id,
        "district_name": district.name if district else None,
        "scope": user.amr_scope,
        "last_login_at": user.last_login_at.isoformat() + "Z" if user.last_login_at else None,
    }


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.execute(select(User).where(User.email == payload.email.lower().strip())).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        # One message for both failure modes -- do not confirm which emails exist.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account disabled. Contact your administrator.")

    user.last_login_at = utcnow()
    audit.record(
        db,
        action="auth.login",
        entity_type="user",
        entity_id=user.id,
        summary=f"{user.role.value} signed in",
        actor=user,
        ip=request.client.host if request.client else None,
    )
    db.commit()

    token, ttl = issue_access_token(user)
    return TokenResponse(
        access_token=token,
        refresh_token=issue_refresh_token(user),
        expires_in=ttl,
        user=_user_payload(db, user),
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenResponse:
    import jwt as pyjwt

    try:
        claims = decode_token(payload.refresh_token)
    except pyjwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token invalid or expired") from exc
    if claims.get("typ") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not a refresh token")

    user = db.get(User, int(claims["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account no longer active")

    token, ttl = issue_access_token(user)
    return TokenResponse(
        access_token=token,
        refresh_token=issue_refresh_token(user),
        expires_in=ttl,
        user=_user_payload(db, user),
    )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Self-service registration is restricted to citizens. Operational roles are
    provisioned by a platform admin -- an unauthenticated endpoint that could mint
    a `hospital_admin` token would make the whole RBAC model decorative."""
    if payload.role is not UserRole.CITIZEN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Operational accounts are provisioned by a MedMesh administrator",
        )
    email = payload.email.lower().strip()
    if db.execute(select(User).where(User.email == email)).scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with that email already exists")

    user = User(
        email=email,
        full_name=payload.full_name.strip(),
        phone=payload.phone,
        password_hash=hash_password(payload.password),
        role=UserRole.CITIZEN,
    )
    db.add(user)
    db.flush()
    audit.record(db, action="auth.register", entity_type="user", entity_id=user.id, summary="citizen self-registration", actor=user)
    db.commit()

    token, ttl = issue_access_token(user)
    return TokenResponse(
        access_token=token,
        refresh_token=issue_refresh_token(user),
        expires_in=ttl,
        user=_user_payload(db, user),
    )


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    return _user_payload(db, user)
