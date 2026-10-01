"""Background loops that keep the platform's own statements true.

The roster is the first of these. `POST /doctors/roster/rollover` existed to end
duty windows that had elapsed, and the docstring said "a scheduler calls it every
five minutes in production" -- but no scheduler did, in this pilot or anywhere in
the tree. The endpoint was reachable, the audit found it, and between the two of
them sat a night-shift consultant still advertised as on duty at four in the
afternoon.

Reads no longer depend on the sweep (see `lifecycle.duty_is_current`), so a
missing scheduler can only make the stored flag untidy, never make the answer
wrong. It is still run, because the sweep is what publishes the duty-change
event, and connected clients re-render from events rather than by polling the
roster every few seconds.

Deliberately small. A production deployment replaces this with the platform's own
job runner -- the point of having it here is that the pilot's behaviour matches
what the code claims, so that a bug in the *sweep* is discoverable in testing
rather than on the first night shift after go-live.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from ..config import settings
from ..database import SessionLocal
from ..models import Doctor, User, UserRole, utcnow

log = logging.getLogger("medmesh.roster")

#: Five minutes, as the endpoint's own documentation always said. A duty window
#: is measured in hours, so anything finer is wasted work; anything coarser and a
#: handover can sit announced for a tenth of the gap.
ROLLOVER_INTERVAL_SECONDS = 300


def run_rollover_once() -> int:
    """Sweep expired duty windows. Returns how many were closed.

    Synchronous and self-contained so pytest can call it directly: a background
    loop that can only be exercised by waiting five minutes is a background loop
    nobody tests.
    """
    # Imported here rather than at module scope: the doctors router imports the
    # lifecycle helpers, and importing the router from a service that the router
    # itself pulls in would close the cycle.
    from ..routers.doctors import _publish_duty
    from ..services import audit, lifecycle

    db = SessionLocal()
    closed = []
    try:
        closed = lifecycle.rollover_expired_duty(db)
        if closed:
            system = db.execute(
                select_system_actor()
            ).scalar_one_or_none()
            audit.record(
                db,
                action="doctor.rollover",
                entity_type="roster",
                entity_id="all",
                summary=f"{len(closed)} duty window(s) closed by the scheduler",
                actor=system,
            )
        db.commit()
    except Exception:  # noqa: BLE001 -- a sweep must not kill its own loop
        db.rollback()
        log.exception("roster rollover failed")
        return 0
    finally:
        db.close()

    for doctor in closed:
        _publish_duty(doctor)
    if closed:
        log.info("roster rollover closed %d duty window(s)", len(closed))
    return len(closed)


def select_system_actor():
    """The audit row is attributed to the platform, not to a person.

    Attributed to a real administrator account where one exists, so the audit
    trail never contains an actor that cannot be resolved -- an unnamed "system"
    entry in a governance log is a question nobody can answer later.
    """
    from ..models import User as _User

    return (
        select(_User)
        .where(_User.role == UserRole.PLATFORM_ADMIN, _User.is_active.is_(True))
        .order_by(_User.id)
        .limit(1)
    )


async def roster_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(run_rollover_once)
        except Exception:  # noqa: BLE001
            log.exception("roster loop iteration failed")
        await asyncio.sleep(ROLLOVER_INTERVAL_SECONDS)


async def start_background_loops() -> list[asyncio.Task]:
    """Start the roster sweep unless a deployment has turned scheduling off.

    Separate from the demo simulator's switch: the simulator produces synthetic
    capacity reports and must never run against real facilities, whereas the
    roster sweep is correct in every environment. It is tied to
    `simulator_enabled` for now only because the pilot has no other job runner,
    and a standalone scheduler that a test suite leaves running would mutate the
    shared test database underneath the assertions.
    """
    if not settings.simulator_enabled:
        return []
    task = asyncio.create_task(roster_loop(), name="roster")
    log.info("roster rollover loop started (every %ds)", ROLLOVER_INTERVAL_SECONDS)
    return [task]


# --------------------------------------------------------------------------- #
# Pilot roster renewal
#
# Facility capacity in this deployment is synthetic and the simulator keeps it
# moving; the roster is synthetic for exactly the same reason and needs the same
# treatment. Seeded duty windows were written relative to seed time with an end
# within a few hours, so once duty expiry started being enforced the pilot went
# from "a cardiologist is on duty at 62% of facilities" to "twelve clinicians on
# duty statewide" over the course of a day -- correct arithmetic on data that had
# quietly become nonsense.
#
# This does not invent a schedule. It re-reads the one the seed already encoded:
# each doctor was given a shift (`morning`, `afternoon`, `night`, `on_call`) and
# this puts them back on duty when the clock is inside their own shift, with a
# window that ends when that shift does. A doctor on `night` is on duty at 2 a.m.
# and off at 2 p.m., which is what their row already claimed before it expired.
# --------------------------------------------------------------------------- #

#: Shift -> the hours of the local day it covers. `night` wraps midnight.
SHIFT_HOURS: dict[str, tuple[int, int]] = {
    "morning": (8, 14),
    "afternoon": (14, 20),
    "night": (20, 8),
    "on_call": (0, 24),
}


def shift_covering(hour: int) -> str:
    """Which shift a wall-clock hour belongs to."""
    if 8 <= hour < 14:
        return "morning"
    if 14 <= hour < 20:
        return "afternoon"
    return "night"


def renew_demo_roster(db) -> int:
    """Put the rostered shift back on duty. Returns how many were renewed.

    Only touches doctors whose stored flag is clear and whose window has gone, so
    it can never shorten a duty somebody set by hand. `on_call` is deliberately
    left alone: an on-call consultant was seeded as a full-day window and, when
    that elapses, the honest answer is that they are no longer on call.
    """
    from datetime import timedelta

    now = utcnow()
    current = shift_covering(now.hour)
    renewed = 0

    # `duty_start IS NULL` is the signal that separates "the sweep cleared this"
    # from "a duty manager took them off". The duty endpoint preserves duty_start
    # when switching a clinician off (it is when their shift began, which is
    # still true), whereas the rollover clears the window outright. Renewing a
    # roster line a human deliberately cleared would be the renewal loop undoing
    # an instruction, so the test is exact rather than approximate.
    rows = db.execute(
        select(Doctor).where(
            Doctor.on_duty.is_(False),
            Doctor.duty_start.is_(None),
            Doctor.shift.in_((current, "on_call")),
        )
    ).scalars().all()
    for doctor in rows:
        if doctor.shift == "on_call":
            continue
        start_h, end_h = SHIFT_HOURS[current]
        end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=end_h - now.hour)
        if end <= now:
            end += timedelta(days=1)
        doctor.on_duty = True
        doctor.duty_start = now.replace(minute=0, second=0, microsecond=0)
        doctor.duty_end = end
        renewed += 1
    return renewed
