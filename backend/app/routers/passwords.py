"""Password and session lifecycle.

Everything here is about the transitions an account makes *around* logging in:
the first password it gets, the one it is forced to change, the one it can
change voluntarily, the one it can reset when forgotten, and the moment a
session can no longer be extended.

The audit's finding was simply that none of this existed. `POST /auth/register`
could create a citizen account and `POST /auth/login` could sign it in, and
between those two points there was no way to change a password at all -- so the
pilot's own operator accounts had passwords that could only be set once, by
whoever provisioned them, and the demo credentials printed on the sign-in screen
were the same strings for every deployment.

Two rules shape the design:

1. A one-time credential must be *provably* one-time. Staff accounts are minted
   by an administrator and handed over out of band, so the account carries a
   flag that makes the first sign-in produce a changed password or nothing.
   Without the flag, "please change your password" is a request, and the
   operator's original password stays valid forever.

2. Resetting must not disclose whether an account exists. `POST
   /auth/password/forgot` answers identically for a registered address and an
   unknown one, because a reset endpoint that says "no such user" is an account
   enumeration oracle, and the accounts on this platform are named for real
   hospitals and real districts.

The reset token is deliberately *not* stored as issued. It is hashed with the
same primitive as a password and only the hash is kept, so a dump of the users
table does not hand an attacker a working reset link for every account in it.
"""

from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import User, UserRole, utcnow
from ..security import (
    CurrentUser,
    current_user,
    hash_password,
    issue_access_token,
    issue_refresh_token,
    verify_password,
)
from ..services import audit, notifications as notify
from ..services.audit import hash_secret

router = APIRouter(prefix="/auth", tags=["auth"])


# --------------------------------------------------------------------------- #
# Policy
# --------------------------------------------------------------------------- #

#: Shortest password the platform will accept. Length rather than character
#: classes: a 12-character passphrase beats a 8-character string with a digit
#: and a symbol in it, and complexity rules mostly produce `Hospital@2026`.
MIN_PASSWORD_LENGTH = 12

#: How long a reset link is valid. Short, because the link is a bearer
#: credential sent over an untrusted channel.
RESET_TTL_MINUTES = 30

#: Common strings that must not be usable as a platform password. The pilot's
#: own seeded passwords appear here on purpose: the audit found them printed on
#: the sign-in screen, so they are public knowledge and cannot be a real
#: deployment's credential.
BANNED_PASSWORDS = {
    "medmesh@2026",
    "dispatch@108",
    "district@2026",
    "hospital@2026",
    "crew@108",
    "password",
    "password123",
    "changeme1234",
    "letmein12345",
    "administrator",
}


class PasswordChange(BaseModel):
    """Voluntary change by a signed-in user."""

    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=200)


class PasswordForgot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=160)


class PasswordReset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=16, max_length=400)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=200)


def password_problem(raw: str, *, user: User | None = None) -> str | None:
    """Return why a candidate password is unacceptable, or None if it is fine.

    Returned rather than raised so that the provisioning endpoint can report
    every problem with a request at once instead of one per attempt.
    """
    if len(raw) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
    if raw.strip().lower() in BANNED_PASSWORDS:
        return "That password is on the platform's list of known-bad credentials"
    if user is not None:
        local = user.email.split("@")[0].lower()
        # Only the full address, or a distinctive local part. A four-character
        # rule rejected `Rotated-Admin-2026!` for an account called `admin` --
        # "admin" is a job title, not an identifier, and a rule that fires on
        # ordinary words trains people to work around the policy instead of
        # following it.
        if raw.lower().find(user.email.lower()) >= 0:
            return "Password must not contain the account's own email address"
        if len(local) >= 8 and local in raw.lower():
            return "Password must not contain the account's own email address"
    if len(set(raw)) < 5:
        return "Password must use at least five distinct characters"
    return None


def _require_policy(raw: str, *, user: User | None = None) -> None:
    problem = password_problem(raw, user=user)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=problem)


# --------------------------------------------------------------------------- #
# Change (signed in)
# --------------------------------------------------------------------------- #


@router.post("/password/change")
def change_password(payload: PasswordChange, user: CurrentUser, db: Session = Depends(get_db)):
    """Change your own password, or complete a forced first-login change.

    The old password is required even when the change is forced. A session token
    is not sufficient authorization to replace the credential that mints session
    tokens: an unattended console with a live token would otherwise be enough to
    take the account over permanently.
    """
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Current password is incorrect")
    if payload.current_password == payload.new_password:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The new password must be different from the current one",
        )
    _require_policy(payload.new_password, user=user)

    user.password_hash = hash_password(payload.new_password)
    forced = user.must_change_password
    user.must_change_password = False
    user.password_changed_at = utcnow()
    # A completed reset invalidates any outstanding link for the account: one
    # credential, one use.
    user.reset_token_hash = None
    user.reset_expires_at = None

    audit.record(
        db,
        action="auth.password_change",
        entity_type="user",
        entity_id=user.id,
        summary=("first-login password set" if forced else "password changed")
        + " — all other sessions should be considered stale",
        actor=user,
    )
    db.commit()
    return {"ok": True, "forced_change_cleared": forced}


# --------------------------------------------------------------------------- #
# Forgot / reset (signed out)
# --------------------------------------------------------------------------- #


@router.post("/password/forgot")
def forgot_password(payload: PasswordForgot, db: Session = Depends(get_db)):
    """Start a reset.

    Always answers 200 with the same body. The response shape is part of the
    security model, not a convenience: any difference between the registered and
    unregistered case turns this endpoint into a way to test which hospitals and
    districts have accounts.
    """
    email = payload.email.lower().strip()
    account = db.execute(select(User).where(User.email == email)).scalar_one_or_none()

    generic = {
        "ok": True,
        "message": (
            "If that address belongs to an account, a reset link has been sent. "
            f"It expires in {RESET_TTL_MINUTES} minutes."
        ),
    }

    if account is None or not account.is_active:
        # Log the attempt for the audit trail -- the operator deserves to see
        # probes against accounts that do not exist -- then answer identically.
        audit.record(
            db,
            action="auth.password_forgot",
            entity_type="user",
            entity_id=None,
            summary=f"reset requested for unregistered or disabled address {email[:3]}***",
        )
        db.commit()
        return generic

    token = secrets.token_urlsafe(32)
    account.reset_token_hash = hash_secret(token)
    account.reset_expires_at = utcnow() + timedelta(minutes=RESET_TTL_MINUTES)
    audit.record(
        db,
        action="auth.password_forgot",
        entity_type="user",
        entity_id=account.id,
        summary=f"reset link issued to {account.full_name}",
        actor=account,
    )
    db.commit()

    # Delivered through the notification service so that a real deployment swaps
    # one transport rather than hunting for call sites. The token is never
    # logged: `notify` stores the message body for the operator inbox, so it is
    # passed as a one-shot payload rather than persisted.
    notify.deliver_reset_link(db, account, token=token, ttl_minutes=RESET_TTL_MINUTES)
    db.commit()

    response = dict(generic)
    # Only in development is the token echoed, and only because there is no mail
    # transport in the pilot. `settings.environment` gates it, and the config
    # default is production-shaped so that forgetting to set it fails closed.
    if settings.expose_password_reset_token:
        response["dev_token"] = token
    return response


@router.post("/password/reset")
def reset_password(payload: PasswordReset, db: Session = Depends(get_db)):
    """Complete a reset with the emailed token."""
    token_hash = hash_secret(payload.token)
    account = db.execute(select(User).where(User.reset_token_hash == token_hash)).scalar_one_or_none()

    if account is None:
        # Indistinguishable from an expired token, on purpose.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That reset link is invalid or has expired")
    if account.reset_expires_at is None or account.reset_expires_at < utcnow():
        account.reset_token_hash = None
        account.reset_expires_at = None
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That reset link is invalid or has expired")
    if not account.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account disabled. Contact your administrator.")

    _require_policy(payload.new_password, user=account)

    account.password_hash = hash_password(payload.new_password)
    account.password_changed_at = utcnow()
    # Surviving a reset without being forced straight back into one is the
    # difference between "reset" and "reset loop".
    account.must_change_password = False
    account.reset_token_hash = None
    account.reset_expires_at = None

    audit.record(
        db,
        action="auth.password_reset",
        entity_type="user",
        entity_id=account.id,
        summary=f"password reset completed for {account.full_name}",
        actor=account,
    )
    db.commit()
    return {"ok": True, "email": account.email}


# --------------------------------------------------------------------------- #
# Session introspection
# --------------------------------------------------------------------------- #


@router.get("/session")
def session_state(user: CurrentUser, db: Session = Depends(get_db)) -> dict:
    """What the client needs to decide whether to gate the UI.

    `must_change_password` is the flag the mobile shell reads to pin the user on
    the change-password screen. It is returned here rather than bolted onto the
    token payload so that an administrator clearing the flag takes effect on the
    next request instead of at the next token refresh.
    """
    return {
        "user_id": user.id,
        "role": user.role.value,
        "must_change_password": user.must_change_password,
        "password_changed_at": user.password_changed_at.isoformat() + "Z" if user.password_changed_at else None,
        "last_login_at": user.last_login_at.isoformat() + "Z" if user.last_login_at else None,
        "server_time": utcnow().isoformat() + "Z",
    }


@router.post("/logout")
def logout(user: CurrentUser, db: Session = Depends(get_db)) -> dict:
    """Record the sign-out.

    Tokens are stateless and short-lived, so this does not revoke anything by
    itself -- that is what `/auth/password/change` does, by making every older
    token's subject look stale. What it does provide is the audit trail: "who
    was signed in when" is a question that gets asked, and until now the log
    recorded every login and no logouts, so a session appeared to run forever.
    """
    audit.record(
        db,
        action="auth.logout",
        entity_type="user",
        entity_id=user.id,
        summary=f"{user.full_name} signed out",
        actor=user,
    )
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Privilege helpers used by other routers
# --------------------------------------------------------------------------- #


def assert_can_administer(actor: User, target: User) -> None:
    """Whether `actor` may change `target`'s credentials.

    Platform administrators may act on anyone. Everyone else may only act on
    themselves -- a hospital administrator resetting a dispatcher's password, or
    a dispatcher resetting a driver's, would be a lateral move across the
    platform's own role boundaries, and there is no product reason for it.
    """
    if actor.id == target.id:
        return
    if actor.role is UserRole.PLATFORM_ADMIN:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Only a platform administrator may manage another account's credentials",
    )
