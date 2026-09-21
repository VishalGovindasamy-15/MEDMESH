"""108 console, ambulance crews and hospital notification.

The flow this file owns:

    incident created  →  ranked shortlist (matching engine)
                      →  operator confirms a facility
                      →  bed hold placed, ambulance + hospital both alerted
                      →  crew moves through en_route / at_scene / transporting
                      →  hospital acknowledges handover, hold consumed

Re-route is a first-class operation rather than a cancel-and-redo, because the
report is right that "ICU just filled up while we were driving" is a normal
event, not an exception.
"""

from __future__ import annotations

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status as http_status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..live import live_store
from ..models import (
    Ambulance,
    AmbulanceStatus,
    BedHold,
    District,
    Doctor,
    HoldStatus,
    Hospital,
    Incident,
    IncidentStatus,
    SurgeEvent,
    User,
    UserRole,
    utcnow,
)
from ..repository import (
    active_holds,
    active_surge,
    ambulance_for_user,
    any_surge,
    hold_counts,
    latest_capacity_map,
    open_incidents,
    sync_hold_projection,
    trust_scores,
)
from ..schemas import (
    AmbulanceLocationUpdate,
    DispatchRequest,
    HoldRequest,
    IncidentCreate,
    StatusUpdate,
)
from ..security import CurrentUser, OptionalUser, require_roles
from ..services import audit, notifications as notify, references, reservations, routing, triage
from ..services.geo import compass_point, estimate_leg, route_polyline
from ..services.matching import (
    AMBULANCE_CAPABILITY_LABELS,
    CATCHMENT_MINUTES,
    rank_candidates,
    required_ambulance_capabilities,
    snapshot,
    traffic_note,
)

router = APIRouter(tags=["dispatch"])


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

PATIENT_STATE_LABELS = {
    "alert": "Conscious and alert",
    "drowsy": "Conscious but drowsy",
    "unconscious_breathing": "Unconscious, breathing",
    "unconscious_not_breathing": "Unconscious, not breathing",
    "unknown": "Not reported",
}

MECHANISM_LABELS = {
    "none": "Not applicable",
    "two_wheeler": "Two-wheeler",
    "car": "Car",
    "pedestrian": "Pedestrian struck",
    "heavy_vehicle": "Heavy vehicle",
    "fall_low": "Fall from standing",
    "fall_height": "Fall from height",
    "assault": "Assault",
    "machinery": "Machinery",
    "other": "Other",
}

HAZARD_LABELS = {
    "none": "None reported",
    "traffic_active": "Live traffic",
    "fire": "Fire",
    "chemical": "Chemical exposure",
    "electrical": "Electrical",
    "confined_space": "Confined space",
}

INCIDENT_LABELS = {
    "road_accident": "Road traffic accident",
    "cardiac": "Cardiac emergency",
    "stroke": "Suspected stroke",
    "obstetric": "Obstetric emergency",
    "paediatric": "Paediatric emergency",
    "burns": "Burns",
    "trauma_fall": "Fall / blunt trauma",
    "snakebite": "Snakebite envenomation",
    "poisoning": "Poisoning / overdose",
    "respiratory": "Respiratory distress",
    "dialysis": "Dialysis (emergency)",
    "other": "Other",
}

AMBULANCE_LABELS = {
    "bls": "Basic life support",
    "als": "Advanced life support",
    "nicu": "Neonatal transport",
    "mortuary": "Mortuary transfer",
}


def _next_reference(db: Session) -> str:
    """Human-quotable incident reference, guaranteed unused.

    Call-takers read these aloud on the radio, so they are short and free of
    characters that get misheard. The allocation -- including the check that the
    reference is actually free -- lives in services.references, which the ingest
    simulator shares; see that module for why an unchecked draw is not
    acceptable here.
    """
    return references.allocate_reference(db)


def incident_out(incident: Incident, *, db: Session, detail: bool = False) -> dict:
    hospital = db.get(Hospital, incident.assigned_hospital_id) if incident.assigned_hospital_id else None
    ambulance = db.get(Ambulance, incident.assigned_ambulance_id) if incident.assigned_ambulance_id else None
    district = db.get(District, incident.district_id)

    payload = {
        "id": incident.id,
        "reference": incident.reference,
        "category": incident.category.value,
        "category_label": INCIDENT_LABELS.get(incident.category.value, incident.category.value),
        "urgency": incident.urgency.value,
        "lat": incident.lat,
        "lng": incident.lng,
        "landmark": incident.landmark,
        "district_id": incident.district_id,
        "district_name": district.name if district else None,
        "scene": {
            "patient_state": incident.patient_state.value,
            "patient_state_label": PATIENT_STATE_LABELS.get(
                incident.patient_state.value, incident.patient_state.value
            ),
            "mechanism": incident.mechanism.value,
            "mechanism_label": MECHANISM_LABELS.get(incident.mechanism.value, incident.mechanism.value),
            "bleeding": incident.bleeding.value,
            "hazard": incident.hazard.value,
            "hazard_label": HAZARD_LABELS.get(incident.hazard.value, incident.hazard.value),
            "observations": [
                o for o in (incident.observations or "").split(",") if o
            ],
            "casualty_count": incident.casualty_count,
            "trapped": incident.trapped,
            "bystander_cpr": incident.bystander_cpr,
        },
        "requires": {
            "icu": incident.requires_icu,
            "ventilator": incident.requires_ventilator,
            "blood": incident.requires_blood,
            "specialty": incident.required_specialty,
        },
        "status": incident.status.value,
        "created_at": incident.created_at.isoformat() + "Z",
        "dispatched_at": incident.dispatched_at.isoformat() + "Z" if incident.dispatched_at else None,
        "arrived_at": incident.arrived_at.isoformat() + "Z" if incident.arrived_at else None,
        "elapsed_seconds": int((utcnow() - incident.created_at).total_seconds()),
        "assigned_hospital": (
            {
                "id": hospital.id,
                "name": hospital.name,
                "short_name": hospital.short_name,
                "phone": hospital.emergency_phone or hospital.contact_phone,
                "lat": hospital.lat,
                "lng": hospital.lng,
                "address": hospital.address,
            }
            if hospital
            else None
        ),
        "assigned_ambulance": (
            {
                "id": ambulance.id,
                "call_sign": ambulance.call_sign,
                "operator": ambulance.operator_name,
                "capability": ambulance.capabilities,
                "capability_label": AMBULANCE_LABELS.get(ambulance.capabilities, ambulance.capabilities),
                "status": ambulance.status.value,
                "lat": ambulance.lat,
                "lng": ambulance.lng,
            }
            if ambulance
            else None
        ),
        "active_holds": [
            {
                "id": h.id,
                "resource": h.resource,
                "expires_at": h.expires_at.isoformat() + "Z",
                "seconds_remaining": max(0, int((h.expires_at - utcnow()).total_seconds())),
            }
            for h in db.execute(
                select(BedHold).where(BedHold.incident_id == incident.id, BedHold.status == HoldStatus.ACTIVE)
            ).scalars().all()
        ],
    }
    if detail and incident.match_snapshot:
        try:
            payload["match_snapshot"] = json.loads(incident.match_snapshot)
        except json.JSONDecodeError:
            payload["match_snapshot"] = None
    return payload


class Shortlist(list):
    """The ranked candidates, plus how they were ranked.

    A plain `list` subclass so every existing caller -- iteration, slicing,
    `json.dumps`, `snapshot_from_list` -- keeps working untouched, while the
    provenance of the distances rides along on `.routing` for the surfaces that
    are obliged to disclose it.
    """

    routing: dict = {}
    legs: dict = {}


def build_shortlist(
    db: Session,
    *,
    incident: Incident,
    limit: int = 8,
    include_ineligible: bool = True,
) -> Shortlist:
    hospitals = list(db.execute(select(Hospital)).scalars().all())
    surge = any_surge(db)
    scores = trust_scores(db, hospitals, relaxed=bool(surge))
    rows = latest_capacity_map(db, [h.id for h in hospitals])
    views = {h.id: live_store.get(h.id) for h in hospitals}

    # Doctor rosters for the specialist step of the matching chain. Fetched in
    # one query rather than per hospital, because this runs on every shortlist
    # rebuild and the console refreshes every thirty seconds.
    rosters: dict[int, list[Doctor]] = {}
    for d in db.execute(select(Doctor)).scalars().all():
        rosters.setdefault(d.hospital_id, []).append(d)

    # --- road legs, resolved before anything is ranked -------------------- #
    #
    # This is the ordering that makes the engine's answer defensible. The
    # straight-line geometry is used once, as a free prefilter, to drop the
    # facilities that cannot possibly be in range; everything that survives is
    # then resolved against the road network, and the ranking is scored on the
    # resulting drive times.
    #
    # Doing it the other way round -- rank geometrically, then draw a road route
    # on the map -- produces a shortlist whose order the map then contradicts,
    # which is worse than having no map at all: the dispatcher sees the road
    # distance and the ranking disagree, and stops trusting both.
    catchment = CATCHMENT_MINUTES.get(incident.urgency.value, 120.0)
    prefilter = routing.prefilter_km(catchment, ceiling_km=settings.routing_prefilter_km)
    legs = routing.legs_for_rows(
        (incident.lat, incident.lng),
        [(h.id, h.lat, h.lng) for h in hospitals],
        max_road_distance_km=prefilter,
    )

    ranked = rank_candidates(
        hospitals,
        incident=incident,
        latest=rows,
        views=views,
        trust_scores=scores,
        origin_lat=incident.lat,
        origin_lng=incident.lng,
        surge=surge,
        doctors_by_hospital=rosters,
        legs=legs,
    )
    eligible = [c for c in ranked if c.eligible]
    out = Shortlist(c.to_wire() for c in eligible[:limit])
    if include_ineligible:
        out += [c.to_wire() for c in ranked if not c.eligible][:4]
    out.routing = routing.summarise(legs.values())
    out.routing["provider"] = routing.provider_name()
    out.routing["prefilter_km"] = round(
        routing.prefilter_km(catchment, ceiling_km=settings.routing_prefilter_km), 1
    )
    out.routing["catchment_minutes"] = catchment
    out.legs = legs
    return out


# --------------------------------------------------------------------------- #
# Incidents — dispatcher console
# --------------------------------------------------------------------------- #


@router.get("/incidents")
def list_incidents(
    user: CurrentUser,
    db: Session = Depends(get_db),
    status_filter: str | None = Query(default=None, alias="status"),
    district_id: int | None = None,
    limit: int = Query(default=60, ge=1, le=200),
):
    if user.role not in (UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL, UserRole.HOSPITAL_ADMIN):
        raise HTTPException(status_code=403, detail="Not permitted to view the incident queue")

    items = open_incidents(db, district_id=district_id)
    if status_filter:
        wanted = {s.strip() for s in status_filter.split(",")}
        items = [i for i in items if i.status.value in wanted]
    return {"count": len(items), "results": [incident_out(i, db=db) for i in items[:limit]]}


@router.post("/incidents", status_code=http_status.HTTP_201_CREATED)
async def create_incident(
    payload: IncidentCreate,
    user: User = Depends(require_roles(UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Called by the console as the 108 call is still being taken, per §6.6.
    Creating the incident immediately kicks off matching so the shortlist is
    already on screen by the time the operator finishes typing the landmark."""
    # Derive the resource requirement from the structured scene assessment, then
    # let any explicit operator instruction win. The operator is looking at the
    # patient or talking to someone who is; the derivation is a starting point.
    needs = triage.derive(
        category=payload.category,
        patient_state=payload.patient_state,
        mechanism=payload.mechanism,
        bleeding=payload.bleeding,
        hazard=payload.hazard,
        observations=list(payload.observations),
        trapped=payload.trapped,
        bystander_cpr=payload.bystander_cpr,
        casualty_count=payload.casualty_count,
    )

    def _resolve(explicit: bool | None, derived: bool) -> bool:
        return derived if explicit is None else explicit

    incident = Incident(
        reference=_next_reference(db),
        category=payload.category,
        urgency=payload.urgency,
        lat=payload.lat,
        lng=payload.lng,
        landmark=payload.landmark,
        district_id=payload.district_id,
        patient_state=payload.patient_state,
        mechanism=payload.mechanism,
        bleeding=payload.bleeding,
        hazard=payload.hazard,
        casualty_count=payload.casualty_count,
        trapped=payload.trapped,
        bystander_cpr=payload.bystander_cpr,
        observations=",".join(o.value for o in payload.observations),
        required_specialty=payload.required_specialty or needs.specialty,
        requires_icu=_resolve(payload.requires_icu, needs.requires_icu),
        requires_ventilator=_resolve(payload.requires_ventilator, needs.requires_ventilator),
        requires_blood=_resolve(payload.requires_blood, needs.requires_blood),
        created_by=user.id,
        created_at=utcnow(),
    )
    db.add(incident)
    db.flush()

    shortlist = build_shortlist(db, incident=incident, limit=8)
    incident.match_snapshot = snapshot_from_list(shortlist)

    audit.record(
        db,
        action="incident.create",
        entity_type="incident",
        entity_id=incident.id,
        summary=f"{incident.reference} {INCIDENT_LABELS.get(payload.category.value)} at {payload.landmark}",
        actor=user,
        payload=payload.model_dump(mode="json"),
    )
    db.commit()

    await live_store.publish(
        "incident.created",
        {
            "id": incident.id,
            "reference": incident.reference,
            "category": incident.category.value,
            "urgency": incident.urgency.value,
            "landmark": incident.landmark,
            "district_id": incident.district_id,
            "at": incident.created_at.isoformat() + "Z",
        },
    )
    return {
        **incident_out(incident, db=db),
        "shortlist": list(shortlist),
        "routing": shortlist.routing,
        "derivation": {
            "rationale": needs.rationale,
            "scene_advisories": needs.scene_advisories,
            "derived_specialty": needs.specialty,
        },
    }


def snapshot_from_list(shortlist: list[dict]) -> str:
    return json.dumps(
        {"top": shortlist[:12], "excluded": [c for c in shortlist if not c["eligible"]][:8]},
        default=str,
        separators=(",", ":"),
    )[:20000]


@router.get("/incidents/{incident_id}")
def get_incident(incident_id: int, user: CurrentUser, db: Session = Depends(get_db)):
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return incident_out(incident, db=db, detail=True)


@router.get("/incidents/{incident_id}/shortlist")
def get_shortlist(
    incident_id: int,
    user: CurrentUser,
    db: Session = Depends(get_db),
    limit: int = Query(default=8, ge=1, le=20),
    refresh: bool = True,
):
    """Recomputed live unless the caller explicitly wants the dispatch-time
    snapshot (which is what the audit view uses)."""
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    if not refresh and incident.match_snapshot:
        return {"snapshot": json.loads(incident.match_snapshot), "live": False}
    shortlist = build_shortlist(db, incident=incident, limit=limit)
    return {"results": list(shortlist), "routing": shortlist.routing, "live": True}


@router.post("/incidents/{incident_id}/dispatch")
async def dispatch(
    incident_id: int,
    payload: DispatchRequest,
    user: User = Depends(require_roles(UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    if incident.status in (IncidentStatus.CLOSED, IncidentStatus.CANCELLED):
        raise HTTPException(status_code=409, detail=f"Incident already {incident.status.value}")

    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")

    # Recompute the shortlist at the moment of commit. Between the operator
    # reading the list and pressing the button, a facility may have filled up --
    # committing on stale matching is exactly the failure this platform exists
    # to prevent.
    shortlist = build_shortlist(db, incident=incident, limit=20, include_ineligible=True)
    chosen = next((c for c in shortlist if c["hospital_id"] == payload.hospital_id), None)

    if chosen is not None and not chosen["eligible"] and not payload.override_reason:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail={
                "message": "Selected facility no longer meets the incident requirements",
                "blockers": chosen["blockers"],
                "hint": "Choose an alternative or supply override_reason to proceed against the engine's advice",
            },
        )

    ambulance: Ambulance | None = None
    if payload.ambulance_id:
        ambulance = db.get(Ambulance, payload.ambulance_id)
        if ambulance is None:
            raise HTTPException(status_code=404, detail="Ambulance not found")
        crew_match: dict = {"matched": True, "warnings": [], "capability": None}
    else:
        ambulance, crew_match = _select_ambulance(db, incident)
        if ambulance is None:
            raise HTTPException(
                status_code=http_status.HTTP_409_CONFLICT,
                detail="No ambulance available in this district — assign a private operator or hold the incident",
            )

    # --- bed hold -------------------------------------------------------
    # Goes through the reservation service, which takes a per-facility critical
    # section and counts from committed rows rather than from the live
    # projection. See app/services/reservations.py for why.
    hold: BedHold | None = None
    if payload.hold_resource:
        try:
            hold = reservations.reserve(
                db,
                hospital_id=hospital.id,
                resource=payload.hold_resource,
                incident_id=incident.id,
                actor_id=user.id,
                ttl_seconds=payload.hold_seconds,
            )
        except reservations.ReservationError as exc:
            raise HTTPException(
                status_code=http_status.HTTP_409_CONFLICT, detail=exc.detail
            ) from exc

    incident.assigned_hospital_id = hospital.id
    incident.assigned_ambulance_id = ambulance.id
    incident.status = IncidentStatus.DISPATCHED
    incident.dispatched_at = utcnow()
    incident.match_snapshot = snapshot_from_list(shortlist)
    ambulance.status = AmbulanceStatus.ASSIGNED

    db.flush()

    audit.record(
        db,
        action="incident.dispatch",
        entity_type="incident",
        entity_id=incident.id,
        summary=(
            f"{incident.reference} → {hospital.short_name} via {ambulance.call_sign}"
            + (f" ({payload.hold_resource} hold)" if hold else "")
            + (f" [override: {payload.override_reason}]" if payload.override_reason else "")
        ),
        actor=user,
        payload={
            "hospital_id": hospital.id,
            "ambulance_id": ambulance.id,
            "engine_score": chosen["score"] if chosen else None,
            "engine_rank_reasons": chosen["reasons"] if chosen else None,
            "engine_warnings": chosen["warnings"] if chosen else None,
            "crew_capability": crew_match.get("capability"),
            "crew_capability_matched": crew_match.get("matched"),
            "crew_warnings": crew_match.get("warnings"),
            "override_reason": payload.override_reason,
        },
    )
    db.commit()

    # Scene leg for the crew: road-resolved where routing is available, because
    # this is the number the driver is given as an arrival estimate.
    crew_leg = unit_leg if (unit_leg := crew_match.get("leg")) else None
    if crew_leg is None:
        crew_leg = estimate_leg(ambulance.lat, ambulance.lng, incident.lat, incident.lng)
    leg = crew_leg
    await live_store.publish(
        "incident.dispatched",
        {
            "incident_id": incident.id,
            "reference": incident.reference,
            "hospital_id": hospital.id,
            "hospital_name": hospital.name,
            "ambulance_call_sign": ambulance.call_sign,
            "eta_to_scene_minutes": leg.eta_minutes,
            "distance_provider": leg.provider,
        },
    )
    # The ward's durable inbox, not only the socket. A prep alert that exists
    # only as a websocket frame is invisible to staff who were not looking at
    # the screen when it arrived, which is most of them.
    notify.notify_inbound(
        db,
        incident,
        hospital=hospital,
        eta_minutes=leg.eta_minutes,
        hold_resource=payload.hold_resource,
    )
    db.commit()

    await live_store.publish(
        "hospital.inbound",
        {
            "hospital_id": hospital.id,
            "incident_id": incident.id,
            "reference": incident.reference,
            "category": incident.category.value,
            "urgency": incident.urgency.value,
            "eta_minutes": leg.eta_minutes,
            "needs": {
                "icu": incident.requires_icu,
                "ventilator": incident.requires_ventilator,
                "blood": incident.requires_blood,
                "specialty": incident.required_specialty,
            },
            "hold_resource": payload.hold_resource,
            "ambulance_capability": crew_match.get("capability"),
            "crew_warnings": crew_match.get("warnings", []),
        },
    )

    return {
        **incident_out(incident, db=db),
        "hold": (
            {
                "id": hold.id,
                "resource": hold.resource,
                "expires_at": hold.expires_at.isoformat() + "Z",
                "seconds": int((hold.expires_at - utcnow()).total_seconds()),
            }
            if hold
            else None
        ),
        "engine_notes": {
            "rank": next((i + 1 for i, c in enumerate(shortlist) if c["hospital_id"] == hospital.id), None),
            "score": chosen["score"] if chosen else None,
            "reasons": chosen["reasons"] if chosen else [],
            "warnings": chosen["warnings"] if chosen else [],
            "overrode_engine": bool(chosen and not chosen["eligible"]),
            "specialist_on_duty": chosen.get("specialist_note") if chosen else None,
            "specialists": chosen.get("on_duty_specialists") if chosen else None,
        },
        "crew_notes": crew_match,
    }


def _select_ambulance(
    db: Session,
    incident: Incident,
) -> tuple[Ambulance | None, dict]:
    """Pick a crew by capability first, distance second.

    The previous version took the nearest available unit regardless of what it
    carried, which is wrong in the cases that matter most: a BLS van is not an
    acceptable answer to a P1 cardiac arrest when an ALS unit exists, even if
    the BLS van is two minutes closer. It also runs the other way -- sending an
    ALS unit to a stable transfer takes the advanced unit out of the fleet for
    forty minutes for no clinical reason.

    So the preference list for the incident is walked from best to worst; the
    first capability the fleet can actually satisfy is used, and among those
    units the nearest wins. If nothing carries what the incident wants, the
    nearest unit of any capability is returned with a warning rather than
    leaving the patient with no ambulance at all.
    """
    available = list(
        db.execute(
            select(Ambulance).where(Ambulance.status == AmbulanceStatus.AVAILABLE)
        ).scalars().all()
    )
    if not available:
        return None, {"capability": None, "matched": False, "warnings": ["No unit available"]}

    wanted = required_ambulance_capabilities(incident)

    # Crew selection is the same class of decision as facility selection -- who
    # do we send, and how long until they arrive -- so it is resolved on roads
    # for the same reason. A unit across a river is not the nearest unit.
    unit_legs = routing.legs_for_rows(
        (incident.lat, incident.lng),
        [(a.id, a.lat, a.lng) for a in available],
    )
    by_distance = sorted(available, key=lambda a: unit_legs[a.id].road_km)

    for index, capability in enumerate(wanted):
        capable = [a for a in by_distance if capability in _capability_set(a)]
        if capable:
            chosen = capable[0]
            warnings = []
            if index > 0:
                warnings.append(
                    f"No {AMBULANCE_CAPABILITY_LABELS.get(wanted[0], wanted[0])} unit free — "
                    f"dispatching {AMBULANCE_CAPABILITY_LABELS.get(capability, capability)} instead"
                )
            return chosen, {
                "capability": capability,
                "capability_label": AMBULANCE_CAPABILITY_LABELS.get(capability, capability),
                "required": wanted,
                "matched": index == 0,
                "warnings": warnings,
                "leg": unit_legs[chosen.id],
            }

    # Nothing in the fleet carries the preferred capability.
    chosen = by_distance[0]
    return chosen, {
        "capability": _first_capability(chosen),
        "capability_label": AMBULANCE_CAPABILITY_LABELS.get(_first_capability(chosen), "Basic life support"),
        "required": wanted,
        "matched": False,
        "leg": unit_legs[chosen.id],
        "warnings": [
            f"No unit with {AMBULANCE_CAPABILITY_LABELS.get(wanted[0], wanted[0])} available — "
            f"nearest unit ({chosen.call_sign}) dispatched; flag to the receiving facility"
        ],
    }


def _capability_set(unit: Ambulance) -> set[str]:
    return {c.strip().lower() for c in (unit.capabilities or "").split(",") if c.strip()}


def _first_capability(unit: Ambulance) -> str:
    caps = _capability_set(unit)
    # Report the highest level the unit carries, not the first string in the
    # column, so a unit listed "bls, als" is not described as a BLS van.
    for level in ("nicu", "als", "bls", "mortuary"):
        if level in caps:
            return level
    return "bls"


@router.post("/incidents/{incident_id}/reroute")
async def reroute(
    incident_id: int,
    payload: DispatchRequest,
    user: User = Depends(require_roles(UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN, UserRole.DRIVER)),
    db: Session = Depends(get_db),
):
    """Mid-transport destination change. Releases the old hold so the abandoned
    bed goes back into the pool immediately instead of sitting locked for the
    rest of its 15-minute window."""
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")

    previous = db.get(Hospital, incident.assigned_hospital_id) if incident.assigned_hospital_id else None
    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    if previous and previous.id == hospital.id:
        raise HTTPException(status_code=409, detail="Incident is already assigned to this facility")

    # Give the old bed back first, so a re-route onto the same facility the
    # incident just left is not refused for lack of capacity it is itself
    # holding. Both steps go through the reservation service.
    released = reservations.release_for_incident(
        db, incident.id, reason=f"re-routed to {hospital.short_name}"
    )

    incident.assigned_hospital_id = hospital.id
    incident.status = IncidentStatus.EN_ROUTE

    new_hold = None
    hold_warning = None
    if payload.hold_resource:
        try:
            new_hold = reservations.reserve(
                db,
                hospital_id=hospital.id,
                resource=payload.hold_resource,
                incident_id=incident.id,
                actor_id=user.id,
                ttl_seconds=payload.hold_seconds,
            )
        except reservations.ReservationError as exc:
            # A re-route is a decision made in a moving ambulance. Refusing the
            # whole re-route because the new destination has no bed to hold
            # would leave the crew driving to the old hospital. So the move goes
            # through and the missing hold is reported loudly instead.
            hold_warning = exc.detail

    db.flush()

    audit.record(
        db,
        action="incident.reroute",
        entity_type="incident",
        entity_id=incident.id,
        summary=f"{incident.reference} re-routed {previous.short_name if previous else '—'} → {hospital.short_name}",
        actor=user,
        payload={
            "reason": payload.override_reason,
            "released_holds": [h.resource for h in released],
            "new_hold": new_hold.resource if new_hold else None,
            "hold_warning": hold_warning,
        },
    )
    db.commit()

    await live_store.publish(
        "incident.rerouted",
        {
            "incident_id": incident.id,
            "hospital_id": hospital.id,
            "hospital_name": hospital.name,
            "released_holds": released,
        },
    )
    return {
        **incident_out(incident, db=db),
        "released_holds": [h.resource for h in released],
        "new_hold": (
            {
                "id": new_hold.id,
                "resource": new_hold.resource,
                "seconds": int((new_hold.expires_at - utcnow()).total_seconds()),
            }
            if new_hold
            else None
        ),
        "hold_warning": hold_warning,
    }


@router.post("/incidents/{incident_id}/status")
async def update_status(
    incident_id: int,
    payload: StatusUpdate,
    user: User = Depends(require_roles(UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN, UserRole.DRIVER)),
    db: Session = Depends(get_db),
):
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")

    prev_status = incident.status
    now = utcnow()
    incident.status = IncidentStatus(payload.status)

    if payload.status == "arrived":
        incident.arrived_at = now
    elif payload.status == "handed_over":
        incident.closed_at = now
        reservations.consume_for_incident(db, incident.id, reason="patient handed over")
    elif payload.status in ("closed", "cancelled"):
        incident.closed_at = now
        reservations.release_for_incident(db, incident.id, reason=f"incident {payload.status}")

    ambulance = db.get(Ambulance, incident.assigned_ambulance_id) if incident.assigned_ambulance_id else None
    if ambulance:
        ambulance.status = {
            "en_route": AmbulanceStatus.EN_ROUTE,
            "at_scene": AmbulanceStatus.AT_SCENE,
            "transporting": AmbulanceStatus.TRANSPORTING,
            "arrived": AmbulanceStatus.AT_SCENE,
            "handed_over": AmbulanceStatus.AVAILABLE,
            "closed": AmbulanceStatus.AVAILABLE,
            "cancelled": AmbulanceStatus.AVAILABLE,
        }[payload.status]

    db.flush()

    audit.record(
        db,
        action="incident.status",
        entity_type="incident",
        entity_id=incident.id,
        summary=f"{incident.reference} {prev_status.value} → {payload.status}",
        actor=user,
        payload={"note": payload.note},
    )
    db.commit()

    await live_store.publish(
        "incident.status",
        {"incident_id": incident.id, "reference": incident.reference, "status": payload.status},
    )
    return incident_out(incident, db=db)


# --------------------------------------------------------------------------- #
# Bed holds
# --------------------------------------------------------------------------- #


@router.post("/hospitals/{hospital_id}/hold")
async def place_hold(
    hospital_id: int,
    payload: HoldRequest,
    user: User = Depends(require_roles(UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    hospital = db.get(Hospital, hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    try:
        hold = reservations.reserve(
            db,
            hospital_id=hospital.id,
            resource=payload.resource,
            incident_id=payload.incident_id,
            actor_id=user.id,
            ttl_seconds=payload.seconds,
        )
    except reservations.ReservationError as exc:
        raise HTTPException(status_code=409, detail=exc.detail) from exc

    audit.record(
        db,
        action="hold.place",
        entity_type="hospital",
        entity_id=hospital.id,
        summary=(
            f"{hold.resource} held at {hospital.short_name} until "
            f"{hold.expires_at.strftime('%H:%M:%S')}Z"
        ),
        actor=user,
        payload={"incident_id": hold.incident_id, "hold_id": hold.id},
    )
    db.commit()
    await live_store.publish("hold.placed", {"hospital_id": hospital.id, "resource": payload.resource})
    return {
        "id": hold.id,
        "resource": hold.resource,
        "expires_at": hold.expires_at.isoformat() + "Z",
        "seconds_remaining": int((hold.expires_at - utcnow()).total_seconds()),
    }


@router.delete("/holds/{hold_id}")
async def release_hold(
    hold_id: int,
    user: User = Depends(require_roles(UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    hold = db.get(BedHold, hold_id)
    if hold is None:
        raise HTTPException(status_code=404, detail="Hold not found")
    if hold.status is not HoldStatus.ACTIVE:
        raise HTTPException(status_code=409, detail=f"Hold is already {hold.status.value}")

    reservations.release(db, hold, reason="released manually")
    audit.record(
        db,
        action="hold.release",
        entity_type="hospital",
        entity_id=hold.hospital_id,
        summary=f"{hold.resource} hold released",
        actor=user,
    )
    db.commit()
    await live_store.publish("hold.released", {"hospital_id": hold.hospital_id, "resource": hold.resource})
    return {"id": hold.id, "status": hold.status.value}


@router.get("/holds")
def list_holds(
    user: CurrentUser,
    db: Session = Depends(get_db),
    hospital_id: int | None = None,
):
    if user.role is UserRole.HOSPITAL_ADMIN:
        hospital_id = user.hospital_id
    holds = active_holds(db, hospital_id=hospital_id)
    return {
        "results": [
            {
                "id": h.id,
                "hospital_id": h.hospital_id,
                "hospital_name": (db.get(Hospital, h.hospital_id).short_name if db.get(Hospital, h.hospital_id) else ""),
                "resource": h.resource,
                "incident_id": h.incident_id,
                "incident_reference": (db.get(Incident, h.incident_id).reference if h.incident_id else None),
                "seconds_remaining": max(0, int((h.expires_at - utcnow()).total_seconds())),
                "expires_at": h.expires_at.isoformat() + "Z",
            }
            for h in holds
        ]
    }


# --------------------------------------------------------------------------- #
# Ambulance crew endpoints (driver app)
# --------------------------------------------------------------------------- #


@router.get("/crew/assignment")
def crew_assignment(user: CurrentUser, db: Session = Depends(get_db)):
    """Everything the driver app needs in one call, because the app is used at a
    roadside with one bar of signal and a request round trip is expensive."""
    ambulance = ambulance_for_user(db, user)
    if ambulance is None:
        # Fall back to the most recent incident in the crew's district so the
        # demo account works without a linked vehicle row.
        incident = db.execute(
            select(Incident)
            .where(Incident.assigned_ambulance_id.is_not(None), Incident.status.in_(
                (IncidentStatus.DISPATCHED, IncidentStatus.EN_ROUTE, IncidentStatus.ARRIVED)
            ))
            .order_by(Incident.dispatched_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if incident is None:
            return {"assignment": None, "ambulance": None, "message": "No active assignment"}
        return _assignment_payload(db, incident, db.get(Ambulance, incident.assigned_ambulance_id))

    incident = db.execute(
        select(Incident)
        .where(
            Incident.assigned_ambulance_id == ambulance.id,
            Incident.status.in_(
                (
                    IncidentStatus.DISPATCHED,
                    IncidentStatus.EN_ROUTE,
                    IncidentStatus.ARRIVED,
                )
            ),
        )
        .order_by(Incident.dispatched_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if incident is None:
        return {"assignment": None, "ambulance": _ambulance_out(ambulance), "message": "Standing by"}
    return _assignment_payload(db, incident, ambulance)


def _ambulance_out(a: Ambulance) -> dict:
    return {
        "id": a.id,
        "call_sign": a.call_sign,
        "registration": a.registration,
        "operator_type": a.operator_type,
        "operator_name": a.operator_name,
        "capability": a.capabilities,
        "capability_label": AMBULANCE_LABELS.get(a.capabilities, a.capabilities),
        "status": a.status.value,
        "lat": a.lat,
        "lng": a.lng,
    }


def _assignment_payload(db: Session, incident: Incident, ambulance: Ambulance | None) -> dict:
    hospital = db.get(Hospital, incident.assigned_hospital_id) if incident.assigned_hospital_id else None
    view = live_store.get(hospital.id) if hospital else None

    destination = None
    route = None
    if hospital:
        origin_lat = ambulance.lat if ambulance else incident.lat
        origin_lng = ambulance.lng if ambulance else incident.lng
        # Destination leg for the crew app. Road-resolved: this is what the
        # driver and the receiving ward both act on, and it is the number the
        # two-way prep alert quotes to the ward.
        leg = routing.resolve((origin_lat, origin_lng), [(hospital.lat, hospital.lng)])[0]
        destination = {
            "id": hospital.id,
            "name": hospital.name,
            "short_name": hospital.short_name,
            "address": hospital.address,
            "phone": hospital.emergency_phone or hospital.contact_phone,
            "lat": hospital.lat,
            "lng": hospital.lng,
            "distance_km": leg.road_km,
            "eta_minutes": leg.eta_minutes,
            "distance_provider": leg.provider,
            "traffic_aware": leg.traffic_aware,
            "distance_label": leg.label,
            "bearing_deg": leg.bearing_deg,
            "bearing_label": compass_point(leg.bearing_deg),
            "traffic_note": traffic_note(leg),
            "capabilities": {
                "trauma_centre": hospital.has_trauma_centre,
                "blood_bank": hospital.has_blood_bank,
                "cath_lab": hospital.has_cath_lab,
                "burn_unit": hospital.has_burn_unit,
            },
        }
        route = {
            "origin": {"lat": origin_lat, "lng": origin_lng},
            "points": route_polyline(origin_lat, origin_lng, hospital.lat, hospital.lng, seed=incident.id),
            # The crew must know which numbers are live and which are cached.
            "provider": "medmesh-estimate",
            "generated_at": utcnow().isoformat() + "Z",
        }

    scene_leg = None
    if ambulance and incident.lat:
        scene_leg = estimate_leg(ambulance.lat, ambulance.lng, incident.lat, incident.lng)

    return {
        "ambulance": _ambulance_out(ambulance) if ambulance else None,
        "assignment": {
            **incident_out(incident, db=db),
            "scene_eta_minutes": scene_leg.eta_minutes if scene_leg else None,
            "scene_distance_km": scene_leg.road_km if scene_leg else None,
        },
        "destination": destination,
        "destination_capacity": view.to_wire() if view else None,
        "route": route,
        "alternatives": _alternatives(db, incident, limit=3),
    }


def _alternatives(db: Session, incident: Incident, limit: int = 3) -> list[dict]:
    """Pre-computed re-route options. The crew should never have to wait for a
    round trip to discover the next-best facility."""
    shortlist = build_shortlist(db, incident=incident, limit=limit + 3, include_ineligible=False)
    return [c for c in shortlist if c["hospital_id"] != incident.assigned_hospital_id][:limit]


@router.post("/crew/location")
def update_location(
    payload: AmbulanceLocationUpdate,
    user: User = Depends(require_roles(UserRole.DRIVER)),
    db: Session = Depends(get_db),
):
    ambulance = ambulance_for_user(db, user)
    if ambulance is None:
        raise HTTPException(status_code=404, detail="No vehicle linked to this account")
    ambulance.lat = payload.lat
    ambulance.lng = payload.lng
    ambulance.updated_at = utcnow()
    db.commit()
    return {"ok": True, "at": ambulance.updated_at.isoformat() + "Z"}


@router.get("/ambulances")
def list_ambulances(
    user: CurrentUser,
    db: Session = Depends(get_db),
    operator_type: str | None = Query(default=None, pattern="^(108|private)$"),
):
    """Fleet view for the dispatcher console and the district dashboard."""
    stmt = select(Ambulance)
    if operator_type:
        stmt = stmt.where(Ambulance.operator_type == operator_type)
    fleet = list(db.execute(stmt.order_by(Ambulance.call_sign)).scalars().all())
    return {
        "count": len(fleet),
        "available": sum(1 for a in fleet if a.status is AmbulanceStatus.AVAILABLE),
        "results": [_ambulance_out(a) for a in fleet],
    }
