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
    IntegrationMode,
    Ambulance,
    AmbulanceStatus,
    BedHold,
    District,
    Doctor,
    HoldStatus,
    Hospital,
    Incident,
    IncidentStatus,
    NotificationKind,
    SurgeEvent,
    User,
    UserRole,
    utcnow,
)
from ..repository import (
    active_holds,
    active_surge,
    visible_district_ids,
    ambulance_for_user,
    any_surge,
    hold_counts,
    latest_capacity_map,
    open_incidents,
    sync_hold_projection,
    trust_scores,
)
from ..schemas import (
    AmbulanceCrewAssign,
    FacilityResponse,
    AmbulanceCreate,
    AmbulanceLocationUpdate,
    AmbulanceStatusUpdate,
    AmbulanceUpdate,
    DispatchRequest,
    HoldRequest,
    IncidentCreate,
    StatusUpdate,
)
from ..security import CurrentUser, OptionalUser, require_roles
from ..services import audit, lifecycle, notifications as notify, references, reservations, routing, triage
from ..services.geo import compass_point, estimate_leg, route_polyline
from ..services.matching import (
    AMBULANCE_CAPABILITY_LABELS,
    AMBULANCE_STATUS_LABELS,
    CATCHMENT_MINUTES,
    ESCALATION_LABELS,
    escalation_of,
    escalation_tiers,
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


def _assert_crew_owns(db: Session, user: User, incident: Incident) -> Ambulance:
    """A driver may only act on the incident their own vehicle is assigned to.

    Without this, every crew action was authorised by role alone: any account
    with the driver role could advance or re-route *any* incident whose id it
    knew. Incident ids are small integers and the queue screen is not the only
    place they appear, so that is a realistic path, not a theoretical one -- and
    the actions available include marking a patient handed over and diverting an
    ambulance, so the consequences are clinical.

    Dispatchers and platform administrators are deliberately exempt: both are
    expected to be able to act on any incident, and that is what their role
    means.
    """
    if user.role in (UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN):
        return db.get(Ambulance, incident.assigned_ambulance_id) if incident.assigned_ambulance_id else None  # type: ignore[return-value]

    ambulance = ambulance_for_user(db, user)
    if ambulance is None:
        raise HTTPException(
            status_code=403,
            detail="No ambulance is linked to this account, so it cannot act on a trip",
        )
    if incident.assigned_ambulance_id != ambulance.id:
        # 404 rather than 403 for the mismatch: telling a driver that incident
        # 812 exists but is not theirs still confirms it exists. A crew has no
        # operational need to enumerate other crews' work.
        raise HTTPException(status_code=404, detail="Incident not found")
    return ambulance


def _incident_visible_to(db: Session, user: User, incident: Incident) -> bool:
    """Whether this user's operational scope includes this incident.

    The RBAC matrix gives each role a jurisdiction, and reading an incident is
    itself an operation: a live incident carries a scene location, a patient
    category, an urgency and a destination. Scope is applied on read, not only
    on write.
    """
    if user.role is UserRole.PLATFORM_ADMIN:
        return True
    if user.role is UserRole.DISPATCHER:
        # A dispatcher with no district set is the state control room; one with
        # a district sees their own.
        return user.district_id is None or incident.district_id == user.district_id
    if user.role is UserRole.DRIVER:
        ambulance = ambulance_for_user(db, user)
        return bool(ambulance and incident.assigned_ambulance_id == ambulance.id)
    if user.role is UserRole.HOSPITAL_ADMIN:
        return user.hospital_id is not None and incident.assigned_hospital_id == user.hospital_id
    if user.role is UserRole.GOV_OFFICIAL:
        # Oversight, not operations: a district officer may read incidents in
        # their district for analysis, which the incidents CSV also permits.
        return user.district_id is None or incident.district_id == user.district_id
    return False


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
        "taluk": incident.taluk,
        "declined_hospital_ids": declined_for(incident),
        "destination_withdrawn": bool(declined_for(incident)) and incident.assigned_hospital_id is None,
        "location_source": getattr(incident.location_source, "value", incident.location_source),
        # Whether the coordinate can be trusted at face value. The console
        # renders a warning strip from this, and the receiving facility sees it
        # too -- a hospital that is told to expect a patient "somewhere in
        # Erode district" plans differently from one that has a street.
        "location_approximate": getattr(incident.location_source, "value", None) == "district",
        "district_id": incident.district_id,
        "district_name": district.name if district else None,
        # The ids as well as the expanded objects. A client that only needs to
        # compare "is this the facility I am looking at" should not have to
        # null-check a nested object to do it, and every client was doing
        # exactly that.
        "assigned_hospital_id": incident.assigned_hospital_id,
        "assigned_ambulance_id": incident.assigned_ambulance_id,
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
                # `.get` with a fallback rather than a direct lookup: this table is
        # keyed by the lifecycle's own enum, and any status that is not in it --
        # a deprecated spelling on a row written before the migration, or a
        # value added to the model and not to the label table -- would raise a
        # KeyError inside the serialiser and take down the *entire* incident
        # list with a 500. One unlabelled row must not blank the queue.
        "status_label": lifecycle.STATUS_LABELS.get(
            incident.status, incident.status.value.replace("_", " ").capitalize()
        ),
        "is_open": incident.status not in lifecycle.TERMINAL_STATES,
        "patient_aboard": incident.status in lifecycle.PATIENT_ABOARD,
        "created_at": incident.created_at.isoformat() + "Z",
        # Every stage of the trip, so both the crew screen and the analytics can
        # tell "on scene" from "loaded" from "moving" instead of inferring them.
        "dispatched_at": incident.dispatched_at.isoformat() + "Z" if incident.dispatched_at else None,
        "en_route_at": incident.en_route_at.isoformat() + "Z" if incident.en_route_at else None,
        "arrived_at": incident.arrived_at.isoformat() + "Z" if incident.arrived_at else None,
        "scene_arrived_at": incident.scene_arrived_at.isoformat() + "Z" if incident.scene_arrived_at else None,
        "patient_onboard_at": incident.patient_onboard_at.isoformat() + "Z" if incident.patient_onboard_at else None,
        "departed_scene_at": incident.departed_scene_at.isoformat() + "Z" if incident.departed_scene_at else None,
        "hospital_arrived_at": incident.hospital_arrived_at.isoformat() + "Z" if incident.hospital_arrived_at else None,
        "handed_over_at": incident.handed_over_at.isoformat() + "Z" if incident.handed_over_at else None,
        # The ward's answer, so the dispatcher knows whether anyone has read the
        # prep alert -- the difference between sending a second unit and waiting.
        "facility_acknowledged_at": incident.facility_acknowledged_at.isoformat() + "Z"
        if incident.facility_acknowledged_at
        else None,
        "facility_declined_at": incident.facility_declined_at.isoformat() + "Z"
        if incident.facility_declined_at
        else None,
        "facility_decline_reason": incident.facility_decline_reason,
        # What the crew's next button should say, derived server-side so the app
        # and the API can never disagree about the trip's position.
        "next_actions": [
            {
                "status": st.value,
                "label": lifecycle.CREW_ACTION_LABELS.get(st, lifecycle.STATUS_LABELS[st]),
                "timestamp": lifecycle.TIMESTAMP_COLUMN.get(st),
            }
            for st in lifecycle.allowed_from(incident.status)
            if st not in lifecycle.TERMINAL_STATES or st is IncidentStatus.HANDED_OVER
        ],
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


def declined_for(incident: Incident) -> list[int]:
    """Facility ids that have already refused this incident."""
    return [int(x) for x in (incident.declined_hospital_ids or "").split(",") if x.strip().isdigit()]


def build_shortlist(
    db: Session,
    *,
    incident: Incident,
    limit: int = 8,
    include_ineligible: bool = True,
) -> Shortlist:
    hospitals = list(db.execute(select(Hospital)).scalars().all())

    # Facilities that have already said no are removed before ranking rather
    # than flagged after it. "Not eligible" means the patient cannot go there;
    # "declined" means the ward has told us so, and the two deserve distinct
    # treatment: the first is a data point, the second is a door that is shut.
    refused = set(declined_for(incident))
    if refused:
        hospitals = [h for h in hospitals if h.id not in refused]
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

    # A district dispatcher sees their own district's queue. Previously the
    # console passed no district and the endpoint accepted none, so every
    # dispatcher saw the whole state.
    scoped = visible_district_ids(db, user)
    if scoped is not None and user.role is not UserRole.PLATFORM_ADMIN:
        allowed = set(scoped)
        if district_id is not None:
            allowed &= {district_id}
        items = [i for i in open_incidents(db, district_id=district_id) if i.district_id in allowed]
    else:
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
        taluk=payload.taluk,
        location_source=payload.location_source,
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
    if not _incident_visible_to(db, user, incident):
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
    if not _incident_visible_to(db, user, incident):
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
        crew_match = _validate_manual_ambulance(db, incident, ambulance)
        # A unit that is not free cannot be sent at all: the override reason
        # covers clinical disagreement with the engine, not double-booking a
        # vehicle that is already on another job.
        if crew_match["blockers"] and not payload.override_reason:
            raise HTTPException(
                status_code=http_status.HTTP_409_CONFLICT,
                detail={
                    "message": f"{ambulance.call_sign} cannot be assigned",
                    "blockers": crew_match["blockers"],
                    "hint": "Choose an available unit, or supply override_reason to require it anyway",
                },
            )
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

    # --- escalation ladder (#25) ----------------------------------------
    # Search order is explicit and reported: the incident's own district first,
    # then bordering districts as mutual aid, then the rest of the state. The
    # previous version simply took the nearest capable unit anywhere, which
    # produced the right answer for the patient most of the time but had no way
    # to say *why* a unit from another district was being committed, and no way
    # for a control room to insist on local-first. Capability still outranks
    # distance -- a nearby BLS van is still not an acceptable answer to a
    # cardiac arrest -- so the ladder is applied within each capability step
    # rather than before it.
    tiers = escalation_tiers(db, home_district_id=incident.district_id)
    tier_of = {d: "local" for d in tiers["local"]["district_ids"]}
    tier_of.update({d: "neighbouring" for d in tiers["neighbouring"]["district_ids"]})
    tier_of.update({d: "statewide" for d in tiers["statewide"]["district_ids"]})
    tier_rank = {"local": 0, "neighbouring": 1, "statewide": 2}

    def rank(unit: Ambulance) -> tuple:
        """Escalation tier, then whether anybody is driving it, then distance.

        The middle term is new and it matters operationally: a fleet office
        links crew accounts to vehicles, and until this existed the engine could
        not tell a unit with a paramedic on shift from an empty vehicle parked
        at a depot. It is a *tie-break* rather than a filter because a district
        with one uncrewed unit and no other free capacity is still better served
        by sending it than by refusing -- but where there is a choice, the unit
        somebody is actually sitting in goes first.
        """
        return (
            tier_rank.get(tier_of.get(unit.base_district_id, "local"), 0),
            0 if unit.driver_id is not None else 1,
            unit_legs[unit.id].road_km,
        )


    for index, capability in enumerate(wanted):
        capable = [a for a in by_distance if capability in _capability_set(a)]
        if capable:
            chosen = min(capable, key=rank)
            tier = tier_of.get(chosen.base_district_id, "local")
            warnings = []
            if index > 0:
                warnings.append(
                    f"No {AMBULANCE_CAPABILITY_LABELS.get(wanted[0], wanted[0])} unit free — "
                    f"dispatching {AMBULANCE_CAPABILITY_LABELS.get(capability, capability)} instead"
                )
            if chosen.driver_id is None:
                warnings.append(
                    f"{chosen.call_sign} has no crew account linked — confirm a driver is on "
                    "shift for it before it leaves"
                )
            if tier == "neighbouring":
                warnings.append(
                    f"Mutual aid: no local {AMBULANCE_CAPABILITY_LABELS.get(capability, capability)} unit free — "
                    f"{chosen.call_sign} dispatched from a neighbouring district"
                )
            elif tier == "statewide":
                warnings.append(
                    f"Statewide escalation: {chosen.call_sign} dispatched from outside "
                    f"{tiers['local']['label']} and its neighbours — confirm the receiving facility accepts the delay"
                )
            return chosen, {
                "capability": capability,
                "capability_label": AMBULANCE_CAPABILITY_LABELS.get(capability, capability),
                "required": wanted,
                "matched": index == 0,
                "escalation": tier,
                "escalation_label": ESCALATION_LABELS[tier],
                "home_district_id": incident.district_id,
                "warnings": warnings,
                "leg": unit_legs[chosen.id],
            }

    # Nothing in the fleet carries the preferred capability.
    chosen = min(by_distance, key=rank)
    tier = tier_of.get(chosen.base_district_id, "local")
    return chosen, {
        "capability": _first_capability(chosen),
        "capability_label": AMBULANCE_CAPABILITY_LABELS.get(_first_capability(chosen), "Basic life support"),
        "required": wanted,
        "matched": False,
        "escalation": tier,
        "escalation_label": ESCALATION_LABELS[tier],
        "home_district_id": incident.district_id,
        "leg": unit_legs[chosen.id],
        "warnings": [
            f"No unit with {AMBULANCE_CAPABILITY_LABELS.get(wanted[0], wanted[0])} available — "
            f"nearest unit ({chosen.call_sign}) dispatched; flag to the receiving facility"
        ],
    }


def _validate_manual_ambulance(db: Session, incident: Incident, ambulance: Ambulance) -> dict:
    """Check a hand-picked unit the same way the engine checks its own choice.

    The dispatcher could previously name any ambulance id and it was accepted
    unconditionally, with the crew-match recorded as a clean `{"matched": True}`
    regardless of what the vehicle carried or whether it was even free. That puts
    the override path *below* the automatic path in rigour, which is the wrong
    way round: a human choosing deliberately is exactly when the system should
    show them what they are choosing, so they can be accountable for it rather
    than surprised by it.
    """
    warnings: list[str] = []
    blockers: list[str] = []

    if ambulance.status is not AmbulanceStatus.AVAILABLE:
        blockers.append(
            f"{ambulance.call_sign} is {AMBULANCE_STATUS_LABELS.get(ambulance.status.value, ambulance.status.value).lower()}"
        )

    wanted = required_ambulance_capabilities(incident)
    carried = _capability_set(ambulance)
    matched = any(c in carried for c in wanted)
    if not matched:
        warnings.append(
            f"{ambulance.call_sign} carries {AMBULANCE_CAPABILITY_LABELS.get(_first_capability(ambulance), 'no recorded capability')} — "
            f"the incident asks for {AMBULANCE_CAPABILITY_LABELS.get(wanted[0], wanted[0])}"
        )

    if ambulance.driver_id is None:
        warnings.append(f"{ambulance.call_sign} has no driver linked — the crew screen will refuse the trip")

    tiers = escalation_tiers(db, home_district_id=incident.district_id)
    tier = escalation_of(ambulance.base_district_id, tiers)
    if tier == "neighbouring":
        warnings.append(f"Mutual aid: {ambulance.call_sign} is based in a neighbouring district")
    elif tier == "statewide":
        warnings.append(
            f"Statewide escalation: {ambulance.call_sign} is based outside the incident district and its neighbours"
        )

    return {
        "capability": _first_capability(ambulance),
        "capability_label": AMBULANCE_CAPABILITY_LABELS.get(_first_capability(ambulance), "Basic life support"),
        "required": wanted,
        "matched": matched,
        "manual": True,
        "blockers": blockers,
        "escalation": tier,
        "escalation_label": ESCALATION_LABELS[tier],
        "home_district_id": incident.district_id,
        "warnings": warnings,
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
    _assert_crew_owns(db, user, incident)

    previous = db.get(Hospital, incident.assigned_hospital_id) if incident.assigned_hospital_id else None
    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    if previous and previous.id == hospital.id:
        raise HTTPException(status_code=409, detail="Incident is already assigned to this facility")

    # A facility that has already refused this patient is refused again, unless
    # the dispatcher says why. Re-offering a closed door is how a ward ends up
    # receiving two alerts for the same ambulance and stops trusting the queue --
    # but the override is kept, because a ward that declined an hour ago for a
    # full ICU may well have one now, and the person on the phone knows that
    # better than the record does.
    if hospital.id in declined_for(incident) and not payload.override_reason:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    f"{hospital.short_name} has already declined this incident. "
                    "Re-route there anyway only if the ward has since confirmed it can take them."
                ),
                "declined_hospital_ids": declined_for(incident),
                "override": "send override_reason to proceed",
            },
        )

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
    _assert_crew_owns(db, user, incident)

    previous = incident.status
    target = lifecycle.normalise(payload.status)

    # The transition table, not the caller, decides what is legal. Before this,
    # the endpoint wrote whatever status it was sent: a crew could jump straight
    # from en route to handed over, or move backwards, and the only trace was a
    # timeline with holes in it. Rejecting the illegal moves is also what makes
    # the timestamps below trustworthy, since each one is written exactly once.
    if target is previous:
        # Idempotent repeat, and it has to be handled *before* the transition
        # table. A device that retries after a dropped response is resending the
        # state it is already in, which the table correctly rejects as a no-op
        # move -- so checking legality first turned a harmless retry into a 409
        # and left the crew looking at an error for an action that had worked.
        return incident_out(incident, db=db)

    try:
        target = lifecycle.assert_transition(previous, target)
    except lifecycle.TransitionError as exc:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail={
                "message": str(exc),
                "current": previous.value,
                "requested": target.value,
                "allowed": [st.value for st in exc.allowed],
                "allowed_labels": [lifecycle.STATUS_LABELS[st] for st in exc.allowed],
            },
        ) from exc

    now = utcnow()
    incident.status = target
    lifecycle.apply_timestamps(incident, target, now)

    if target is IncidentStatus.HANDED_OVER:
        reservations.consume_for_incident(db, incident.id, reason="patient handed over")
    elif target in (IncidentStatus.CLOSED, IncidentStatus.CANCELLED):
        reservations.release_for_incident(db, incident.id, reason=f"incident {target.value}")

    ambulance = db.get(Ambulance, incident.assigned_ambulance_id) if incident.assigned_ambulance_id else None
    if ambulance:
        ambulance.status = lifecycle.AMBULANCE_FOR_STATUS[target]
        # The crew's own position at the moment they report a state change. This
        # is the only position report the app can make without a background
        # location permission, so it is worth taking rather than discarding --
        # otherwise the dispatch map shows a vehicle wherever it was when the
        # trip began.
        if payload.lat is not None and payload.lng is not None:
            ambulance.lat = payload.lat
            ambulance.lng = payload.lng

    db.flush()

    audit.record(
        db,
        action="incident.status",
        entity_type="incident",
        entity_id=incident.id,
        summary=f"{incident.reference} {previous.value} → {target.value}",
        actor=user,
        payload={"note": payload.note, "previous": previous.value},
    )
    db.commit()

    await live_store.publish(
        "incident.status",
        {
            "incident_id": incident.id,
            "reference": incident.reference,
            "status": target.value,
            "status_label": lifecycle.STATUS_LABELS[target],
            "hospital_id": incident.assigned_hospital_id,
            "patient_aboard": target in lifecycle.PATIENT_ABOARD,
        },
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
    # Holds are dispatch traffic and are scoped like it. A hospital admin sees
    # their own facility's; a dispatcher sees their district's; the platform team
    # sees everything. A driver sees only what concerns their own vehicle, and
    # anyone else is refused rather than served a filtered list -- the list is
    # the sensitive part, not the filtering.
    if user.role is UserRole.HOSPITAL_ADMIN:
        if user.hospital_id is None:
            raise HTTPException(status_code=403, detail="Account is not linked to a facility")
        hospital_id = user.hospital_id
    elif user.role is UserRole.DRIVER:
        ambulance = ambulance_for_user(db, user)
        if ambulance is None:
            return {"results": []}
        own = db.execute(
            select(Incident.id).where(Incident.assigned_ambulance_id == ambulance.id)
        ).scalars().all()
        own_ids = set(own)
        holds = [h for h in active_holds(db) if h.incident_id in own_ids]
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
    elif user.role is UserRole.DISPATCHER:
        district_ids = visible_district_ids(db, user)
        holds = active_holds(db, hospital_id=hospital_id)
        if district_ids is not None:
            allowed = set(district_ids)
            holds = [
                h
                for h in holds
                if (db.get(Hospital, h.hospital_id) is not None and db.get(Hospital, h.hospital_id).district_id in allowed)
            ]
    elif user.role is UserRole.PLATFORM_ADMIN:
        holds = active_holds(db, hospital_id=hospital_id)
    else:
        raise HTTPException(status_code=403, detail="Not permitted to view bed holds")
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
        # No vehicle, so no assignment -- and that is the whole answer.
        #
        # This used to fall back to "the most recent active incident", with a
        # comment claiming it was scoped to the crew's district. The query did no
        # such thing: it returned the newest live incident anywhere in the state.
        # A driver with no linked vehicle would therefore be shown a stranger's
        # emergency -- an incident reference, a patient category, a scene
        # location and a destination hospital -- and could act on it, because the
        # crew actions are routed through the incident id the screen hands them.
        #
        # Inventing an assignment for a driver is never the right failure mode.
        # The correct one is to say so and stop, which also makes a provisioning
        # mistake visible immediately instead of hidden behind plausible-looking
        # demo data. Linking a vehicle is now a first-class admin action; see
        # /ambulances in the fleet router.
        return {
            "assignment": None,
            "ambulance": None,
            "message": "No ambulance linked to this account",
            "action_required": "An administrator must link your account to a vehicle before you can receive assignments.",
        }

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
        return {"assignment": None, "ambulance": _ambulance_out(ambulance, db=db), "message": "Standing by"}
    return _assignment_payload(db, incident, ambulance)


def _ambulance_out(a: Ambulance, *, db: Session | None = None) -> dict:
    capabilities = [c.strip() for c in (a.capabilities or "").split(",") if c.strip()]
    payload = {
        "id": a.id,
        "call_sign": a.call_sign,
        "registration": a.registration,
        "operator_type": a.operator_type,
        "operator_name": a.operator_name,
        "capability": a.capabilities,
        "capabilities": capabilities,
        "capability_label": AMBULANCE_LABELS.get(a.capabilities, a.capabilities),
        "capability_labels": [AMBULANCE_CAPABILITY_LABELS.get(c, c) for c in capabilities],
        "status": a.status.value,
        "status_label": AMBULANCE_STATUS_LABELS.get(a.status.value, a.status.value),
        "lat": a.lat,
        "lng": a.lng,
        "base_district_id": a.base_district_id,
        "driver_user_id": a.driver_id,
        "updated_at": a.updated_at.isoformat() + "Z" if a.updated_at else None,
    }
    if db is not None:
        district = db.get(District, a.base_district_id)
        payload["base_district_name"] = district.name if district else None
        driver = db.get(User, a.driver_id) if a.driver_id else None
        # Naming the crew matters: "no driver linked" is the single most common
        # provisioning mistake on this platform, and it is invisible unless the
        # fleet table says so next to the unit.
        payload["driver"] = (
            {"id": driver.id, "full_name": driver.full_name, "email": driver.email, "phone": driver.phone}
            if driver
            else None
        )
        payload["crew_state"] = "linked" if driver else "unlinked"
    return payload


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
        "ambulance": _ambulance_out(ambulance, db=db) if ambulance else None,
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
    district_id: int | None = None,
    scope: str | None = Query(default=None, pattern="^(local|neighbouring|statewide)$"),
):
    """Fleet view for the dispatcher console and the district dashboard.

    Reading the fleet is an operational act. The list is a live map of where
    every emergency vehicle in the state is and what each one carries, which is
    not something a citizen account has any use for -- so this is scoped to the
    roles that run the fleet rather than to "anyone authenticated". A driver sees
    their own vehicle and nothing else, which is what their own screen needs and
    all it should have.
    """
    if user.role is UserRole.DRIVER:
        own = ambulance_for_user(db, user)
        return {
            "count": 1 if own else 0,
            "available": 1 if own and own.status is AmbulanceStatus.AVAILABLE else 0,
            "results": [_ambulance_out(own, db=db)] if own else [],
        }

    if user.role not in (
        UserRole.DISPATCHER,
        UserRole.PLATFORM_ADMIN,
        UserRole.GOV_OFFICIAL,
        UserRole.HOSPITAL_ADMIN,
    ):
        raise HTTPException(status_code=403, detail="Not permitted to view the fleet")

    stmt = select(Ambulance)
    if operator_type:
        stmt = stmt.where(Ambulance.operator_type == operator_type)

    # District scoping (#24). A district dispatcher was previously shown the
    # whole state's fleet while the console framed it as their area, which makes
    # the coverage number meaningless and invites a dispatcher to commit a unit
    # from three districts away without noticing. The escalation ladder (#25)
    # is the deliberate way to reach outside the district; the default view is
    # not.
    district_ids = visible_district_ids(db, user)
    allowed_ids: set[int] | None = None
    if district_ids is not None:
        allowed_ids = set(district_ids)
    if district_id is not None:
        allowed_ids = {district_id} if allowed_ids is None else allowed_ids & {district_id}

    fleet = list(db.execute(stmt.order_by(Ambulance.call_sign)).scalars().all())
    if allowed_ids is not None and user.role is not UserRole.PLATFORM_ADMIN:
        fleet = [a for a in fleet if a.base_district_id in allowed_ids]

    # Escalation tier, so the console can present the fleet as a ladder rather
    # than one undifferentiated pool. See matching.escalation_tiers().
    from ..services.matching import escalation_tiers

    home = user.district_id
    tiers = escalation_tiers(db, home_district_id=home) if home else None
    if scope and tiers and home:
        wanted = set(tiers[scope]["district_ids"])
        fleet = [a for a in fleet if a.base_district_id in wanted]

    payload = {
        "count": len(fleet),
        "available": sum(1 for a in fleet if a.status is AmbulanceStatus.AVAILABLE),
        "results": [_ambulance_out(a, db=db) for a in fleet],
        "scope": {
            "district_id": user.district_id,
            "applied": allowed_ids is not None,
            "tiers": tiers,
        },
    }
    return payload

# --------------------------------------------------------------------------- #
# Fleet management (§3-§5 audit)
#
# The fleet had no administrative surface whatsoever. Vehicles existed only
# because the seeder created them, and the link between a driver account and a
# vehicle existed only because the seeder set one. In a real deployment the
# question "how do I give this paramedic an ambulance?" has to have an answer
# inside the product, so these endpoints are that answer: create, edit, link a
# crew, stand a unit down.
#
# Authorization is deliberately narrow. Platform administrators own the fleet as
# a whole; a district dispatcher may edit the units based in their own district,
# which is the level a district control room actually operates at. Nobody else
# may change a vehicle at all -- viewing is separate and lives above.
# --------------------------------------------------------------------------- #


def _fleet_admin_scope(db: Session, user: User, district_id: int) -> None:
    """Refuse a fleet edit outside the caller's remit."""
    if user.role is UserRole.PLATFORM_ADMIN:
        return
    if user.role is UserRole.DISPATCHER:
        if user.district_id is None or user.district_id == district_id:
            return
        raise HTTPException(
            status_code=403,
            detail="A district dispatcher may only manage vehicles based in their own district",
        )
    raise HTTPException(status_code=403, detail="Not permitted to manage the fleet")


def _normalise_capabilities(values: list[str] | None) -> str:
    """Capabilities are stored as a comma-joined string; normalise consistently.

    Ordering is fixed rather than preserved so that two vehicles with the same
    equipment compare equal as strings -- which is what the capability matching
    and the fleet table both rely on.
    """
    order = ["als", "bls", "nicu", "mortuary"]
    chosen = {v.strip().lower() for v in (values or []) if v and v.strip()}
    if not chosen:
        chosen = {"bls"}
    return ",".join(c for c in order if c in chosen)


@router.get("/ambulances/drivers")
def list_fleet_drivers(
    user: CurrentUser,
    db: Session = Depends(get_db),
    unassigned_only: bool = False,
):
    """Driver accounts, and which vehicle each one is linked to.

    Exists so the assignment control is a picker over real accounts rather than a
    free-text user id, and so that a broken link -- a driver account with no
    vehicle, or a vehicle with no crew -- is visible on the screen where it can
    be fixed rather than only at the moment a trip fails.
    """
    if user.role not in (UserRole.PLATFORM_ADMIN, UserRole.DISPATCHER):
        raise HTTPException(status_code=403, detail="Not permitted to view crew accounts")

    drivers = list(
        db.execute(
            select(User).where(User.role == UserRole.DRIVER, User.is_active.is_(True)).order_by(User.full_name)
        ).scalars().all()
    )
    links = {
        a.driver_id: a
        for a in db.execute(select(Ambulance).where(Ambulance.driver_id.is_not(None))).scalars().all()
    }

    rows = []
    for d in drivers:
        unit = links.get(d.id)
        if unassigned_only and unit is not None:
            continue
        if user.role is UserRole.DISPATCHER and user.district_id is not None:
            if d.district_id != user.district_id and (unit is None or unit.base_district_id != user.district_id):
                continue
        rows.append(
            {
                "id": d.id,
                "full_name": d.full_name,
                "email": d.email,
                "phone": d.phone,
                "district_id": d.district_id,
                "district_name": (db.get(District, d.district_id).name if d.district_id else None),
                "linked_ambulance": (
                    {
                        "id": unit.id,
                        "call_sign": unit.call_sign,
                        "status": unit.status.value,
                        "base_district_id": unit.base_district_id,
                    }
                    if unit
                    else None
                ),
            }
        )

    unlinked_units = [
        _ambulance_out(a, db=db)
        for a in db.execute(select(Ambulance).where(Ambulance.driver_id.is_(None)).order_by(Ambulance.call_sign))
        .scalars()
        .all()
    ]
    return {
        "count": len(rows),
        "results": rows,
        "crewless_units": unlinked_units,
        "orphan_drivers": sum(1 for r in rows if r["linked_ambulance"] is None),
    }


@router.get("/ambulances/{ambulance_id}")
def ambulance_detail(ambulance_id: int, user: CurrentUser, db: Session = Depends(get_db)):
    if user.role not in (
        UserRole.PLATFORM_ADMIN,
        UserRole.DISPATCHER,
        UserRole.HOSPITAL_ADMIN,
        UserRole.GOV_OFFICIAL,
    ):
        own = ambulance_for_user(db, user) if user.role is UserRole.DRIVER else None
        if own is None or own.id != ambulance_id:
            raise HTTPException(status_code=404, detail="Ambulance not found")
    unit = db.get(Ambulance, ambulance_id)
    if unit is None:
        raise HTTPException(status_code=404, detail="Ambulance not found")
    payload = _ambulance_out(unit, db=db)
    live = db.execute(
        select(Incident)
        .where(Incident.assigned_ambulance_id == unit.id)
        .order_by(Incident.created_at.desc())
        .limit(5)
    ).scalars().all()
    payload["recent_incidents"] = [
        {
            "id": i.id,
            "reference": i.reference,
            "status": i.status.value,
            "created_at": i.created_at.isoformat() + "Z",
        }
        for i in live
    ]
    return payload


@router.post("/ambulances", status_code=http_status.HTTP_201_CREATED)
def create_ambulance(payload: AmbulanceCreate, user: CurrentUser, db: Session = Depends(get_db)):
    """Add a vehicle to the fleet. Dispatching into the pilot's own district."""
    _fleet_admin_scope(db, user, payload.base_district_id)

    if db.get(District, payload.base_district_id) is None:
        raise HTTPException(status_code=404, detail="District not found")
    if db.execute(select(Ambulance).where(Ambulance.call_sign == payload.call_sign)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Call sign {payload.call_sign} is already in use")

    # Default the position to the district's own centre rather than leaving the
    # vehicle without coordinates. A unit at the exact centre of its district is
    # a known approximation and the dispatcher can correct it; a unit at
    # (0, 0) is the Gulf of Guinea and would silently wreck every distance
    # calculation it took part in.
    district = db.get(District, payload.base_district_id)
    unit = Ambulance(
        call_sign=payload.call_sign,
        registration=payload.registration,
        operator_type=payload.operator_type,
        operator_name=payload.operator_name,
        base_district_id=payload.base_district_id,
        capabilities=_normalise_capabilities(payload.capabilities),
        status=AmbulanceStatus(payload.status),
        lat=payload.lat if payload.lat is not None else district.lat,
        lng=payload.lng if payload.lng is not None else district.lng,
    )
    db.add(unit)
    db.flush()
    audit.record(
        db,
        action="fleet.create",
        entity_type="ambulance",
        entity_id=unit.id,
        summary=f"{unit.call_sign} added to the fleet ({unit.capabilities},{unit.operator_type})",
        actor=user,
    )
    db.commit()
    return _ambulance_out(unit, db=db)


@router.patch("/ambulances/{ambulance_id}")
def update_ambulance(
    ambulance_id: int,
    payload: AmbulanceUpdate,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Edit a vehicle. Only the fields present in the body are touched."""
    unit = db.get(Ambulance, ambulance_id)
    if unit is None:
        raise HTTPException(status_code=404, detail="Ambulance not found")
    _fleet_admin_scope(db, user, payload.base_district_id or unit.base_district_id)

    changes: list[str] = []
    data = payload.model_dump(exclude_unset=True)

    if "call_sign" in data and data["call_sign"] != unit.call_sign:
        clash = db.execute(select(Ambulance).where(Ambulance.call_sign == data["call_sign"])).scalar_one_or_none()
        if clash is not None and clash.id != unit.id:
            raise HTTPException(status_code=409, detail=f"Call sign {data['call_sign']} is already in use")
        changes.append(f"call sign {unit.call_sign} -> {data['call_sign']}")
        unit.call_sign = data["call_sign"]

    if "base_district_id" in data and data["base_district_id"] != unit.base_district_id:
        if db.get(District, data["base_district_id"]) is None:
            raise HTTPException(status_code=404, detail="District not found")
        _fleet_admin_scope(db, user, data["base_district_id"])
        old = db.get(District, unit.base_district_id)
        new = db.get(District, data["base_district_id"])
        changes.append(f"base {old.name if old else unit.base_district_id} -> {new.name if new else data['base_district_id']}")
        unit.base_district_id = data["base_district_id"]

    if "capabilities" in data:
        normalised = _normalise_capabilities(data["capabilities"])
        if normalised != unit.capabilities:
            changes.append(f"capability {unit.capabilities} -> {normalised}")
            unit.capabilities = normalised

    for field in ("registration", "operator_type", "operator_name", "lat", "lng"):
        if field in data and data[field] is not None and getattr(unit, field) != data[field]:
            changes.append(f"{field} {getattr(unit, field)} -> {data[field]}")
            setattr(unit, field, data[field])

    if changes:
        audit.record(
            db,
            action="fleet.update",
            entity_type="ambulance",
            entity_id=unit.id,
            summary=f"{unit.call_sign}: " + "; ".join(changes),
            actor=user,
        )
    db.commit()
    return _ambulance_out(unit, db=db)


@router.post("/ambulances/{ambulance_id}/crew")
def assign_ambulance_crew(
    ambulance_id: int,
    payload: AmbulanceCrewAssign,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Link a driver account to this vehicle, or unlink it.

    The one-driver-one-vehicle rule is enforced here rather than only in the
    schema, so that the common case -- moving a paramedic to a new vehicle --
    does the obviously right thing instead of failing on a constraint. The
    previous vehicle is released in the same transaction, and both halves of the
    move are written to the audit log, because "who was driving what" is a
    question that gets asked after an incident and needs an answer with a
    timestamp on it.

    A crew may not be reassigned while their current vehicle is on a live trip:
    that would leave an incident pointing at a unit whose driver is looking at a
    different assignment. Stand the trip down or hand it over first.
    """
    unit = db.get(Ambulance, ambulance_id)
    if unit is None:
        raise HTTPException(status_code=404, detail="Ambulance not found")
    _fleet_admin_scope(db, user, unit.base_district_id)

    if payload.driver_user_id is None:
        if unit.driver_id is None:
            return _ambulance_out(unit, db=db)
        previous = db.get(User, unit.driver_id)
        unit.driver_id = None
        audit.record(
            db,
            action="fleet.crew_unlink",
            entity_type="ambulance",
            entity_id=unit.id,
            summary=f"{previous.full_name if previous else unit.driver_id} released from {unit.call_sign}"
            + (f" — {payload.reason}" if payload.reason else ""),
            actor=user,
        )
        db.commit()
        return _ambulance_out(unit, db=db)

    driver = db.get(User, payload.driver_user_id)
    if driver is None:
        raise HTTPException(status_code=404, detail="Driver account not found")
    if driver.role is not UserRole.DRIVER:
        raise HTTPException(
            status_code=409,
            detail=f"{driver.full_name} holds the {driver.role.value.replace('_', ' ')} role, not driver",
        )
    if not driver.is_active:
        raise HTTPException(status_code=409, detail=f"{driver.full_name}'s account is disabled")

    if unit.driver_id == driver.id:
        return _ambulance_out(unit, db=db)

    # Release whatever else this driver holds, so the unique index is never the
    # thing that reports the conflict.
    held = [
        a
        for a in db.execute(select(Ambulance).where(Ambulance.driver_id == driver.id)).scalars().all()
        if a.id != unit.id
    ]
    for other in held:
        if other.status in (AmbulanceStatus.ASSIGNED, AmbulanceStatus.EN_ROUTE, AmbulanceStatus.AT_SCENE, AmbulanceStatus.TRANSPORTING):
            raise HTTPException(
                status_code=409,
                detail=f"{driver.full_name} is crew on {other.call_sign}, which is on a live trip — "
                "close that trip before reassigning them",
            )
        other.driver_id = None
        audit.record(
            db,
            action="fleet.crew_unlink",
            entity_type="ambulance",
            entity_id=other.id,
            summary=f"released from {other.call_sign} during reassignment to {unit.call_sign}",
            actor=user,
        )

    if unit.driver_id is not None:
        displaced = db.get(User, unit.driver_id)
        audit.record(
            db,
            action="fleet.crew_unlink",
            entity_type="ambulance",
            entity_id=unit.id,
            summary=f"{displaced.full_name if displaced else unit.driver_id} released from {unit.call_sign}",
            actor=user,
        )

    unit.driver_id = driver.id
    audit.record(
        db,
        action="fleet.crew_link",
        entity_type="ambulance",
        entity_id=unit.id,
        summary=f"{driver.full_name} linked to {unit.call_sign}" + (f" — {payload.reason}" if payload.reason else ""),
        actor=user,
    )
    db.commit()
    return _ambulance_out(unit, db=db)


@router.post("/ambulances/{ambulance_id}/status")
def set_ambulance_status(
    ambulance_id: int,
    payload: AmbulanceStatusUpdate,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    """Stand a unit down, or return it to service.

    Only the two states a human decides are accepted here. The other statuses --
    en route, at scene, transporting -- are consequences of an incident's
    lifecycle and are written by the crew actions, so allowing them to be set
    directly would let the fleet diverge from the incidents it is serving. That
    divergence is exactly how a unit ends up "available" while carrying a
    patient.
    """
    unit = db.get(Ambulance, ambulance_id)
    if unit is None:
        raise HTTPException(status_code=404, detail="Ambulance not found")
    _fleet_admin_scope(db, user, unit.base_district_id)

    if unit.status in (AmbulanceStatus.ASSIGNED, AmbulanceStatus.EN_ROUTE, AmbulanceStatus.AT_SCENE, AmbulanceStatus.TRANSPORTING):
        raise HTTPException(
            status_code=409,
            detail=f"{unit.call_sign} is on a live trip ({AMBULANCE_STATUS_LABELS.get(unit.status.value, unit.status.value).lower()}) — "
            "the crew must close the trip before the unit can be stood down",
        )

    previous = unit.status
    unit.status = AmbulanceStatus(payload.status)
    audit.record(
        db,
        action="fleet.status",
        entity_type="ambulance",
        entity_id=unit.id,
        summary=f"{unit.call_sign}: {previous.value} -> {unit.status.value}" + (f" — {payload.reason}" if payload.reason else ""),
        actor=user,
    )
    db.commit()
    return _ambulance_out(unit, db=db)

# --------------------------------------------------------------------------- #
# Receiving facility: accept or decline (§20 audit)
# --------------------------------------------------------------------------- #

#: Labels for the decline reasons, shared with the dashboard so the operator and
#: the dispatcher read the same words for the same decision.
DECLINE_REASONS = {
    "no_bed": "No bed available",
    "no_icu": "No ICU bed available",
    "no_ventilator": "No ventilator available",
    "no_specialist": "Required specialist not on site",
    "theatre_unavailable": "Theatre unavailable",
    "diversion": "Facility on diversion",
    "other": "Other — see note",
}

#: Which hold resource a decline reason invalidates. A facility that has no ICU
#: is not necessarily refusing the patient, so the reason is mapped to the
#: resource the platform should stop trusting rather than to a blanket refusal.
DECLINE_RELEASES = {
    "no_bed": "bed",
    "no_icu": "icu",
    "no_ventilator": "ventilator",
}


def _facility_for(db: Session, user: User) -> Hospital:
    """The facility a hospital account acts as. No implicit current facility: a
    staff account is always scoped to exactly one, and guessing would let a
    mis-provisioned account answer for a facility it does not work at."""
    if user.role is not UserRole.HOSPITAL_ADMIN:
        raise HTTPException(status_code=403, detail="Only facility staff may answer an inbound alert")
    if user.hospital_id is None:
        raise HTTPException(status_code=403, detail="This account is not linked to a facility")
    hospital = db.get(Hospital, user.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Facility not found")
    return hospital


@router.post("/incidents/{incident_id}/facility-response")
async def facility_response(
    incident_id: int,
    payload: FacilityResponse,
    user: User = Depends(
        require_roles(UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN, UserRole.DISPATCHER)
    ),
    db: Session = Depends(get_db),
):
    """A ward answering "we can take this" or "we cannot".

    The inbound alert had no reply path at all. Dispatch placed a hold, the ward
    received a notification, and there was nowhere for the ward to say that the
    one ICU bed on the board was in fact occupied. The only way to communicate it
    was a phone call — to a control room that had no field to record the outcome
    in, so the hold stayed until it expired and the next shortlist still showed
    the bed as free.

    Both answers are first-class:

      accepted  confirms the ward has seen the alert and is preparing. That is
                the acknowledgement the dispatcher currently lacks: not knowing
                whether anyone read the prep alert is the difference between
                sending a second unit and waiting.
      declined  releases the hold immediately — the bed goes back into the pool
                the same second rather than in fifteen minutes — records the
                reason against the facility's own capacity record so the trust
                engine sees the correction, and tells dispatch and the crew that
                the destination has changed.

    A decline is deliberately *not* a cancellation of the incident. Control
    decides where the patient goes; a ward saying "not here" is information, not
    a decision, and letting a facility unilaterally strand an ambulance would put
    the wrong party in charge of the patient's journey.
    """
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")

    if user.role is UserRole.HOSPITAL_ADMIN:
        hospital = _facility_for(db, user)
    else:
        # An administrator may act for a facility when its own staff are locked
        # out; a dispatcher may act for one because the answer very often
        # arrives by telephone and somebody has to be able to write it down.
        # Either way the actor is recorded, so the audit trail distinguishes a
        # ward's own answer from one taken on its behalf.
        hospital = db.get(Hospital, incident.assigned_hospital_id) if incident.assigned_hospital_id else None
        if hospital is None:
            raise HTTPException(status_code=409, detail="This incident has no assigned facility to answer for")
        if user.role is UserRole.DISPATCHER and incident.district_id != user.district_id:
            raise HTTPException(status_code=403, detail="This incident is outside your district")

    if incident.assigned_hospital_id != hospital.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    if incident.status in lifecycle.TERMINAL_STATES:
        raise HTTPException(
            status_code=409,
            detail=f"{incident.reference} is already {lifecycle.STATUS_LABELS[incident.status].lower()}",
        )

    now = utcnow()

    if payload.response == "accepted":
        incident.facility_acknowledged_at = now
        audit.record(
            db,
            action="incident.facility_accept",
            entity_type="incident",
            entity_id=incident.id,
            summary=f"{hospital.short_name} confirmed it can receive {incident.reference}"
            + (f" — {payload.note}" if payload.note else "")
            + (
                " (recorded by the control room on the ward's behalf)"
                if user.role is not UserRole.HOSPITAL_ADMIN
                else ""
            ),
            actor=user,
        )
        db.commit()
        await live_store.publish(
            "hospital.accepted",
            {
                "hospital_id": hospital.id,
                "incident_id": incident.id,
                "reference": incident.reference,
                "at": now.isoformat() + "Z",
            },
        )
        notify.notify_user(
            db,
            user_id=incident.created_by,
            kind=NotificationKind.HOLD_PLACED,
            title=f"{hospital.short_name} confirmed receipt",
            body=f"{incident.reference} accepted by {hospital.name}. The ward is preparing.",
            severity="info",
            incident_id=incident.id,
        )
        db.commit()
        return {**incident_out(incident, db=db), "facility_response": "accepted"}

    # --- declined --------------------------------------------------------
    # A reason is required. "Other" is in the enum for the genuinely
    # uncategorised case, so requiring the field costs nothing and buys the one
    # thing a refusal is worth: a number that says *why* the state's facilities
    # are turning ambulances away. A decline recorded as blank is a decline
    # nobody can act on.
    if payload.reason is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "A decline needs a reason. 'no ICU' tells the console to correct the "
                "facility's ICU figure; 'diversion' tells it to send the next case elsewhere."
            ),
        )
    reason = payload.reason
    released = reservations.release_for_incident(
        db,
        incident.id,
        reason=f"declined by {hospital.short_name}: {DECLINE_REASONS.get(reason, reason)}",
    )

    # The reason is also a capacity correction. A ward declining for "no ICU" has
    # just told the platform its ICU count is wrong, and that is worth more than
    # the decline itself: it is the only moment the true number is known for
    # certain. Recording it means the next shortlist for any incident does not
    # repeat the same mistake against the same facility.
    resource = DECLINE_RELEASES.get(reason)
    corrected = None
    if resource and incident.requires_icu and resource == "icu":
        corrected = _correct_capacity(db, hospital=hospital, resource="icu", actor=user, incident=incident)

    incident.facility_declined_at = now
    incident.facility_decline_reason = reason
    # The destination is cleared, and that is the load-bearing part. Leaving it
    # set meant the incident still read as sorted: the dispatcher's row showed a
    # receiving facility, the crew's screen kept navigating to a ward that had
    # refused them, and the ward's own inbox kept an inbound it had just turned
    # away. The incident stays live and keeps its crew -- it is the *destination*
    # that is withdrawn, not the journey.
    incident.assigned_hospital_id = None
    refused = declined_for(incident)
    if hospital.id not in refused:
        refused.append(hospital.id)
    incident.declined_hospital_ids = ",".join(str(x) for x in refused)

    # Who actually said no is recorded, because after an incident somebody asks
    # it. A ward's own answer and one taken down by a dispatcher from a phone
    # call are the same fact operationally and a different fact evidentially.
    on_behalf = user.role is not UserRole.HOSPITAL_ADMIN
    audit.record(
        db,
        action="incident.facility_decline",
        entity_type="incident",
        entity_id=incident.id,
        summary=(
            f"{hospital.short_name} declined {incident.reference}: {DECLINE_REASONS.get(reason, reason)}"
            f" — {len(released)} hold(s) released"
            + (f" — {payload.note}" if payload.note else "")
            + (" (recorded by the control room on the ward's behalf)" if on_behalf else "")
        ),
        actor=user,
        payload={
            "reason": reason,
            "hold_resource_corrected": corrected,
            "recorded_on_behalf_of_facility": on_behalf,
        },
    )
    db.commit()

    await live_store.publish(
        "hospital.declined",
        {
            "hospital_id": hospital.id,
            "incident_id": incident.id,
            "reference": incident.reference,
            "reason": reason,
            "reason_label": DECLINE_REASONS.get(reason, reason),
            "note": payload.note,
            "at": now.isoformat() + "Z",
        },
    )

    notify.notify_user(
        db,
        user_id=incident.created_by,
        kind=NotificationKind.HOLD_RELEASED,
        title=f"{hospital.short_name} cannot receive",
        body=(
            f"{incident.reference} was declined: {DECLINE_REASONS.get(reason, reason)}. "
            "The hold has been released and the destination needs re-choosing."
            + (f" Note: {payload.note}" if payload.note else "")
        ),
        severity="critical",
        incident_id=incident.id,
    )
    db.commit()

    # Fresh options, computed now that the declined facility's capacity has been
    # corrected. Sending the dispatcher back to a shortlist generated before the
    # correction would offer the same wrong answer again — which is the loop the
    # ward was phoning in to break.
    # Empty string, not NULL: the column is NOT NULL and defaults to it, and a
    # decline that clears the snapshot is clearing a string. Writing None here
    # raised an IntegrityError inside the transaction, so the ward's decline was
    # rolled back and the console saw a 500 -- the re-route the ward had just
    # asked for never happened.
    incident.match_snapshot = ""
    db.flush()
    shortlist = build_shortlist(db, incident=incident, limit=8)
    db.commit()

    return {
        **incident_out(incident, db=db),
        "facility_response": "declined",
        "reason": reason,
        "reason_label": DECLINE_REASONS.get(reason, reason),
        "released_holds": len(released),
        "capacity_corrected": corrected,
        "shortlist": list(shortlist),
        "routing": shortlist.routing,
    }


def _correct_capacity(db: Session, *, hospital: Hospital, resource: str, actor: User, incident: Incident) -> int | None:
    """Write a zero for the resource a facility has just said it does not have.

    Goes through `ingest_capacity` rather than touching the projection, so the
    correction is a normal capacity record: it carries a source, it is audited,
    and the trust engine sees it. A back-door write would update the directory
    while leaving the facility's history with a gap in it.
    """
    from .hospitals import ingest_capacity

    previous = latest_capacity_map(db).get(hospital.id)
    if previous is None:
        return None
    values = {
        "beds_available": previous.beds_available,
        "icu_available": previous.icu_available,
        "ventilators_available": previous.ventilators_available,
        "ed_congestion": previous.ed_congestion,
        "ed_waiting": previous.ed_waiting,
        "blood_units": previous.blood_units,
        "antivenom_vials": previous.antivenom_vials,
    }
    field = {"icu": "icu_available", "bed": "beds_available", "ventilator": "ventilators_available"}[resource]
    if values.get(field, 0) <= 0:
        return None
    values[field] = 0
    ingest_capacity(
        db,
        hospital=hospital,
        values=values,
        source=IntegrationMode.MANUAL,
        actor=actor,
        note=f"corrected after {hospital.short_name} declined {incident.reference}: no {resource}",
    )
    return 0
