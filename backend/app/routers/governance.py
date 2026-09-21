"""Feedback loop, audit trail, user provisioning, and platform health.

The feedback endpoints are the citizen/dispatcher half of the trust engine
(§6.3): a report that a hospital "had no beds on arrival" is evidence, and it
lowers that facility's score until a human resolves it. Closing that loop is what
stops self-reported data from slowly diverging from reality.
"""

from __future__ import annotations

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status as http_status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..live import live_store
from ..models import (
    AuditLog,
    District,
    Feedback,
    FeedbackStatus,
    Hospital,
    Incident,
    User,
    UserRole,
    utcnow,
)
from ..schemas import FeedbackCreate, FeedbackResolve, RegisterRequest
from ..security import CurrentUser, OptionalUser, hash_password, require_roles
from ..services import audit
from ..services.trust import humanise_age

router = APIRouter(prefix="/governance", tags=["governance"])


# --------------------------------------------------------------------------- #
# Feedback
# --------------------------------------------------------------------------- #


@router.post("/feedback", status_code=http_status.HTTP_201_CREATED)
async def submit_feedback(
    payload: FeedbackCreate,
    user: OptionalUser,
    db: Session = Depends(get_db),
):
    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    if payload.incident_id and db.get(Incident, payload.incident_id) is None:
        raise HTTPException(status_code=404, detail="Incident not found")

    # Duplicate suppression: one incident can generate one report per hospital,
    # otherwise a frustrated crew tapping twice halves a facility's score.
    if payload.incident_id:
        existing = db.execute(
            select(Feedback).where(Feedback.hospital_id == hospital.id, Feedback.incident_id == payload.incident_id)
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="A report already exists for this incident and facility")

    feedback = Feedback(
        hospital_id=hospital.id,
        incident_id=payload.incident_id,
        submitted_by=user.id if user else None,
        reporter_role=user.role.value if user else (payload.reporter_role or "citizen"),
        kind=payload.kind,
        comment=payload.comment,
        created_at=utcnow(),
    )
    db.add(feedback)
    db.flush()

    audit.record(
        db,
        action="feedback.submit",
        entity_type="hospital",
        entity_id=hospital.id,
        summary=f"{payload.kind.replace('_', ' ')} reported against {hospital.short_name}",
        actor=user,
        payload={"feedback_id": feedback.id, "comment": payload.comment, "incident_id": payload.incident_id},
    )
    db.commit()

    await live_store.publish(
        "feedback.created",
        {"hospital_id": hospital.id, "kind": payload.kind, "feedback_id": feedback.id},
    )
    return {"id": feedback.id, "status": feedback.status.value, "message": "Thank you — this is reviewed by the district health office"}


@router.get("/feedback")
def list_feedback(
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL, UserRole.HOSPITAL_ADMIN)),
    db: Session = Depends(get_db),
    status_filter: str | None = Query(default=None, alias="status"),
    hospital_id: int | None = None,
    limit: int = Query(default=100, ge=1, le=300),
):
    if user.role is UserRole.HOSPITAL_ADMIN:
        hospital_id = user.hospital_id

    stmt = select(Feedback)
    if status_filter:
        stmt = stmt.where(Feedback.status == status_filter)
    if hospital_id:
        stmt = stmt.where(Feedback.hospital_id == hospital_id)
    rows = list(db.execute(stmt.order_by(Feedback.created_at.desc()).limit(limit)).scalars().all())

    hospitals = {h.id: h for h in db.execute(select(Hospital)).scalars().all()}
    return {
        "count": len(rows),
        "results": [
            {
                "id": f.id,
                "hospital_id": f.hospital_id,
                "hospital_name": hospitals[f.hospital_id].short_name if f.hospital_id in hospitals else "",
                "kind": f.kind,
                "kind_label": f.kind.replace("_", " ").title(),
                "comment": f.comment,
                "reporter_role": f.reporter_role,
                "status": f.status.value,
                "incident_id": f.incident_id,
                "created_at": f.created_at.isoformat() + "Z",
                "age": humanise_age(int((utcnow() - f.created_at).total_seconds())),
            }
            for f in rows
        ],
    }


@router.post("/feedback/{feedback_id}/resolve")
def resolve_feedback(
    feedback_id: int,
    payload: FeedbackResolve,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL)),
    db: Session = Depends(get_db),
):
    feedback = db.get(Feedback, feedback_id)
    if feedback is None:
        raise HTTPException(status_code=404, detail="Feedback not found")

    before = feedback.status.value
    feedback.status = FeedbackStatus(payload.status)

    audit.record(
        db,
        action="feedback.resolve",
        entity_type="hospital",
        entity_id=feedback.hospital_id,
        summary=f"report #{feedback.id} {before} → {payload.status}"
        + (" (counts against facility trust score)" if payload.status == "upheld" else ""),
        actor=user,
        payload={"note": payload.resolution_note, "kind": feedback.kind},
    )
    db.commit()
    return {"id": feedback.id, "status": feedback.status.value}


# --------------------------------------------------------------------------- #
# Audit trail
# --------------------------------------------------------------------------- #


@router.get("/audit")
def read_audit(
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL)),
    db: Session = Depends(get_db),
    action: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    actor_id: int | None = None,
    hours: int = Query(default=24, ge=1, le=24 * 90),
    limit: int = Query(default=200, ge=1, le=1000),
):
    since = utcnow() - timedelta(hours=hours)
    stmt = select(AuditLog).where(AuditLog.created_at >= since)
    if action:
        stmt = stmt.where(AuditLog.action.like(f"{action}%"))
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == str(entity_id))
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    rows = list(db.execute(stmt.order_by(AuditLog.created_at.desc()).limit(limit)).scalars().all())

    return {
        "count": len(rows),
        "results": [
            {
                "id": r.id,
                "at": r.created_at.isoformat() + "Z",
                "actor": r.actor_label,
                "role": r.actor_role,
                "action": r.action,
                "entity": f"{r.entity_type}:{r.entity_id}",
                "summary": r.summary,
                "payload": json.loads(r.payload) if r.payload else None,
                "ip": r.ip,
            }
            for r in rows
        ],
    }


@router.get("/audit/hospital/{hospital_id}")
def hospital_audit(
    hospital_id: int,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.HOSPITAL_ADMIN, UserRole.GOV_OFFICIAL)),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
):
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    rows = list(
        db.execute(
            select(AuditLog)
            .where(AuditLog.entity_type == "hospital", AuditLog.entity_id == str(hospital_id))
            .order_by(AuditLog.created_at.desc())
            .limit(limit)
        ).scalars().all()
    )
    return {
        "hospital_id": hospital_id,
        "results": [
            {
                "id": r.id,
                "at": r.created_at.isoformat() + "Z",
                "actor": r.actor_label,
                "role": r.actor_role,
                "action": r.action,
                "summary": r.summary,
                "payload": json.loads(r.payload) if r.payload else None,
            }
            for r in rows
        ],
    }


# --------------------------------------------------------------------------- #
# User provisioning
# --------------------------------------------------------------------------- #


@router.get("/users")
def list_users(
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
    role: str | None = None,
):
    stmt = select(User)
    if role:
        stmt = stmt.where(User.role == role)
    users = list(db.execute(stmt.order_by(User.role, User.full_name)).scalars().all())
    hospitals = {h.id: h for h in db.execute(select(Hospital)).scalars().all()}
    districts = {d.id: d for d in db.execute(select(District)).scalars().all()}
    return {
        "count": len(users),
        "results": [
            {
                "id": u.id,
                "email": u.email,
                "full_name": u.full_name,
                "role": u.role.value,
                "is_active": u.is_active,
                "hospital": hospitals[u.hospital_id].short_name if u.hospital_id in hospitals else None,
                "district": districts[u.district_id].name if u.district_id in districts else None,
                "last_login_at": u.last_login_at.isoformat() + "Z" if u.last_login_at else None,
                "created_at": u.created_at.isoformat() + "Z",
            }
            for u in users
        ],
    }


@router.post("/users", status_code=http_status.HTTP_201_CREATED)
def provision_user(
    payload: RegisterRequest,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """The only path that can mint an operational account. Kept behind
    platform_admin for the reason given in auth.py."""
    email = payload.email.lower().strip()
    if db.execute(select(User).where(User.email == email)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="That email is already registered")

    if payload.role is UserRole.HOSPITAL_ADMIN and payload.hospital_id is None:
        raise HTTPException(status_code=422, detail="Hospital staff accounts must be scoped to a facility")
    if payload.role is UserRole.GOV_OFFICIAL and payload.district_id is None:
        raise HTTPException(status_code=422, detail="Official accounts must carry a jurisdiction")

    created = User(
        email=email,
        full_name=payload.full_name.strip(),
        phone=payload.phone,
        password_hash=hash_password(payload.password),
        role=payload.role,
        hospital_id=payload.hospital_id,
        district_id=payload.district_id,
        amr_scope="facility" if payload.hospital_id else ("district" if payload.district_id else "state"),
    )
    db.add(created)
    db.flush()
    audit.record(
        db,
        action="user.provision",
        entity_type="user",
        entity_id=created.id,
        summary=f"{created.role.value} account created for {created.full_name}",
        actor=user,
    )
    db.commit()
    return {"id": created.id, "email": created.email, "role": created.role.value}


@router.patch("/users/{user_id}")
def set_user_active(
    user_id: int,
    is_active: bool,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")
    if target.id == user.id:
        raise HTTPException(status_code=409, detail="You cannot deactivate your own account")
    target.is_active = is_active
    audit.record(
        db,
        action="user.status",
        entity_type="user",
        entity_id=target.id,
        summary=f"{target.full_name} {'reactivated' if is_active else 'disabled'}",
        actor=user,
    )
    db.commit()
    return {"id": target.id, "is_active": target.is_active}


# --------------------------------------------------------------------------- #
# Platform health
# --------------------------------------------------------------------------- #


@router.get("/health")
def platform_health(db: Session = Depends(get_db)):
    """Public liveness summary. Feeds the status strip in the console header --
    operators need to know the platform itself is healthy before they trust the
    numbers it is showing them."""
    now = utcnow()
    hospitals = db.execute(select(func.count()).select_from(Hospital)).scalar_one()
    last_15 = db.execute(
        select(func.count()).select_from(Hospital).where(Hospital.verification == "verified")
    ).scalar_one()
    fresh = 0
    stale = 0
    for view in live_store.all():
        age = (now - view.recorded_at).total_seconds()
        if age <= settings.freshness_live_minutes * 60:
            fresh += 1
        elif age > settings.freshness_warm_minutes * 60:
            stale += 1

    latest_ingest = db.execute(select(func.max(AuditLog.created_at))).scalar_one()

    return {
        "status": "operational",
        "checked_at": now.isoformat() + "Z",
        "facilities": {"total": hospitals, "verified": last_15, "projected": len(list(live_store.all()))},
        "feed": {"live": fresh, "stale": stale, "coverage_pct": round(fresh / hospitals * 100, 1) if hospitals else 0},
        "realtime": {"clients": live_store.subscriber_count},
        "last_write_at": latest_ingest.isoformat() + "Z" if latest_ingest else None,
        "components": [
            {"name": "Ingestion", "state": "operational"},
            {"name": "Live capacity store", "state": "operational" if not live_store.is_empty() else "degraded"},
            {"name": "Matching engine", "state": "operational"},
            {"name": "Analytics warehouse", "state": "operational"},
        ],
    }
