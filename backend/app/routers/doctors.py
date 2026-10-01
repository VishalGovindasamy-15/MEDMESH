"""Doctor directory & specialist availability (§6.5).

The only personal data in the platform, and it is professional data: name,
registration number, specialisation, and whether that person is currently on
duty. No contact details, no schedules, no patient interactions. Registration
numbers are surfaced because a citizen checking "is there really a cardiologist
on duty at 2 a.m." deserves a verifiable identifier rather than an anonymous
initial.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import District, Doctor, Hospital, User, UserRole, utcnow
from ..repository import latest_capacity_map
from ..schemas import DoctorCreate, DoctorDutyUpdate, DoctorUpdate
from ..security import CurrentUser, OptionalUser, require_roles
from ..services import audit, lifecycle
from ..services.references import SPECIALTY_KEYS, SPECIALTY_LABELS, canonical_specialty
from ..services.lifecycle import duty_is_current
from ..services.trust import freshness, humanise_age

router = APIRouter(prefix="/doctors", tags=["doctors"])


def _duty_event(doctor: Doctor) -> dict:
    """The duty-change payload, built once and used by both publish paths."""
    return {
        "doctor_id": doctor.id,
        "hospital_id": doctor.hospital_id,
        "full_name": doctor.full_name,
        "specialty": doctor.specialty,
        "department": doctor.department,
        "on_duty": doctor.on_duty,
        "duty_end": doctor.duty_end.isoformat() + "Z" if doctor.duty_end else None,
    }


def _publish_duty(doctor: Doctor, *, event: str = "duty") -> bool:
    """Announce a change to who is on duty.

    Every path that can move a clinician on or off duty calls this -- the toggle,
    the roster edit, the add, the removal, and the shift rollover. The original
    code published from the toggle endpoint only, so a consultant added as
    on-duty at onboarding, or corrected through a roster edit, or removed while
    on duty, all changed the answer to "is there a cardiologist here right now"
    without the public directory being told. A directory that is right until
    somebody edits the roster is worse than one that is openly a snapshot.

    `publish_soon` rather than `await publish` because the roster endpoints are
    synchronous -- the event is scheduled onto the loop that owns the sockets,
    and a caller with no loop (the seeder, pytest) simply gets False.
    """
    from ..live import live_store

    if event == "removed":
        return live_store.publish_soon(
            "doctor.duty",
            {
                "doctor_id": doctor.id,
                "hospital_id": doctor.hospital_id,
                "removed": True,
            },
        )

    return live_store.publish_soon("doctor.duty", _duty_event(doctor))

SHIFT_WINDOWS = {
    "morning": (8, 14),
    "afternoon": (14, 20),
    "night": (20, 8),
    "on_call": (0, 24),
}


def _doctor_out(doctor: Doctor, hospital: Hospital | None, district: District | None) -> dict:
    """One clinician as every surface should see them.

    `on_duty` here is the *effective* answer, not the stored flag. A consultant
    whose window ended at 20:00 and whose row has not been swept yet is off duty,
    and this reports them as off duty -- the roster sweep is a tidy-up, not the
    thing that makes the statement true. The stored flag is still exposed as
    `roster_flag` for the roster screen, which is the one place where the
    difference between "somebody said on duty" and "is on duty" is meaningful.
    """
    state = lifecycle.duty_state(doctor)
    remaining = lifecycle.minutes_until_duty_end(doctor)
    on_now = state == "on_duty"

    return {
        "id": doctor.id,
        "full_name": doctor.full_name,
        "registration_no": doctor.registration_no,
        "specialty": doctor.specialty,
        "specialty_label": doctor.specialty.replace("_", " ").title(),
        "department": doctor.department,
        "designation": doctor.designation,
        "on_duty": on_now,
        "roster_flag": doctor.on_duty,
        "duty_state": state,
        "shift": doctor.shift,
        "shift_window": doctor.shift_window
        or "%02d:00–%02d:00" % SHIFT_WINDOWS.get(doctor.shift, (0, 24)),
        "duty_end": doctor.duty_end.isoformat() + "Z" if doctor.duty_end else None,
        # Signed: negative means the window has passed. A caller showing a
        # countdown needs to distinguish "ends in 4 minutes" from "ended 4
        # minutes ago", and a clamped zero cannot express the second.
        "minutes_remaining": remaining,
        "accepts_emergency": doctor.accepts_emergency,
        "languages": [x.strip() for x in (doctor.languages or "").split(",") if x.strip()],
        "last_toggled_at": doctor.last_toggled_at.isoformat() + "Z" if doctor.last_toggled_at else None,
        "hospital": (
            {
                "id": hospital.id,
                "name": hospital.name,
                "short_name": hospital.short_name,
                "type": hospital.type.value,
                "address": hospital.address,
                "lat": hospital.lat,
                "lng": hospital.lng,
                "phone": hospital.emergency_phone or hospital.contact_phone,
            }
            if hospital
            else None
        ),
        "district": {"id": district.id, "name": district.name} if district else None,
    }


@router.get("")
def search_doctors(
    user: OptionalUser,
    db: Session = Depends(get_db),
    specialty: str | None = None,
    district_id: int | None = None,
    hospital_id: int | None = None,
    hospital_type: str | None = Query(default=None, pattern="^(public|private|trust)$"),
    on_duty_only: bool = True,
    accepts_emergency: bool | None = None,
    q: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=80, ge=1, le=300),
):
    stmt = select(Doctor)
    if specialty:
        stmt = stmt.where(Doctor.specialty == specialty)
    if hospital_id:
        stmt = stmt.where(Doctor.hospital_id == hospital_id)
    if on_duty_only:
        # Effective duty, not the stored flag. This is the query behind the
        # public directory and behind the citizen's question "is there really a
        # cardiologist on duty at 2 a.m." -- the one place where answering from
        # a flag that expired six hours ago is the whole failure.
        stmt = stmt.where(duty_is_current())
    if accepts_emergency is not None:
        stmt = stmt.where(Doctor.accepts_emergency.is_(accepts_emergency))
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(Doctor.full_name.ilike(like) | Doctor.specialty.ilike(like))

    doctors = list(db.execute(stmt.order_by(Doctor.specialty, Doctor.full_name)).scalars().all())

    hospitals = {h.id: h for h in db.execute(select(Hospital)).scalars().all()}
    districts = {d.id: d for d in db.execute(select(District)).scalars().all()}

    results = []
    for d in doctors:
        h = hospitals.get(d.hospital_id)
        if h is None:
            continue
        if district_id and h.district_id != district_id:
            continue
        if hospital_type and h.type.value != hospital_type:
            continue
        if not h.expose_doctor_directory:
            # Private-hospital opt-out from §6.10: the facility appears in the
            # bed directory but its clinician roster stays internal.
            continue
        results.append(_doctor_out(d, h, districts.get(h.district_id)))

    by_specialty: dict[str, int] = {}
    for r in results:
        by_specialty[r["specialty_label"]] = by_specialty.get(r["specialty_label"], 0) + 1

    return {
        "count": len(results),
        "by_specialty": by_specialty,
        "results": results[:limit],
    }


@router.get("/{doctor_id}")
def doctor_detail(doctor_id: int, user: OptionalUser, db: Session = Depends(get_db)):
    """One clinician, subject to the same opt-out as the directory.

    The opt-out is a property of the *facility*, not of the search endpoint. A
    hospital that hides its roster from the directory has hidden it -- the
    restriction has to hold against a direct id lookup too, or it is a filter
    rather than a policy, and anyone who has seen a doctor id once can still
    read the record. Staff of the facility, platform administrators and
    government analysts keep access; the public does not.
    """
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail="Doctor not found")
    hospital = db.get(Hospital, doctor.hospital_id)
    if hospital is not None and not hospital.expose_doctor_directory and not _can_see_internal_roster(user, hospital):
        raise HTTPException(
            status_code=404,
            detail="Doctor not found",
        )
    district = db.get(District, hospital.district_id) if hospital else None
    return _doctor_out(doctor, hospital, district)


def _can_see_internal_roster(user: User | None, hospital: Hospital) -> bool:
    """Who may read a roster that the facility has withheld from the public."""
    if user is None:
        return False
    if user.role in (UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL):
        return True
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id == hospital.id:
        return True
    if user.role is UserRole.DISPATCHER:
        # Dispatch needs to know whether a specialist is on duty in order to
        # route a patient. That is the platform's core question, and it is
        # answered by the matching engine regardless of the public directory
        # setting -- so refusing it here would hide information the same user
        # already receives in a shortlist.
        return True
    return False


#: Human-readable window for each shift. Named distinctly from the existing
#: SHIFT_WINDOWS tuple table used by `_doctor_out` -- a module-level name reused
#: for two different shapes is exactly the collision that produces a `%d format`
#: TypeError at runtime rather than at import.
SHIFT_WINDOW_LABELS = {
    "morning": "08:00 – 14:00",
    "afternoon": "14:00 – 20:00",
    "night": "20:00 – 08:00",
    "on_call": "On call",
}


def _assert_roster_scope(user: User, hospital_id: int) -> None:
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")


def _canonical_or_422(raw: str) -> str:
    """Validate against the shared catalogue, with a 422 that lists the options."""
    try:
        return canonical_specialty(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": str(exc),
                "allowed": list(SPECIALTY_KEYS),
                "allowed_labels": [SPECIALTY_LABELS[k] for k in SPECIALTY_KEYS],
            },
        ) from exc


def _roster_change(db: Session, doctor: Doctor, *, changes: list[str], actor: User, action: str) -> None:
    """One audit shape for every roster mutation, so the log reads consistently."""
    if not changes:
        return
    audit.record(
        db,
        action=action,
        entity_type="doctor",
        entity_id=doctor.id,
        summary=f"{doctor.full_name} ({doctor.specialty}): " + "; ".join(changes),
        actor=actor,
    )


@router.post("", status_code=201)
def add_doctor(
    payload: DoctorCreate,
    user: User = Depends(require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Add a clinician to a facility's roster.

    Returns the full record rather than `{"id", "full_name"}`. The roster screen
    has to render the new row immediately, and a response that cannot be rendered
    forces either a full refetch or a locally-guessed row that differs from what
    the server stored — the second of which is how a list ends up disagreeing
    with its own database.
    """
    _assert_roster_scope(user, payload.hospital_id)

    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Facility not found")

    specialty = _canonical_or_422(payload.specialty)

    registration = (payload.registration_no or "").strip() or None
    if registration:
        clash = db.execute(select(Doctor).where(Doctor.registration_no == registration)).scalar_one_or_none()
        if clash is not None:
            raise HTTPException(
                status_code=409,
                detail=f"Registration {registration} is already recorded against {clash.full_name}",
            )

    doctor = Doctor(
        hospital_id=payload.hospital_id,
        full_name=payload.full_name.strip(),
        registration_no=registration,
        specialty=specialty,
        department=payload.department or SPECIALTY_LABELS[specialty],
        designation=payload.designation.strip() or "Consultant",
        shift=payload.shift,
        shift_window=payload.shift_window or SHIFT_WINDOW_LABELS[payload.shift],
        accepts_emergency=payload.accepts_emergency,
        languages=payload.languages,
        on_duty=payload.on_duty,
    )
    db.add(doctor)
    db.flush()
    if doctor.on_duty:
        doctor.last_toggled_at = utcnow()
    audit.record(
        db,
        action="doctor.create",
        entity_type="doctor",
        entity_id=doctor.id,
        summary=(
            f"{doctor.full_name} ({SPECIALTY_LABELS[specialty]}) added to {hospital.short_name}'s roster"
            + (" and marked on duty" if doctor.on_duty else "")
        ),
        actor=user,
    )
    db.commit()

    if doctor.on_duty:
        _publish_duty(doctor)

    district = db.get(District, hospital.district_id)
    return _doctor_out(doctor, hospital, district)


@router.patch("/{doctor_id}")
def update_doctor(
    doctor_id: int,
    payload: DoctorUpdate,
    user: User = Depends(require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Correct a roster entry.

    Adding and removing were the only operations the API offered, so a specialty
    typed wrong at onboarding could only be fixed by deleting the clinician and
    re-entering them — which destroys the duty history the analytics read. A
    partial edit is the right primitive for a record whose fields are mostly
    right.
    """
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail="Doctor not found")
    _assert_roster_scope(user, doctor.hospital_id)

    data = payload.model_dump(exclude_unset=True)
    changes: list[str] = []

    if "specialty" in data and data["specialty"]:
        canonical = _canonical_or_422(data["specialty"])
        if canonical != doctor.specialty:
            changes.append(f"specialty {SPECIALTY_LABELS[doctor.specialty]} -> {SPECIALTY_LABELS[canonical]}")
            doctor.specialty = canonical
            # The department follows unless the caller named one. Department is
            # derived from specialty at creation and the two only diverge when
            # somebody means them to -- "Orthopaedics" reporting under "Surgery"
            # is a real arrangement, so an explicit department wins.
            if "department" not in data:
                doctor.department = SPECIALTY_LABELS[canonical]

    if "registration_no" in data:
        registration = (data["registration_no"] or "").strip() or None
        if registration and registration != doctor.registration_no:
            clash = db.execute(
                select(Doctor).where(Doctor.registration_no == registration, Doctor.id != doctor.id)
            ).scalar_one_or_none()
            if clash is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"Registration {registration} is already recorded against {clash.full_name}",
                )
        if registration != doctor.registration_no:
            changes.append(f"registration {doctor.registration_no or '—'} -> {registration or '—'}")
            doctor.registration_no = registration

    for field in ("full_name", "designation", "shift_window", "department", "languages"):
        if field in data and data[field] is not None and getattr(doctor, field) != data[field]:
            changes.append(f"{field.replace('_', ' ')} {getattr(doctor, field)} -> {data[field]}")
            setattr(doctor, field, data[field])

    if "shift" in data and data["shift"] and data["shift"] != doctor.shift:
        changes.append(f"shift {doctor.shift} -> {data['shift']}")
        doctor.shift = data["shift"]
        if "shift_window" not in data:
            doctor.shift_window = SHIFT_WINDOW_LABELS[data["shift"]]

    if "accepts_emergency" in data and data["accepts_emergency"] is not None:
        if data["accepts_emergency"] != doctor.accepts_emergency:
            changes.append(f"accepts emergency referrals {doctor.accepts_emergency} -> {data['accepts_emergency']}")
            doctor.accepts_emergency = data["accepts_emergency"]

    if "on_duty" in data and data["on_duty"] is not None and data["on_duty"] != doctor.on_duty:
        changes.append(f"duty {doctor.on_duty} -> {data['on_duty']}")
        doctor.on_duty = data["on_duty"]
        doctor.last_toggled_at = utcnow()
        doctor.duty_end = None if data["on_duty"] else utcnow()

    _roster_change(db, doctor, changes=changes, actor=user, action="doctor.update")
    db.commit()

    if any(c.startswith("duty ") for c in changes):
        _publish_duty(doctor)

    hospital = db.get(Hospital, doctor.hospital_id)
    district = db.get(District, hospital.district_id) if hospital else None
    payload_out = _doctor_out(doctor, hospital, district)
    payload_out["changed"] = changes
    return payload_out


@router.delete("/{doctor_id}", status_code=204)
def remove_doctor(
    doctor_id: int,
    user: User = Depends(require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Take a clinician off the roster.

    A hard delete, and deliberately so: the record carries no clinical history —
    the audit log holds the trail of who was added, changed and removed and by
    whom — and leaving departed staff in the roster is what makes a facility
    appear to have cover it does not have. A soft delete here would be the worst
    of both: invisible to the operator who removed them, visible to the matching
    chain that still counts them.
    """
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail="Doctor not found")
    _assert_roster_scope(user, doctor.hospital_id)

    hospital = db.get(Hospital, doctor.hospital_id)
    audit.record(
        db,
        action="doctor.remove",
        entity_type="doctor",
        entity_id=doctor.id,
        summary=(
            f"{doctor.full_name} ({SPECIALTY_LABELS.get(doctor.specialty, doctor.specialty)}) removed from "
            f"{hospital.short_name if hospital else doctor.hospital_id}'s roster"
            + (" while on duty" if doctor.on_duty else "")
        ),
        actor=user,
    )
    was_on_duty = doctor.on_duty
    db.delete(doctor)
    db.commit()

    # Announced *after* the row is gone, and carrying only the id, so a
    # subscriber cannot repopulate the directory from the event itself. Before
    # this, removing an on-duty consultant left them on the public board until
    # the page was reloaded by hand.
    if was_on_duty:
        _publish_duty(doctor, event="removed")
    return None


@router.post("/{doctor_id}/duty")
async def set_duty(
    doctor_id: int,
    payload: DoctorDutyUpdate,
    user: User = Depends(require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail="Doctor not found")
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != doctor.hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    doctor.on_duty = payload.on_duty
    doctor.last_toggled_at = utcnow()
    doctor.duty_start = utcnow() if payload.on_duty else doctor.duty_start
    doctor.duty_end = payload.duty_end if payload.on_duty else None
    if payload.on_duty and doctor.duty_end is None:
        # Default to a 12-hour window; roster integration overrides this.
        doctor.duty_end = utcnow() + timedelta(hours=12)

    audit.record(
        db,
        action="doctor.duty",
        entity_type="doctor",
        entity_id=doctor.id,
        summary=f"{doctor.full_name} → {'on duty' if payload.on_duty else 'off duty'}",
        actor=user,
    )
    db.commit()

    from ..live import live_store

    await live_store.publish("doctor.duty", _duty_event(doctor))
    hospital = db.get(Hospital, doctor.hospital_id)
    district = db.get(District, hospital.district_id) if hospital else None
    return _doctor_out(doctor, hospital, district)


@router.post("/roster/rollover")
def rollover_shifts(
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Ends duty windows that have elapsed.

    Without this a night-shift consultant stays 'on duty' through the following
    afternoon and the public directory quietly lies.

    The sweep is no longer what makes the answer correct -- every read applies
    `duty_is_current()` -- but it is still worth running, because it converges
    the stored flag and publishes the duty-change event that tells connected
    clients to re-render. A background loop in `services/roster.py` calls this
    path every five minutes; the endpoint stays available so an operator can
    force it after correcting a roster.
    """
    now = utcnow()
    closed = lifecycle.rollover_expired_duty(db)
    ended = len(closed)
    audit.record(
        db,
        action="doctor.rollover",
        entity_type="roster",
        entity_id="all",
        summary=f"{ended} duty window(s) closed automatically",
        actor=user,
    )
    db.commit()

    # Announced, not just written. A rollover that only touched the database
    # left the public board showing a night shift that had already ended, which
    # is the specific failure the endpoint was added to prevent.
    for doctor in closed:
        _publish_duty(doctor)
    return {"ended": ended, "at": now.isoformat() + "Z", "announced": len(closed)}


@router.get("/roster/summary")
def roster_summary(
    user: CurrentUser,
    db: Session = Depends(get_db),
    hospital_id: int | None = None,
):
    """Coverage gaps, which is the question a duty manager actually asks:
    'which specialties do we have nobody on for right now?'"""
    if user.role is UserRole.HOSPITAL_ADMIN:
        hospital_id = user.hospital_id
    stmt = select(Doctor)
    if hospital_id:
        stmt = stmt.where(Doctor.hospital_id == hospital_id)
    doctors = list(db.execute(stmt).scalars().all())

    latest = latest_capacity_map(db, [hospital_id]) if hospital_id else {}
    row = latest.get(hospital_id) if hospital_id else None
    band = freshness(row.recorded_at) if row else None

    specialty_counts: dict[str, dict] = {}
    for d in doctors:
        entry = specialty_counts.setdefault(d.specialty, {"specialty": d.specialty, "total": 0, "on_duty": 0})
        entry["total"] += 1
        entry["on_duty"] += 1 if d.on_duty else 0

    return {
        "total_roster": len(doctors),
        "on_duty": sum(1 for d in doctors if d.on_duty),
        "uncovered_specialties": [v["specialty"] for v in specialty_counts.values() if v["on_duty"] == 0],
        "by_specialty": sorted(specialty_counts.values(), key=lambda x: x["specialty"]),
        "capacity_report_age": (
            {"seconds": band.age_seconds, "label": humanise_age(band.age_seconds), "state": band.state} if band else None
        ),
    }
