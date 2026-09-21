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

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import District, Doctor, Hospital, User, UserRole, utcnow
from ..repository import latest_capacity_map
from ..schemas import DoctorCreate, DoctorDutyUpdate
from ..security import CurrentUser, OptionalUser, require_roles
from ..services import audit
from ..services.trust import freshness, humanise_age

router = APIRouter(prefix="/doctors", tags=["doctors"])

SHIFT_WINDOWS = {
    "morning": (8, 14),
    "afternoon": (14, 20),
    "night": (20, 8),
    "on_call": (0, 24),
}


def _doctor_out(doctor: Doctor, hospital: Hospital | None, district: District | None) -> dict:
    duty_state = "off_duty"
    if doctor.on_duty:
        if doctor.duty_end is None:
            duty_state = "on_duty"
        else:
            secs = int((doctor.duty_end - utcnow()).total_seconds())
            duty_state = "on_duty" if secs > 0 else "shift_ended"

    return {
        "id": doctor.id,
        "full_name": doctor.full_name,
        "registration_no": doctor.registration_no,
        "specialty": doctor.specialty,
        "specialty_label": doctor.specialty.replace("_", " ").title(),
        "department": doctor.department,
        "designation": doctor.designation,
        "on_duty": doctor.on_duty,
        "duty_state": duty_state,
        "shift": doctor.shift,
        "shift_window": "%02d:00–%02d:00" % SHIFT_WINDOWS.get(doctor.shift, (0, 24)),
        "duty_end": doctor.duty_end.isoformat() + "Z" if doctor.duty_end else None,
        "minutes_remaining": max(0, int((doctor.duty_end - utcnow()).total_seconds() // 60)) if doctor.duty_end else None,
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
        stmt = stmt.where(Doctor.on_duty.is_(True))
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
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail="Doctor not found")
    hospital = db.get(Hospital, doctor.hospital_id)
    district = db.get(District, hospital.district_id) if hospital else None
    return _doctor_out(doctor, hospital, district)


@router.post("", status_code=201)
def add_doctor(
    payload: DoctorCreate,
    user: User = Depends(require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != payload.hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    if db.execute(select(Doctor).where(Doctor.registration_no == payload.registration_no)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="A doctor with that registration number already exists")

    doctor = Doctor(**payload.model_dump(), on_duty=False)
    db.add(doctor)
    db.flush()
    audit.record(
        db,
        action="doctor.create",
        entity_type="doctor",
        entity_id=doctor.id,
        summary=f"{doctor.full_name} ({doctor.specialty}) added to roster",
        actor=user,
    )
    db.commit()
    return {"id": doctor.id, "full_name": doctor.full_name}


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

    await live_store.publish(
        "doctor.duty",
        {
            "doctor_id": doctor.id,
            "hospital_id": doctor.hospital_id,
            "full_name": doctor.full_name,
            "specialty": doctor.specialty,
            "on_duty": doctor.on_duty,
        },
    )
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
    afternoon and the public directory quietly lies. A scheduler calls it every
    five minutes in production.
    """
    now = utcnow()
    ended = 0
    for doctor in db.execute(select(Doctor).where(Doctor.on_duty.is_(True))).scalars().all():
        if doctor.duty_end and doctor.duty_end <= now:
            doctor.on_duty = False
            doctor.duty_start = None
            doctor.duty_end = None
            ended += 1
    audit.record(
        db,
        action="doctor.rollover",
        entity_type="roster",
        entity_id="all",
        summary=f"{ended} duty window(s) closed automatically",
        actor=user,
    )
    db.commit()
    return {"ended": ended, "at": now.isoformat() + "Z"}


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
