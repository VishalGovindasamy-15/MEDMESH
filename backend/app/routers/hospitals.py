"""Hospital directory, profile and the ingestion endpoints.

`POST /hospitals/{id}/capacity` is the single write path into the platform.
Whether the numbers arrive from an HL7-FHIR connector, a vendor REST hook, the
manual dashboard or the quick-adjust keypad, they all land here and pass the same
trust screen. That is deliberate: a second ingest path would be a second place
for the anomaly rules to be forgotten.
"""

from __future__ import annotations

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..live import CapacityView, live_store
from ..models import (
    Ambulance,
    BedHold,
    CapacityRecord,
    District,
    Doctor,
    EdCongestion,
    Incident,
    HoldStatus,
    Hospital,
    IntegrationMode,
    User,
    UserRole,
    VerificationStatus,
    utcnow,
)
from ..repository import (
    active_holds,
    any_surge,
    capacity_series,
    hold_counts,
    latest_capacity_map,
    previous_capacity,
    trust_scores,
)
from ..schemas import CapacityPush, HospitalCreate, QuickAdjust, VerificationUpdate
from ..security import CurrentUser, OptionalUser, require_roles
from ..services import audit
from ..services import trust as trust_engine
from ..services import lifecycle
from ..services.lifecycle import duty_is_current
from ..services.geo import estimate_leg

router = APIRouter(prefix="/hospitals", tags=["hospitals"])


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _specialty_list(hospital: Hospital) -> list[str]:
    return [s.strip() for s in (hospital.specialties or "").split(",") if s.strip()]


def _facility_type_label(value: str) -> str:
    return {"public": "Government", "private": "Private", "trust": "Trust / charitable"}.get(value, value)


def hospital_card(hospital: Hospital, cap: CapacityView | None, trust: dict | None, *, holds: int = 0) -> dict:
    return {
        "id": hospital.id,
        "slug": hospital.slug,
        "name": hospital.name,
        "short_name": hospital.short_name,
        "type": hospital.type.value,
        "type_label": _facility_type_label(hospital.type.value),
        "district_id": hospital.district_id,
        "address": hospital.address,
        "lat": hospital.lat,
        "lng": hospital.lng,
        "phone": hospital.contact_phone,
        "emergency_phone": hospital.emergency_phone,
        "verification": hospital.verification.value,
        "integration": hospital.integration.value,
        "source_system": hospital.source_system,
        "expose_doctor_directory": hospital.expose_doctor_directory,
        "specialties": _specialty_list(hospital),
        "capabilities": {
            "blood_bank": hospital.has_blood_bank,
            "trauma_centre": hospital.has_trauma_centre,
            "cath_lab": hospital.has_cath_lab,
            "burn_unit": hospital.has_burn_unit,
            "dialysis": hospital.has_dialysis,
            "neonatal_icu": hospital.has_neonatal_icu,
        },
        "declared": {
            "beds": hospital.total_beds,
            "icu": hospital.total_icu,
            "ventilators": hospital.total_ventilators,
        },
        "capacity": cap.to_wire() if cap else None,
        "trust": trust,
    }


def _on_duty_summary(db: Session, hospital: Hospital) -> dict:
    """Clinician cover at one facility: counts, specialties, emergency capability.

    Counts and specialty names only -- no clinician is identified on a directory
    listing. A family choosing where to take a snakebite needs to know the
    facility has a physician on duty who handles antivenom, not the name of the
    doctor, and the directory should not be a way to enumerate staff.

    A facility that has opted out of publishing its roster returns zeros rather
    than nothing, because a caller has to be able to distinguish "nobody on duty"
    from "this field was not sent".
    """
    if hospital.expose_doctor_directory is False:
        return {"available": False, "on_duty": 0, "accepting_emergency": 0, "specialties": [], "withheld": True}

    rows = db.execute(
        select(Doctor).where(Doctor.hospital_id == hospital.id, duty_is_current())
    ).scalars().all()
    specialties = sorted({(d.specialty or "").replace("_", " ") for d in rows if d.specialty})
    return {
        "available": True,
        "on_duty": len(rows),
        "accepting_emergency": sum(1 for d in rows if d.accepts_emergency),
        "specialties": specialties[:8],
        "withheld": False,
    }


def _record_view(row: CapacityRecord | None) -> dict | None:
    if row is None:
        return None
    return {
        "beds_available": row.beds_available,
        "icu_available": row.icu_available,
        "ventilators_available": row.ventilators_available,
        "ed_congestion": row.ed_congestion.value,
        "ed_waiting": row.ed_waiting,
        "blood_units": row.blood_units,
        "antivenom_vials": row.antivenom_vials,
        "recorded_at": row.recorded_at.isoformat() + "Z",
        "trust_state": row.trust_state,
        "quarantined": row.quarantined,
        "anomaly_flags": row.anomaly_flags,
    }


# --------------------------------------------------------------------------- #
# Directory (public, no login required)
# --------------------------------------------------------------------------- #


@router.get("")
def list_hospitals(
    user: OptionalUser,
    db: Session = Depends(get_db),
    district_id: int | None = None,
    type: str | None = Query(default=None, pattern="^(public|private|trust)$"),
    specialty: str | None = None,
    capability: str | None = None,
    q: str | None = Query(default=None, max_length=80),
    min_beds: int | None = Query(default=None, ge=0),
    require_icu: bool = False,
    require_ventilator: bool = False,
    include_unverified: bool | None = None,
    limit: int = Query(default=200, ge=1, le=500),
):
    """The citizen portal's workhorse. Returns every facility with its capacity
    projection already attached so one request drives the map, the list and the
    filters without client-side joins.

    Verification gates publication, and the gate differs by audience:

    *   **Anonymous callers** see only verified facilities. This is the fraud
        control the report asks for: a listing that nobody has checked must not
        be discoverable by a member of the public who will act on it.
    *   **Signed-in staff** additionally see facilities that are still under
        review, because a district hospital mid-verification may be the only ICU
        in range and a dispatcher must be able to route to it.
    *   **Suspended** facilities are never returned. Suspension is the outcome of
        a failed review, and such a listing should be reachable only from the
        onboarding queue.
    """
    stmt = select(Hospital).where(Hospital.verification != VerificationStatus.SUSPENDED)
    if district_id:
        stmt = stmt.where(Hospital.district_id == district_id)
    if type:
        stmt = stmt.where(Hospital.type == type)

    staff = bool(user and user.role in (
        UserRole.DISPATCHER,
        UserRole.HOSPITAL_ADMIN,
        UserRole.GOV_OFFICIAL,
        UserRole.PLATFORM_ADMIN,
        UserRole.DRIVER,
    ))
    show_unverified = staff if include_unverified is None else bool(include_unverified and staff)
    if not show_unverified:
        stmt = stmt.where(Hospital.verification == VerificationStatus.VERIFIED)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(Hospital.name.ilike(like) | Hospital.address.ilike(like))
    if capability:
        col = {
            "blood_bank": Hospital.has_blood_bank,
            "trauma_centre": Hospital.has_trauma_centre,
            "cath_lab": Hospital.has_cath_lab,
            "burn_unit": Hospital.has_burn_unit,
            "dialysis": Hospital.has_dialysis,
            "neonatal_icu": Hospital.has_neonatal_icu,
        }.get(capability)
        if col is not None:
            stmt = stmt.where(col.is_(True))

    hospitals = list(db.execute(stmt.order_by(Hospital.name)).scalars().all())

    if specialty:
        want = specialty.strip().lower()
        hospitals = [h for h in hospitals if want in {s.lower() for s in _specialty_list(h)}]

    district_names = {d.id: d.name for d in db.execute(select(District)).scalars().all()}

    relaxed = any_surge(db) is not None
    scores = trust_scores(db, hospitals, relaxed=relaxed)
    rows = latest_capacity_map(db, [h.id for h in hospitals])

    cards = []
    for h in hospitals:
        view = live_store.get(h.id)
        holds = hold_counts(db, h.id) if view and view.holds_active else {}

        if min_beds or require_icu or require_ventilator:
            if view is None:
                continue
            if min_beds and view.beds_effective < min_beds:
                continue
            if require_icu and view.icu_effective <= 0:
                continue
            if require_ventilator and view.vent_effective <= 0:
                continue

        card = hospital_card(h, view, scores.get(h.id), holds=sum(holds.values()))
        card["district_name"] = district_names.get(h.district_id, "")
        card["latest_record"] = _record_view(rows.get(h.id))
        card["holds"] = holds
        # Who is actually here. The directory row showed beds, ICU, ventilators,
        # ED state and trust but never the answer a family rings ahead to ask:
        # is there a specialist on duty tonight. Derived from the same effective
        # duty predicate the directory search uses, so a card and the roster
        # behind it cannot disagree.
        card["doctors"] = _on_duty_summary(db, h)
        cards.append(card)

    # Rank: facilities that can actually take someone right now float to the top,
    # then by trust. A directory sorted purely alphabetically is useless during a
    # search for a free ICU bed.
    def rank_key(c: dict):
        cap = c.get("capacity") or {}
        usable = (cap.get("beds_effective") or 0) + (cap.get("icu_effective") or 0) * 2
        trust = (c.get("trust") or {}).get("score", 0)
        fresh = {"live": 3, "warm": 2, "stale": 1, "cold": 0, "unknown": 0}.get(
            (c.get("freshness_state") or (cap.get("trust_state") or "unknown")), 1
        )
        return (-usable, -trust, -fresh, c["name"])

    for c in cards:
        cap = c.get("capacity") or {}
        c["freshness_state"] = cap.get("trust_state", "unknown")

    cards.sort(key=rank_key)
    return {
        "count": len(cards),
        "surge_active": relaxed,
        "results": cards[:limit],
    }


@router.get("/districts")
def list_districts(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(select(District).order_by(District.name)).scalars().all()
    counts = dict(
        db.execute(
            select(Hospital.district_id, func.count()).group_by(Hospital.district_id)
        ).all()
    )
    return {
        "results": [
            {
                "id": d.id,
                "code": d.code,
                "name": d.name,
                "name_ta": d.name_ta,
                "state": d.state,
                "lat": d.lat,
                "lng": d.lng,
                "population": d.population,
                "hospital_count": counts.get(d.id, 0),
            }
            for d in rows
        ]
    }


@router.get("/specialties")
def list_specialties(db: Session = Depends(get_db)) -> dict:
    """Derived from the directory rather than hardcoded, so a new service line at
    one hospital immediately becomes filterable everywhere."""
    hospitals = db.execute(select(Hospital)).scalars().all()
    counts: dict[str, int] = {}
    for h in hospitals:
        for s in _specialty_list(h):
            counts[s] = counts.get(s, 0) + 1
    doctors = db.execute(select(Doctor.specialty)).scalars().all()
    on_duty: dict[str, int] = {}
    for s in doctors:
        on_duty[s] = on_duty.get(s, 0) + 1
    return {
        "results": [
            {"key": k, "label": k.replace("_", " ").title(), "hospitals": v, "doctors": on_duty.get(k, 0)}
            for k, v in sorted(counts.items())
        ]
    }



def hold_view(db: Session, hold, *, hospital: Hospital) -> dict:
    """Serialize a bed hold for the receiving facility's own dashboard."""
    incident = db.get(Incident, hold.incident_id) if hold.incident_id else None
    ambulance = db.get(Ambulance, incident.assigned_ambulance_id) if incident and incident.assigned_ambulance_id else None

    eta_minutes = None
    distance_km = None
    if incident is not None and ambulance is not None:
        leg = estimate_leg(ambulance.lat, ambulance.lng, hospital.lat, hospital.lng)
        eta_minutes = leg.eta_minutes
        distance_km = leg.road_km

    return {
        "id": hold.id,
        "resource": hold.resource,
        "expires_at": hold.expires_at.isoformat() + "Z",
        "seconds_remaining": max(0, int((hold.expires_at - utcnow()).total_seconds())),
        "incident_id": hold.incident_id,
        "reference": incident.reference if incident else None,
        "urgency": incident.urgency.value if incident else None,
        "category": incident.category.value if incident else None,
        "status": incident.status.value if incident else None,
        "ambulance_call_sign": ambulance.call_sign if ambulance else None,
        "eta_minutes": eta_minutes,
        "distance_km": distance_km,
    }


def _can_see_operational(db: Session, user: User | None, hospital: Hospital) -> bool:
    """Who may see dispatch traffic against a facility.

    A bed hold is an operational fact, not a capacity fact. It names an incident
    reference, an urgency, an inbound unit's call sign and its ETA -- which
    together disclose that a specific emergency is heading to a specific
    hospital right now. The public portal's contract is aggregate capacity, so
    that traffic is staff-only: the receiving facility's own people, dispatch, a
    scoped government analyst, and the platform team.

    The aggregate `holds` count stays public because it is already folded into
    the published availability -- a bed promised to an inbound ambulance is not
    a free bed, and the citizen is entitled to the truthful number without being
    told why it moved.
    """
    if user is None:
        return False
    if user.role in (UserRole.PLATFORM_ADMIN, UserRole.DISPATCHER):
        return True
    if user.role is UserRole.HOSPITAL_ADMIN:
        return user.hospital_id == hospital.id
    if user.role is UserRole.GOV_OFFICIAL:
        # Jurisdiction, not facility: a district officer oversees every facility
        # in their district, which is the scope the analytics matrix gives them.
        return user.district_id is None or user.district_id == hospital.district_id
    return False


@router.get("/{hospital_id}")
def hospital_detail(hospital_id: int, user: OptionalUser, db: Session = Depends(get_db), history_hours: int = 24):
    hospital = db.get(Hospital, hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")

    relaxed = any_surge(db) is not None
    scores = trust_scores(db, [hospital], relaxed=relaxed)
    view = live_store.get(hospital.id)
    holds = hold_counts(db, hospital.id)

    series = capacity_series(db, hospital.id, hours=history_hours)
    return {
        **hospital_card(hospital, view, scores.get(hospital.id)),
        "holds": holds,
        "history": [
            {
                "t": r.recorded_at.isoformat() + "Z",
                "beds": r.beds_available,
                "icu": r.icu_available,
                "vent": r.ventilators_available,
                "ed_waiting": r.ed_waiting,
                "congestion": r.ed_congestion.value,
                "source": r.source.value,
                "quarantined": r.quarantined,
            }
            for r in series
        ],
        # Presence, not just a row from the roster. The `on_duty` returned here
        # is the effective answer -- expiry applied -- so a page that renders it
        # cannot advertise a shift that ended; `roster_flag` is the stored value
        # for the one screen that needs to show the difference.
        "doctors_on_duty": [
            {
                "id": d.id,
                "full_name": d.full_name,
                "specialty": d.specialty,
                "designation": d.designation,
                "department": d.department,
                "shift": d.shift,
                "accepts_emergency": d.accepts_emergency,
                "duty_end": d.duty_end.isoformat() + "Z" if d.duty_end else None,
                "on_duty": lifecycle.duty_state(d) == "on_duty",
                "roster_flag": d.on_duty,
                "duty_state": lifecycle.duty_state(d),
                "minutes_remaining": lifecycle.minutes_until_duty_end(d),
            }
            for d in db.execute(
                select(Doctor).where(Doctor.hospital_id == hospital.id, duty_is_current())
            ).scalars().all()
        ],
        # A hold row is what the receiving ward actually acts on, so it carries
        # everything the ward needs to prepare rather than a foreign key: which
        # case, how urgent, what is coming, and how long until the crew arrives.
        # The earlier shape was {"incident_id": 2}, which is unreadable to a
        # nurse and forced the dashboard to print a database id.
        # Operational dispatch traffic. Present only for staff; absent, not
        # empty, for the public, so a client cannot mistake "you are not allowed
        # to know" for "nothing is inbound".
        **(
            {
                "active_holds": [
                    hold_view(db, h, hospital=hospital)
                    for h in active_holds(db, hospital_id=hospital.id)
                ]
            }
            if _can_see_operational(db, user, hospital)
            else {}
        ),
    }


# --------------------------------------------------------------------------- #
# Onboarding (platform admin)
# --------------------------------------------------------------------------- #


@router.post("", status_code=status.HTTP_201_CREATED)
def create_hospital(
    payload: HospitalCreate,
    request: Request,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    if db.execute(select(Hospital).where(Hospital.slug == payload.slug)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="A facility with that slug already exists")
    if db.get(District, payload.district_id) is None:
        raise HTTPException(status_code=422, detail="Unknown district")

    hospital = Hospital(
        **payload.model_dump(exclude={"specialties"}),
        specialties=",".join(sorted({s.strip().lower().replace(" ", "_") for s in payload.specialties if s.strip()})),
        verification=VerificationStatus.PENDING,
        created_at=utcnow(),
    )
    db.add(hospital)
    db.flush()
    audit.record(
        db,
        action="hospital.onboard",
        entity_type="hospital",
        entity_id=hospital.id,
        summary=f"{hospital.name} submitted for verification ({payload.integration.value})",
        actor=user,
        payload=payload.model_dump(mode="json"),
        ip=request.client.host if request.client else None,
    )
    db.commit()
    return {"id": hospital.id, "slug": hospital.slug, "verification": hospital.verification.value}


@router.post("/{hospital_id}/verification")
async def set_verification(
    hospital_id: int,
    payload: VerificationUpdate,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    hospital = db.get(Hospital, hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    before = hospital.verification.value
    hospital.verification = payload.status
    if payload.status is VerificationStatus.VERIFIED and hospital.onboarding_completed_at is None:
        hospital.onboarding_completed_at = utcnow()
    audit.record(
        db,
        action="hospital.verification",
        entity_type="hospital",
        entity_id=hospital.id,
        summary=f"verification {before} → {payload.status.value}",
        actor=user,
        payload={"note": payload.note},
    )
    db.commit()

    # Verification moves the trust score without moving a single capacity number.
    # Pushing the projection anyway means an open dispatcher console re-renders
    # the badge immediately instead of on its next poll.
    view = live_store.get(hospital.id)
    if view is not None:
        await live_store.broadcast_capacity(view)
    return {"id": hospital.id, "verification": hospital.verification.value}


# --------------------------------------------------------------------------- #
# Ingestion -- the one write path
# --------------------------------------------------------------------------- #


def ingest_capacity(
    db: Session,
    *,
    hospital: Hospital,
    values: dict,
    source: IntegrationMode,
    actor: User | None,
    note: str | None = None,
) -> dict:
    """Shared ingest routine used by the HTTP endpoint, the quick-adjust keypad
    and the connector simulator. Kept as a plain function so those three callers
    cannot drift apart.

    Inputs are normalised here rather than at each call site: quick-adjust reads
    its baseline out of the live projection (plain strings) while the HTTP path
    validates into enums, and letting both reach the ORM unmapped is how a
    type bug becomes a corrupt column.
    """
    values = dict(values)
    values["ed_congestion"] = (
        values["ed_congestion"]
        if isinstance(values["ed_congestion"], EdCongestion)
        else EdCongestion(values["ed_congestion"])
    )
    source = source if isinstance(source, IntegrationMode) else IntegrationMode(source)

    prev = previous_capacity(db, hospital.id)
    verdict = trust_engine.evaluate_ingest(values, prev, hospital)

    record = CapacityRecord(
        hospital_id=hospital.id,
        beds_available=int(values["beds_available"]),
        icu_available=int(values["icu_available"]),
        ventilators_available=int(values["ventilators_available"]),
        ed_congestion=values["ed_congestion"],
        ed_waiting=int(values.get("ed_waiting", 0)),
        blood_units=int(values.get("blood_units", 0)),
        antivenom_vials=int(values.get("antivenom_vials", 0)),
        source=source,
        reported_by=actor.id if actor else None,
        recorded_at=utcnow(),
        trust_state="quarantined" if verdict.quarantined else "live",
        anomaly_flags=json.dumps(verdict.flags),
        quarantined=verdict.quarantined,
    )
    db.add(record)
    db.flush()

    if not verdict.quarantined:
        live_store.put(
            CapacityView(
                hospital_id=hospital.id,
                beds_available=record.beds_available,
                total_beds=hospital.total_beds,
                icu_available=record.icu_available,
                total_icu=hospital.total_icu,
                ventilators_available=record.ventilators_available,
                total_ventilators=hospital.total_ventilators,
                ed_congestion=record.ed_congestion.value,
                ed_waiting=record.ed_waiting,
                blood_units=record.blood_units,
                antivenom_vials=record.antivenom_vials,
                source=source.value,
                recorded_at=record.recorded_at,
                trust_state="live",
                anomaly_flags=[],
                quarantined=False,
                _holds_by_resource=hold_counts(db, hospital.id),
                holds_active=sum(hold_counts(db, hospital.id).values()),
            )
        )

    audit.record(
        db,
        action="capacity.ingest",
        entity_type="hospital",
        entity_id=hospital.id,
        summary=(
            f"{source.value}: {record.beds_available} beds / {record.icu_available} ICU / "
            f"{record.ventilators_available} vent"
            + (" — QUARANTINED" if verdict.quarantined else "")
        ),
        actor=actor,
        payload={
            "before": _record_view(prev),
            "after": _record_view(record),
            "trust": verdict.to_wire(),
            "note": note,
        },
    )
    db.commit()

    # Fan out to the websocket subscribers. This is the single choke point for
    # every capacity write on the platform -- the API connector, the quick-adjust
    # keypad, the full-form push and the simulator all come through here -- and
    # it was the one thing the ingest path never did. The projection was updated
    # in memory, so *polls* were correct, but a hospital dashboard sitting open
    # on a ward terminal only learned about a change when something else
    # happened to publish. Which is to say: the directory was real-time in the
    # database and not in the user's browser.
    #
    # `publish_capacity_soon` rather than an `await` because this function is
    # synchronous and shared with non-HTTP callers; see app/live.py.
    live_store.publish_capacity_soon(hospital.id)

    return {"record": _record_view(record), "trust": verdict.to_wire(), "accepted": not verdict.quarantined}


@router.post("/{hospital_id}/capacity")
def push_capacity(
    hospital_id: int,
    payload: CapacityPush,
    request: Request,
    user: User = Depends(require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Full-form update. Used by API connectors, by platform admins correcting a
    facility, and by hospital staff who want to change several counters at once."""
    hospital = db.get(Hospital, hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    result = ingest_capacity(
        db,
        hospital=hospital,
        values=payload.model_dump(exclude={"source", "note"}),
        source=payload.source or hospital.integration,
        actor=user,
        note=payload.note,
    )
    return result


@router.post("/{hospital_id}/capacity/quick")
def quick_adjust(
    hospital_id: int,
    payload: QuickAdjust,
    user: User = Depends(require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """The '+1 bed freed' path. Applies a signed delta to the current projection
    so ward staff never have to read a number, add one to it, and retype it --
    which is where transcription errors actually come from."""
    hospital = db.get(Hospital, hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    view = live_store.get(hospital.id)
    latest = latest_capacity_map(db, [hospital.id]).get(hospital.id)
    if view is None and latest is None:
        raise HTTPException(status_code=409, detail="No baseline record — submit a full update first")

    base = {
        "beds_available": view.beds_available if view else latest.beds_available,
        "icu_available": view.icu_available if view else latest.icu_available,
        "ventilators_available": view.ventilators_available if view else latest.ventilators_available,
        "ed_congestion": (view.ed_congestion if view else latest.ed_congestion.value),
        "ed_waiting": view.ed_waiting if view else latest.ed_waiting,
        "blood_units": view.blood_units if view else latest.blood_units,
        "antivenom_vials": view.antivenom_vials if view else latest.antivenom_vials,
    }

    changed = {}
    for key, delta in payload.deltas.items():
        if delta == 0:
            continue
        before = int(base.get(key, 0))
        after = max(0, before + delta)
        base[key] = after
        changed[key] = {"from": before, "to": after}

    if payload.ed_waiting_delta is not None:
        base["ed_waiting"] = max(0, int(base["ed_waiting"]) + payload.ed_waiting_delta)
    if payload.ed_congestion is not None:
        base["ed_congestion"] = payload.ed_congestion

    if not changed and payload.ed_congestion is None and payload.ed_waiting_delta is None:
        raise HTTPException(status_code=422, detail="No change submitted")

    result = ingest_capacity(
        db,
        hospital=hospital,
        values=base,
        source=hospital.integration,
        actor=user,
        note="quick adjust: " + ", ".join(f"{k} {v['from']}→{v['to']}" for k, v in changed.items()),
    )
    result["changed"] = changed
    return result
