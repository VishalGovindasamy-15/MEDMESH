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
from ..config import settings
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
        # The shell reads this to pin the user on the change-password screen
        # before anything else renders. Returning it with every sign-in means an
        # administrator clearing the flag takes effect at the next login rather
        # than whenever a token happens to expire.
        "must_change_password": user.must_change_password,
        "password_changed_at": user.password_changed_at.isoformat() + "Z" if user.password_changed_at else None,
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

    # The same policy as a staff account. A citizen's sign-in is the key to their
    # own lookup history, and the platform has no way to know whether the phone
    # it runs on is shared.
    from .passwords import _require_policy

    _require_policy(payload.password)

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


@router.get("/demo-accounts")
def demo_accounts() -> dict:
    """The pilot's published sign-in credentials, if this deployment has any.

    These were previously four string literals in the sign-in component, which
    meant every build of the app -- pilot, staging, production -- carried a
    working platform-administrator password in its JavaScript bundle. Moving them
    behind a server flag does not make them secret in the pilot; it makes it
    possible for a deployment to *not* have them, and it puts the decision in one
    place instead of in a compiled artefact.

    Returns an empty list when `MEDMESH_DEMO_MODE` is off, which is the default.
    A production deployment that forgets to configure the flag therefore shows an
    empty sign-in screen rather than an administrator's password.
    """
    if not settings.demo_mode:
        return {
            "demo_mode": False,
            "environment": settings.environment,
            "accounts": [],
            "note": "This deployment does not publish pilot credentials.",
        }
    return {
        "demo_mode": True,
        "environment": settings.environment,
        "accounts": DEMO_ACCOUNTS,
        "note": (
            "Pilot dataset. Every account below is seeded test data and the passwords are "
            "published deliberately — rotate them before any real traffic. Staff accounts are "
            "flagged for a forced password change on first sign-in."
        ),
    }


#: Seeded pilot accounts, paired with what each one is for. Descriptions rather
#: than adjectives: someone evaluating the platform needs to know which surface
#: each credential opens, and "demo user 3" does not say that.
DEMO_ACCOUNTS = [
    {
        "role": "citizen",
        "label": "Citizen portal",
        "email": "citizen@medmesh.in",
        "password": "Citizen@2026",
        "surface": "/",
        "description": "Public bed and ICU search in English or Tamil, no account needed to browse.",
    },
    {
        "role": "hospital_admin",
        "label": "Hospital operations",
        "email": "admin@srmc.medmesh.in",
        "password": "Hospital@2026",
        "surface": "/dashboard",
        "description": "SRMC's own counters, inbound ambulances, roster and connector status.",
    },
    {
        "role": "dispatcher",
        "label": "108 dispatch console",
        "email": "dispatch@medmesh.in",
        "password": "Dispatch@108",
        "surface": "/console",
        "description": "Incident intake, capability-aware shortlist, crew assignment and routing.",
    },
    {
        "role": "driver",
        "label": "Ambulance crew",
        "email": "crew@medmesh.in",
        "password": "Crew@108",
        "surface": "/crew",
        "description": "The crew's own trip: scene navigation, handover and offline resilience.",
    },
    {
        "role": "gov_official",
        "label": "District health office",
        "email": "gov@medmesh.in",
        "password": "District@2026",
        "surface": "/analytics",
        "description": "Scoped district analytics, SLA reporting and CSV export.",
    },
    {
        "role": "platform_admin",
        "label": "Platform administration",
        "email": "admin@medmesh.in",
        "password": "MedMesh@2026",
        "surface": "/admin",
        "description": "Statewide oversight, account provisioning, fleet and connector management.",
    },
]


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    return _user_payload(db, user)
