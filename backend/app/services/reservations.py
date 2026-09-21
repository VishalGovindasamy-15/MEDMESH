"""Bed reservations.

Every path that puts a bed on hold goes through `reserve()` here. That is the
point of the module: a hold is a *claim on a finite resource*, and the only
correct place to decide whether a claim fits is inside a critical section that
no other claimant can enter.

The original implementation read free capacity from the in-memory projection and
then wrote a hold, which is a read-then-write race:

    dispatcher A  →  reads icu_effective = 1
    dispatcher B  →  reads icu_effective = 1
    dispatcher A  →  writes hold on the last ICU bed
    dispatcher B  →  writes hold on the last ICU bed     ← two crews, one bed

Correct on a laptop, wrong the first time two operators click at once. The fix
has three parts:

1.  **A per-facility critical section.** `_FACILITY_LOCKS` serialises callers
    inside one process, which is what a single-node pilot runs. `SELECT … FOR
    UPDATE` on the facility row covers multiple workers and is a no-op on
    SQLite, where the writer lock already serialises transactions.

2.  **Count from the database, not the cache.** Effective capacity is derived
    from committed rows inside that section. The projection is a read model for
    the UI; it must never be the authority for a reservation, because it is
    updated *after* the write it reflects.

3.  **Write and re-derive under the same lock**, so the projection everyone else
    reads is refreshed before the section is released rather than after.

The SQLite pilot gets this for free from the serialised writer; the locking
below is what makes it correct on PostgreSQL with several uvicorn workers.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import BedHold, CapacityRecord, HoldStatus, Hospital, utcnow
from ..repository import active_holds, hold_counts, sync_hold_projection

# One lock per facility. A dict of locks guarded by a lock, so two requests for
# two different hospitals never wait on each other.
_REGISTRY_GUARD = threading.Lock()
_FACILITY_LOCKS: dict[int, threading.Lock] = {}


def _facility_lock(hospital_id: int) -> threading.Lock:
    with _REGISTRY_GUARD:
        lock = _FACILITY_LOCKS.get(hospital_id)
        if lock is None:
            lock = threading.Lock()
            _FACILITY_LOCKS[hospital_id] = lock
        return lock


@contextmanager
def hold_critical_section(db: Session, hospital_id: int):
    """Serialise reservation work for one facility.

    Order matters: the process lock is taken first so that only one thread is
    ever inside a write transaction for this facility, then the row lock is
    requested. Taking them the other way round would let two threads each hold a
    row lock and then queue on the process lock, which on a database with real
    row locking is a deadlock waiting to happen.
    """
    lock = _facility_lock(hospital_id)
    lock.acquire()
    try:
        # `with_for_update()` is emitted only on dialects that support it.
        # SQLAlchemy ignores it on SQLite, which is correct -- SQLite has a
        # single writer, so the transaction below is already exclusive.
        db.execute(select(Hospital.id).where(Hospital.id == hospital_id).with_for_update()).all()
        yield
    finally:
        lock.release()


def free_capacity(db: Session, hospital_id: int) -> dict[str, int]:
    """Capacity available to *new* claimants, computed from committed state.

    Deliberately does not use `live_store`: that is a cache refreshed after
    writes, so reading it inside a critical section reintroduces exactly the
    race the critical section exists to remove.
    """
    latest = db.execute(
        select(CapacityRecord)
        .where(CapacityRecord.hospital_id == hospital_id)
        .order_by(CapacityRecord.recorded_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    held = hold_counts(db, hospital_id)

    if latest is None:
        return {"bed": 0, "icu": 0, "ventilator": 0}

    return {
        "bed": max(0, latest.beds_available - held.get("bed", 0)),
        "icu": max(0, latest.icu_available - held.get("icu", 0)),
        "ventilator": max(0, latest.ventilators_available - held.get("ventilator", 0)),
    }


class ReservationError(Exception):
    """Raised when a hold cannot be granted. Carries the human-readable reason."""

    def __init__(self, detail: str, *, available: int = 0):
        super().__init__(detail)
        self.detail = detail
        self.available = available


def reserve(
    db: Session,
    *,
    hospital_id: int,
    resource: str,
    incident_id: int | None,
    actor_id: int | None,
    ttl_seconds: int | None = None,
) -> BedHold:
    """Claim one unit of `resource` at a facility, or refuse.

    Refusal is a first-class outcome, not an error condition to be worked
    around: telling a dispatcher "no ICU beds free at SRMC" two seconds before
    the crew arrives is infinitely better than granting a hold that a second
    crew also believes it owns.
    """
    ttl = min(ttl_seconds or settings.default_hold_ttl_seconds, settings.max_hold_ttl_seconds)

    with hold_critical_section(db, hospital_id):
        available = free_capacity(db, hospital_id).get(resource, 0)
        if available <= 0:
            hospital = db.get(Hospital, hospital_id)
            label = {"bed": "general bed", "icu": "ICU bed", "ventilator": "ventilator"}.get(
                resource, resource
            )
            raise ReservationError(
                f"No free {label} to hold at {hospital.short_name if hospital else hospital_id} — "
                "another crew has the last one",
                available=0,
            )

        hold = BedHold(
            hospital_id=hospital_id,
            incident_id=incident_id,
            resource=resource,
            status=HoldStatus.ACTIVE,
            created_by=actor_id,
            created_at=utcnow(),
            expires_at=utcnow() + timedelta(seconds=ttl),
        )
        db.add(hold)
        # Flush inside the section so the row exists before the count below is
        # recomputed -- otherwise the projection is refreshed from a database
        # that does not yet contain this hold, and the next reader sees it free.
        db.flush()
        sync_hold_projection(db, hospital_id)

    return hold


def consume_for_incident(db: Session, incident_id: int, *, reason: str) -> list[BedHold]:
    """Mark holds as consumed -- the patient arrived and took the bed.

    Distinct from `release_for_incident`: a consumed hold means the bed is now
    occupied, a released one means it goes back into the pool. Collapsing the
    two would let a handed-over patient's bed be re-offered to the next crew.
    """
    consumed: list[BedHold] = []
    touched: set[int] = set()
    for hold in active_holds(db):
        if hold.incident_id != incident_id:
            continue
        with hold_critical_section(db, hold.hospital_id):
            hold.status = HoldStatus.CONSUMED
            hold.released_at = utcnow()
            hold.release_reason = reason
            touched.add(hold.hospital_id)
        consumed.append(hold)

    db.flush()
    for hospital_id in touched:
        sync_hold_projection(db, hospital_id)
    return consumed


def release(db: Session, hold: BedHold, *, reason: str) -> None:
    """Give a bed back. Also serialised, for the same reason as `reserve`."""
    with hold_critical_section(db, hold.hospital_id):
        hold.status = HoldStatus.RELEASED
        hold.released_at = utcnow()
        hold.release_reason = reason
        db.flush()
        sync_hold_projection(db, hold.hospital_id)


def release_for_incident(db: Session, incident_id: int, *, reason: str) -> list[BedHold]:
    """Release every live hold belonging to one incident.

    Used on handover, cancellation and re-route. Returns the holds that were
    released so callers can report which beds went back into the pool.
    """
    released: list[BedHold] = []
    touched: set[int] = set()
    for hold in active_holds(db):
        if hold.incident_id != incident_id:
            continue
        with hold_critical_section(db, hold.hospital_id):
            hold.status = HoldStatus.RELEASED
            hold.released_at = utcnow()
            hold.release_reason = reason
            touched.add(hold.hospital_id)
        released.append(hold)

    db.flush()
    for hospital_id in touched:
        sync_hold_projection(db, hospital_id)
    return released
