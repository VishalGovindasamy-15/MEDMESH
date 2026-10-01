"""Read-side helpers shared by the routers.

These exist so the routers stay thin and the "latest capacity per hospital"
question is answered in exactly one place. The window-function query below is
the SQLite-compatible form of `DISTINCT ON (hospital_id)` in PostgreSQL -- the
comment records the production variant so nobody 'optimises' it into something
that breaks on the other engine.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .services.lifecycle import duty_is_current
from .models import (
    Ambulance,
    BedHold,
    CapacityRecord,
    District,
    Doctor,
    Feedback,
    FeedbackStatus,
    HoldStatus,
    Hospital,
    Incident,
    IncidentStatus,
    SurgeEvent,
    User,
    UserRole,
    utcnow,
)
from .services import trust as trust_engine

# Statuses that mean a bed hold is still consuming capacity.
HOLD_LIVE = (HoldStatus.ACTIVE,)


def latest_capacity_map(db: Session, hospital_ids: list[int] | None = None) -> dict[int, CapacityRecord]:
    """Newest non-quarantined capacity row per hospital."""
    newest = (
        select(
            CapacityRecord.hospital_id.label("hid"),
            func.max(CapacityRecord.recorded_at).label("ts"),
        )
        .where(CapacityRecord.quarantined.is_(False))
        .group_by(CapacityRecord.hospital_id)
    )
    if hospital_ids is not None:
        if not hospital_ids:
            return {}
        newest = newest.where(CapacityRecord.hospital_id.in_(hospital_ids))
    newest = newest.subquery()

    stmt = select(CapacityRecord).join(
        newest,
        (CapacityRecord.hospital_id == newest.c.hid) & (CapacityRecord.recorded_at == newest.c.ts),
    )
    rows = db.execute(stmt).scalars().all()
    return {r.hospital_id: r for r in rows}


def previous_capacity(db: Session, hospital_id: int, *, before: datetime | None = None) -> CapacityRecord | None:
    """The row immediately preceding the current one, used for anomaly diffs."""
    stmt = (
        select(CapacityRecord)
        .where(CapacityRecord.hospital_id == hospital_id)
        .where(CapacityRecord.recorded_at < (before or utcnow()))
        .order_by(CapacityRecord.recorded_at.desc())
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none()


def capacity_series(db: Session, hospital_id: int, *, hours: int = 24) -> list[CapacityRecord]:
    since = utcnow() - timedelta(hours=hours)
    stmt = (
        select(CapacityRecord)
        .where(CapacityRecord.hospital_id == hospital_id, CapacityRecord.recorded_at >= since)
        .order_by(CapacityRecord.recorded_at.asc())
    )
    return list(db.execute(stmt).scalars().all())


def active_holds(db: Session, *, hospital_id: int | None = None) -> list[BedHold]:
    """Expire-on-read. A scheduler also sweeps these, but a dispatcher must never
    see a hold that has silently lapsed because the sweeper was busy."""
    now = utcnow()
    stale = db.execute(
        select(BedHold).where(BedHold.status == HoldStatus.ACTIVE, BedHold.expires_at <= now)
    ).scalars().all()
    for hold in stale:
        hold.status = HoldStatus.EXPIRED
        hold.released_at = now
        hold.release_reason = "hold window elapsed"
    if stale:
        db.commit()

    stmt = select(BedHold).where(BedHold.status.in_(HOLD_LIVE))
    if hospital_id is not None:
        stmt = stmt.where(BedHold.hospital_id == hospital_id)
    return list(db.execute(stmt).scalars().all())


def hold_counts(db: Session, hospital_id: int) -> dict[str, int]:
    counts: dict[str, int] = {}
    for hold in active_holds(db, hospital_id=hospital_id):
        counts[hold.resource] = counts.get(hold.resource, 0) + 1
    return counts


def sync_hold_projection(db: Session, hospital_id: int) -> None:
    from .live import live_store

    live_store.set_hold_counts(hospital_id, hold_counts(db, hospital_id))


def active_surge(db: Session, district_id: int | None = None) -> SurgeEvent | None:
    stmt = select(SurgeEvent).where(SurgeEvent.active.is_(True))
    if district_id is not None:
        stmt = stmt.where(SurgeEvent.district_id == district_id)
    return db.execute(stmt.order_by(SurgeEvent.opened_at.desc()).limit(1)).scalar_one_or_none()


def any_surge(db: Session) -> SurgeEvent | None:
    return db.execute(
        select(SurgeEvent).where(SurgeEvent.active.is_(True)).order_by(SurgeEvent.opened_at.desc()).limit(1)
    ).scalar_one_or_none()


def trust_scores(db: Session, hospitals: list[Hospital], *, relaxed: bool = False) -> dict[int, dict]:
    """Batch-compute trust scores. Two aggregate queries rather than N+1 -- the
    public directory asks for this on every keystroke of a filter change."""
    if not hospitals:
        return {}
    ids = [h.id for h in hospitals]

    latest = latest_capacity_map(db, ids)

    fb_rows = db.execute(
        select(Feedback.hospital_id, Feedback.status, func.count())
        .where(Feedback.hospital_id.in_(ids))
        .group_by(Feedback.hospital_id, Feedback.status)
    ).all()
    fb: dict[int, dict[str, int]] = {}
    for hid, status, n in fb_rows:
        fb.setdefault(hid, {})[status.value if hasattr(status, "value") else str(status)] = n

    since = utcnow() - timedelta(hours=24)
    q_rows = db.execute(
        select(CapacityRecord.hospital_id, func.count())
        .where(
            CapacityRecord.hospital_id.in_(ids),
            CapacityRecord.quarantined.is_(True),
            CapacityRecord.recorded_at >= since,
        )
        .group_by(CapacityRecord.hospital_id)
    ).all()
    quarantined = {hid: n for hid, n in q_rows}

    out: dict[int, dict] = {}
    for h in hospitals:
        row = latest.get(h.id)
        fbm = fb.get(h.id, {})
        verdict = trust_engine.score_facility(
            h,
            last_updated=row.recorded_at if row else None,
            open_feedback=fbm.get("open", 0) + fbm.get("under_review", 0),
            upheld_feedback=fbm.get("upheld", 0),
            quarantined_24h=quarantined.get(h.id, 0),
            relaxed=relaxed,
        )
        out[h.id] = verdict.to_wire()
    return out


def open_incidents(db: Session, *, district_id: int | None = None) -> list[Incident]:
    """Every trip that is still running.

    The list is derived from the lifecycle's terminal states rather than written
    out by hand. The hand-written version stopped at `arrived`, so the moment the
    trip model gained the states between scene arrival and handover, a patient
    being transported in the back of an ambulance dropped out of the dispatcher's
    queue, out of the "incidents open" counter and out of the district rollup --
    while the vehicle itself stayed committed. Defining it as a complement means
    a new state is in the queue by default, which is the safe direction for this
    particular list.
    """
    from .services.lifecycle import TERMINAL_STATES

    live = tuple(st for st in IncidentStatus if st not in TERMINAL_STATES)
    stmt = select(Incident).where(Incident.status.in_(live))
    if district_id is not None:
        stmt = stmt.where(Incident.district_id == district_id)
    return list(db.execute(stmt.order_by(Incident.created_at.desc())).scalars().all())


def ambulance_for_user(db: Session, user: User) -> Ambulance | None:
    """The vehicle a driver account is linked to.

    The platform's rule is one driver, one active vehicle: a crew account is a
    person who drives a specific ambulance, and every screen on their device is
    built around "my unit". The previous version of this function expressed that
    rule as `scalar_one_or_none()`, which does not enforce anything -- it just
    raises `MultipleResultsFound` the first time somebody links a second vehicle,
    turning a data-entry mistake into a 500 on the driver's screen mid-trip.

    So the rule is now enforced where it belongs (a partial unique index on
    `driver_id`, plus an explicit unassign in the assignment endpoint) and this
    read is written to be total: if the invariant is ever violated by a path we
    have not thought of, the driver gets a working screen for one of their
    vehicles rather than a stack trace. The lowest id wins so the answer is at
    least stable across calls.
    """
    return db.execute(
        select(Ambulance).where(Ambulance.driver_id == user.id).order_by(Ambulance.id).limit(1)
    ).scalar_one_or_none()


def ambulances_for_user(db: Session, user: User) -> list[Ambulance]:
    """Every vehicle linked to a driver. Used by the admin screen to surface a
    broken link, and by the invariant check in the test suite."""
    return list(
        db.execute(select(Ambulance).where(Ambulance.driver_id == user.id).order_by(Ambulance.id))
        .scalars()
        .all()
    )


def visible_district_ids(db: Session, user: User | None) -> list[int] | None:
    """None means 'no restriction'. Government officials are scoped by
    jurisdiction; everyone else sees the whole pilot region."""
    if user is None:
        return None
    if user.role is UserRole.GOV_OFFICIAL and user.district_id:
        return [user.district_id]
    return None


def hospital_directory(db: Session, *, district_id: int | None = None) -> list[Hospital]:
    stmt = select(Hospital).where(Hospital.verification != "suspended")
    if district_id is not None:
        stmt = stmt.where(Hospital.district_id == district_id)
    return list(db.execute(stmt.order_by(Hospital.name)).scalars().all())


def on_duty_doctors(db: Session, *, hospital_ids: list[int] | None = None) -> list[Doctor]:
    """Clinicians actually on duty, meaning the window has not elapsed.

    `duty_is_current()` rather than the bare flag: the matching engine ranks a
    facility partly on whether a specialist for this presentation is present, and
    a stale flag is the difference between a cardiac case going to a hospital
    with a cardiologist and going to one with an empty office.
    """
    stmt = select(Doctor).where(duty_is_current())
    if hospital_ids is not None:
        if not hospital_ids:
            return []
        stmt = stmt.where(Doctor.hospital_id.in_(hospital_ids))
    return list(db.execute(stmt.order_by(Doctor.specialty, Doctor.full_name)).scalars().all())


def districts(db: Session) -> list[District]:
    return list(db.execute(select(District).order_by(District.name)).scalars().all())
