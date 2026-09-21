"""Password hashing, JWT issue/verify, and the RBAC dependency factories.

Token shape is deliberately boring: HS256, `sub` = user id, `role`, `scope`
(facility / district) and an explicit `aud`. Production swaps the signer for the
OIDC provider named in the report (Keycloak/Auth0) -- `verify_token` is the only
function that has to change.
"""

from __future__ import annotations

import hmac
import time
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Iterable

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings
from .models import User, UserRole

_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)

# Auto-error so /docs works but the scheme is explicit in generated clients.
bearer = HTTPBearer(auto_error=False)


def hash_password(raw: str) -> str:
    return _hasher.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        _hasher.verify(hashed, raw)
        return True
    except (VerifyMismatchError, VerificationError, Exception):
        return False


def _encode(payload: dict[str, Any], ttl: timedelta) -> str:
    now = datetime.now(UTC)
    body = {
        **payload,
        "iat": int(now.timestamp()),
        "nbf": int(now.timestamp()) - 5,
        "exp": int((now + ttl).timestamp()),
        "aud": "medmesh-api",
        "iss": "medmesh",
    }
    return jwt.encode(body, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def issue_access_token(user: User) -> tuple[str, int]:
    ttl = timedelta(minutes=settings.access_token_ttl_minutes)
    token = _encode(
        {
            "sub": str(user.id),
            "role": user.role.value,
            "name": user.full_name,
            "hospital_id": user.hospital_id,
            "district_id": user.district_id,
            "scope": user.amr_scope,
        },
        ttl,
    )
    return token, int(ttl.total_seconds())


def issue_refresh_token(user: User) -> str:
    return _encode({"sub": str(user.id), "typ": "refresh"}, timedelta(days=settings.refresh_token_ttl_days))


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=[settings.jwt_algorithm],
        audience="medmesh-api",
        issuer="medmesh",
    )


# --------------------------------------------------------------------------- #
# Dependencies
# --------------------------------------------------------------------------- #

Credentials = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]


def current_user_optional(request: Request, creds: Credentials) -> User | None:
    """Citizens browse without logging in, so most read endpoints accept an
    anonymous caller and simply drop to public scope."""
    from .database import SessionLocal

    if creds is None:
        return None
    try:
        claims = decode_token(creds.credentials)
    except jwt.PyJWTError:
        return None
    if claims.get("typ") == "refresh":
        return None
    db = SessionLocal()
    try:
        user = db.get(User, int(claims["sub"]))
        if user is None or not user.is_active:
            return None
        db.expunge(user)
        return user
    finally:
        db.close()


def current_user(user: User | None = Depends(current_user_optional)) -> User:
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


CurrentUser = Annotated[User, Depends(current_user)]
OptionalUser = Annotated[User | None, Depends(current_user_optional)]


def require_roles(*roles: UserRole):
    allowed = set(roles)

    def _guard(user: CurrentUser) -> User:
        if user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.role.value}' is not permitted to perform this action",
            )
        return user

    return _guard


def require_facility_scope(user: CurrentUser, hospital_id: int) -> None:
    """Hospital staff may only read/write their own facility. Platform admins and
    the state health directorate bypass, because they already see everything."""
    if user.role in (UserRole.PLATFORM_ADMIN,):
        return
    if user.role is not UserRole.HOSPITAL_ADMIN:
        return
    if user.hospital_id != hospital_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is scoped to a different facility",
        )


def constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def now_ts() -> float:
    return time.time()
