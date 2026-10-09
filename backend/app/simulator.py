"""Connector simulator + workflow driver.

Two background loops stand in for infrastructure the pilot does not have yet:

* `ingest_loop` impersonates the hospital connectors. It walks each facility's
  capacity the way a real ward does -- small mean-reverting moves, occasional
  surges, a rare implausible jump that the trust engine is *supposed* to catch
  (injected on purpose, so the anomaly path is exercised rather than assumed).

* `workflow_loop` advances incidents through their lifecycle so the console,
  the driver app and the hospital inbound panel all show something moving in a
  demo without anyone clicking. In production this is driven by real crew
  actions and a scheduling service.

Both are disabled by `MEDMESH_SIMULATOR_ENABLED=false`, which is what the test
suite and any production deployment set.
"""

from __future__ import annotations

import asyncio
import logging
import random
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from .config import settings
from .database import SessionLocal
from .live import live_store
from .models import (
    Ambulance,
    AmbulanceStatus,
    Bleeding,
    District,
    EdCongestion,
    Hazard,
    HoldStatus,
    Hospital,
    Incident,
    IncidentCategory,
    IncidentStatus,
    IntegrationMode,
    Mechanism,
    ObservationFlag,
    PatientState,
    Urgency,
    User,
    utcnow,
)
from .repository import active_holds, sync_hold_projection
from .routers.hospitals import ingest_capacity
from .services import audit, lifecycle, references
from .services.geo import estimate_leg

log = logging.getLogger("medmesh.simulator")

_rng = random.Random()


def _congestion_for(waiting: int) -> EdCongestion:
    if waiting >= 18:
        return EdCongestion.CRITICAL
    if waiting >= 11:
        return EdCongestion.HIGH
    if waiting >= 5:
        return EdCongestion.MODERATE
    return EdCongestion.LOW


async def ingest_loop() -> None:
    """Drive the live feed."""
    interval = settings.simulator_interval_seconds
    await asyncio.sleep(3.0)  # let the app finish starting

    tick = 0
    while True:
        try:
            tick += 1
            await asyncio.sleep(interval)
            await asyncio.to_thread(_ingest_tick, tick)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive; a bad tick must not kill the loop
            log.exception("ingest tick failed")


def _ingest_tick(tick: int) -> None:
    db = SessionLocal()
    try:
        # The roster is synthetic for the same reason the capacity figures are,
        # and needs the same upkeep: seeded duty windows carry an end time, and
        # once expiry is enforced they all lapse. Renewal re-reads the shift each
        # doctor was already given rather than inventing a schedule -- see
        # services/roster.py. Cheap enough to attempt every tick; it is a single
        # indexed read once nothing needs renewing.
        try:
            from .services.roster import renew_demo_roster

            renewed = renew_demo_roster(db)
            if renewed:
                db.commit()
                if tick % 10 == 1:
                    log.info("roster renewed for %d clinician(s) on the current shift", renewed)
        except Exception:
            db.rollback()
            log.exception("roster renewal failed")
        hospitals = list(db.execute(select(Hospital)).scalars().all())
        if not hospitals:
            return

        # Only facilities with a real connector report on their own; manual
        # facilities are updated by humans (the hospital portal) and should look
        # that way in the freshness column.
        api_hospitals = [h for h in hospitals if h.integration is IntegrationMode.API]
        manual_hospitals = [h for h in hospitals if h.integration is IntegrationMode.MANUAL]
        if not api_hospitals:
            return

        picks = _rng.sample(api_hospitals, k=min(settings.simulator_hospitals_per_tick, len(api_hospitals)))
        # A manual facility goes stale on purpose every so often so the staleness
        # and reminder-nudge paths are visible in the UI without waiting an hour.
        if tick % 7 == 0 and manual_hospitals:
            picks.append(_rng.choice(manual_hospitals))

        for hospital in picks:
            view = live_store.get(hospital.id)
            if view is None:
                continue

            surge_tick = _rng.random() < 0.06
            beds_delta = int(_rng.gauss(-1.2 if surge_tick else 0.0, 3.0 if surge_tick else 1.4))
            icu_delta = int(_rng.gauss(-0.6 if surge_tick else 0.0, 1.1 if surge_tick else 0.6))
            vent_delta = int(_rng.gauss(-0.3 if surge_tick else 0.0, 0.8 if surge_tick else 0.4))
            wait_delta = int(_rng.gauss(1.6 if surge_tick else 0.0, 2.2 if surge_tick else 1.3))

            beds = max(0, min(hospital.total_beds, view.beds_available + beds_delta))
            icu = max(0, min(hospital.total_icu, view.icu_available + icu_delta))
            vent = max(0, min(hospital.total_ventilators, view.ventilators_available + vent_delta))
            waiting = max(0, min(70, view.ed_waiting + wait_delta))

            # Rare deliberate anomaly: a bulk-admission clerical error, which is
            # the exact class of event the trust engine exists to quarantine.
            if _rng.random() < 0.012:
                beds = max(0, min(hospital.total_beds, beds + _rng.choice([-1, 1]) * _rng.randint(18, 34)))

            ingest_capacity(
                db,
                hospital=hospital,
                values={
                    "beds_available": beds,
                    "icu_available": icu,
                    "ventilators_available": vent,
                    "ed_congestion": _congestion_for(waiting),
                    "ed_waiting": waiting,
                    "blood_units": max(0, view.blood_units + _rng.randint(-2, 2)),
                    "antivenom_vials": view.antivenom_vials,
                },
                source=IntegrationMode.API,
                actor=None,
                note=f"connector tick {tick}",
            )
    finally:
        db.close()


async def workflow_loop() -> None:
    """Advance open incidents, commit the ones nobody has picked up, expire holds."""
    await asyncio.sleep(6.0)
    while True:
        try:
            await asyncio.sleep(12.0)
            await asyncio.to_thread(_workflow_tick)
            await _control_room_tick()
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover
            log.exception("workflow tick failed")


async def _control_room_tick() -> None:
    """Play the operator, using the operator's own commit path.

    `_demo_intake` keeps cases arriving. Nothing else in the pilot does what a
    control room does with them, so an unattended build accumulates a queue of
    open cases, no crew is ever sent, and the fleet map, the ward's inbound panel
    and the driver app -- three of the five surfaces -- have nothing to show.

    This calls the real `dispatch` endpoint handler, with a real dispatcher
    account and the engine's own recommendation, so a case committed here carries
    the same audit entry, bed hold, notification and socket events as one an
    operator committed by hand. It is not a shortcut around the workflow; it is
    the workflow, driven by a script instead of a person.

    Simulator-only by construction: this runs from `workflow_loop`, which is
    started only when the simulator is enabled.
    """
    from .models import UserRole
    from .routers.dispatch import build_shortlist, dispatch as dispatch_endpoint
    from .schemas import DispatchRequest

    try:
        with SessionLocal() as scout:
            operator = scout.execute(
                select(User).where(User.role == UserRole.DISPATCHER).order_by(User.id)
            ).scalars().first()
            if operator is None:
                return

            # One commit per tick at most, and only when the board is quiet: two
            # crews landing on the same facility in the same tick is the sort of
            # thing that makes a demo look scripted.
            if _rng.random() > 0.35:
                return

            candidate = scout.execute(
                select(Incident)
                .where(
                    Incident.status == IncidentStatus.OPEN,
                    Incident.casualty_count == 1
                )
                .order_by(Incident.urgency, Incident.created_at)
                .limit(1)
            ).scalars().first()
            if candidate is None:
                return

            shortlist = build_shortlist(scout, incident=candidate, limit=8)
            best = next((c for c in shortlist if c["eligible"]), None)
            if best is None:
                # Nothing can take this case right now. Leaving it on the board
                # is the correct behaviour, and the operator can see why.
                return

            incident_id = candidate.id
            reference = candidate.reference
            department = "icu" if candidate.requires_icu else (
                "ventilator" if candidate.requires_ventilator else "bed"
            )

        # The endpoint opens its own unit of work from the request scope, so it
        # gets one here too -- the read above is finished and closed.
        with SessionLocal() as work:
            await dispatch_endpoint(
                incident_id,
                DispatchRequest(hospital_id=best["hospital_id"], hold_resource=department),
                operator,
                work,
            )
        # Shortlist rows are keyed `name`/`short_name`; there is no
        # `hospital_name`. This line used to raise a KeyError on every tick,
        # which the blanket except below swallowed -- so the commit happened
        # and the one line of log that would have told an operator about it
        # never appeared.
        log.info(
            "demo control room: %s committed to %s (%s hold)",
            reference,
            best.get("short_name") or best.get("name") or best["hospital_id"],
            department,
        )
    except Exception:  # pragma: no cover - a demo must never crash the loop
        log.exception("control-room tick failed")


def _workflow_tick() -> None:
    db = SessionLocal()
    try:
        now = utcnow()

        # --- expire holds -------------------------------------------------
        expired = [h for h in active_holds(db) if h.expires_at <= now]
        if expired:
            for hold in expired:
                hold.status = HoldStatus.EXPIRED
                hold.released_at = now
                hold.release_reason = "hold window elapsed"
            db.commit()
            for hospital_id in {h.hospital_id for h in expired}:
                sync_hold_projection(db, hospital_id)

        # --- demo intake -----------------------------------------------------
        # Before advancing anything, make sure there is something to advance: the
        # longitudinal demo empties out once every seeded case has been handed
        # over, and an empty board demonstrates the empty states instead of the
        # workflows. See DEMO_TARGET_OPEN.
        created = _demo_intake(db)
        if created:
            db.commit()

        # --- incidents ------------------------------------------------------
        incidents = list(
            db.execute(
                select(Incident).where(
                    Incident.status.in_(
                        (
                            IncidentStatus.DISPATCHED,
                            IncidentStatus.EN_ROUTE,
                            IncidentStatus.AT_SCENE,
                            IncidentStatus.PATIENT_ONBOARD,
                            IncidentStatus.TRANSPORTING,
                            IncidentStatus.AT_HOSPITAL,
                            IncidentStatus.HANDED_OVER,
                            # Deprecated spelling. Rows written before the state
                            # model was completed still carry it, and a case
                            # sitting on one never advanced again.
                            IncidentStatus.ARRIVED,
                        )
                    )
                )
            ).scalars().all()
        )
        broadcasts: list[tuple[str, dict]] = []
        hospitals = {h.id: h for h in db.execute(select(Hospital)).scalars().all()}

        for incident in incidents:
            ambulance = db.get(Ambulance, incident.assigned_ambulance_id) if incident.assigned_ambulance_id else None
            hospital = hospitals.get(incident.assigned_hospital_id) if incident.assigned_hospital_id else None
            if ambulance is None:
                continue
            age = (now - incident.created_at).total_seconds()

            # Crew position moves toward the scene, then toward the hospital, so
            # the console's fleet layer and the ETA countdowns actually change.
            target = None
            if incident.status in (IncidentStatus.DISPATCHED, IncidentStatus.EN_ROUTE):
                target = (incident.lat, incident.lng)
            elif incident.status in (
                IncidentStatus.PATIENT_ONBOARD,
                IncidentStatus.TRANSPORTING,
                IncidentStatus.AT_HOSPITAL,
                IncidentStatus.ARRIVED,
                IncidentStatus.HANDED_OVER,
            ) and hospital:
                target = (hospital.lat, hospital.lng)

            if target and _rng.random() < 0.85:
                leg = estimate_leg(ambulance.lat, ambulance.lng, target[0], target[1])
                if leg.road_km > 0.12:
                    step = min(0.28, 1.6 / max(leg.road_km, 0.5))
                    ambulance.lat = round(ambulance.lat + (target[0] - ambulance.lat) * step, 5)
                    ambulance.lng = round(ambulance.lng + (target[1] - ambulance.lng) * step, 5)
                    ambulance.updated_at = now

            # Lifecycle. Timings are derived from how far this case actually
            # has to travel, not from fixed wall-clock constants: a fixed 150 s
            # to arrival meant a case 30 km out "arrived" on the same schedule
            # as one 400 m out, and every case closed within seven minutes of
            # opening, which emptied the board on any run longer than a coffee
            # break. Pace is the demo compression factor -- one real travel
            # minute costs DEMO_PACE seconds of wall clock.
            travel_min = 8.0
            if hospital is not None:
                travel_min = max(
                    float(estimate_leg(incident.lat, incident.lng, hospital.lat, hospital.lng).eta_minutes),
                    2.0,
                )
            # Outbound leg is scene-bound; the inbound leg is the same geometry
            # run the other way, and they are genuinely different durations in
            # this dataset (a hill road out, a highway back).
            travel_min = 8.0
            transport_min = 8.0
            if hospital is not None:
                travel_min = max(
                    float(estimate_leg(incident.lat, incident.lng, hospital.lat, hospital.lng).eta_minutes),
                    2.0,
                )
                transport_min = max(
                    float(estimate_leg(hospital.lat, hospital.lng, incident.lat, incident.lng).eta_minutes),
                    2.0,
                )
            arrive_after = min(max(travel_min * DEMO_PACE, 420.0), 1500.0)
            # On-scene time is what separates "arrived" from "loaded", and it is
            # the interval the audit said the platform could not measure at all.
            scene_load_after = arrive_after + min(max(SCENE_LOAD_MINUTES * DEMO_PACE, 180.0), 720.0)
            depart_after = scene_load_after + 20
            hospital_after = depart_after + min(max(transport_min * DEMO_PACE, 300.0), 1200.0)
            handover_after = hospital_after + min(max(HANDOVER_MINUTES * DEMO_PACE, 120.0), 600.0)

            # --- the trip, stage by stage ---------------------------------
            # The simulator used to jump EN_ROUTE -> ARRIVED -> HANDED_OVER,
            # which meant the demo exercised three of the seven states the
            # driver app puts buttons on and populated none of the split
            # timestamps. Every intermediate column is now written the same way
            # a real crew writes it -- through `apply_timestamps` -- so the
            # analytics in this build are computed from the same lifecycle the
            # production path uses rather than from a fixed-offset script.

            def advance(status: IncidentStatus, when) -> None:
                incident.status = status
                lifecycle.apply_timestamps(incident, status, when)
                broadcasts.append(
                    (
                        "incident.status",
                        {
                            "incident_id": incident.id,
                            "reference": incident.reference,
                            "status": status.value,
                        },
                    )
                )

            # Any deprecated row is moved onto the current vocabulary first, so
            # one stale status cannot stall a case forever.
            if incident.status is IncidentStatus.ARRIVED:
                incident.status = IncidentStatus.AT_SCENE
                if incident.arrived_at is None:
                    incident.arrived_at = now
                if incident.scene_arrived_at is None:
                    incident.scene_arrived_at = incident.arrived_at

            if incident.status is IncidentStatus.DISPATCHED and age > 25:
                advance(IncidentStatus.EN_ROUTE, now)
                ambulance.status = AmbulanceStatus.EN_ROUTE
            elif incident.status is IncidentStatus.EN_ROUTE and age > arrive_after:
                advance(IncidentStatus.AT_SCENE, now)
                ambulance.status = AmbulanceStatus.AT_SCENE
            elif incident.status is IncidentStatus.AT_SCENE and age > scene_load_after:
                advance(IncidentStatus.PATIENT_ONBOARD, now)
                ambulance.status = AmbulanceStatus.AT_SCENE
            elif incident.status is IncidentStatus.PATIENT_ONBOARD and age > depart_after:
                advance(IncidentStatus.TRANSPORTING, now)
                ambulance.status = AmbulanceStatus.TRANSPORTING
            elif incident.status is IncidentStatus.TRANSPORTING and age > hospital_after:
                advance(IncidentStatus.AT_HOSPITAL, now)
                ambulance.status = AmbulanceStatus.TRANSPORTING
            elif incident.status is IncidentStatus.AT_HOSPITAL and age > handover_after:
                advance(IncidentStatus.HANDED_OVER, now)
                ambulance.status = AmbulanceStatus.AVAILABLE
                for hold in active_holds(db):
                    if hold.incident_id == incident.id:
                        hold.status = HoldStatus.CONSUMED
                        hold.released_at = now
                        hold.release_reason = "patient handed over"
                broadcasts.append(("incident.status", {"incident_id": incident.id, "reference": incident.reference, "status": "handed_over"}))

        # ---- keep the board moving -----------------------------------------
        # Two things a live 108 console does that nothing else in this loop
        # reproduces: calls arrive, and an operator commits them. Without this
        # the crew app, the hospital inbound panel and the console's committed
        # state all sit in their empty state once the seeded case completes --
        # which makes the pilot demonstrate its placeholders rather than itself.
        #
        # The two rates are set against each other on purpose. A case occupies
        # its ambulance for roughly eleven minutes (see the lifecycle block
        # below), and the pilot fleet has nine units at rest, so the board can
        # absorb about one commitment per seventy seconds indefinitely. Calls
        # arrive at about half that rate, which keeps a short queue on the
        # console and a couple of free units in the fleet instead of starving
        # either one. Anything faster fills the queue with calls nobody can
        # answer and makes the fleet look broken.
        open_incidents = list(
            db.execute(select(Incident).where(Incident.status == IncidentStatus.OPEN)).scalars().all()
        )

        # Answer the oldest call that has been ringing long enough, one per
        # tick at most.
        free_units = db.execute(
            select(Ambulance).where(
                Ambulance.status == AmbulanceStatus.AVAILABLE,
                Ambulance.operator_type == "108",
            )
        ).scalars().all()
        waiting = [i for i in sorted(open_incidents, key=lambda i: i.created_at)
                   if (now - i.created_at).total_seconds() >= 20 and i.casualty_count == 1]

        if waiting and len(free_units) >= 2 and _rng.random() < 0.18:
            incident = waiting[0]
            committed = _auto_dispatch(db, incident, now)
            if committed:
                broadcasts.extend(committed)
                open_incidents.remove(incident)

        # And take a new call whenever the queue gets short.
        if len(open_incidents) < 3 and _rng.random() < 0.10:
            _spawn_incident(db, now)
            db.commit()

        db.commit()

        if broadcasts:
            for event, payload in broadcasts:
                db2 = None
                try:
                    # Publishing from a worker thread: hand the envelope to the
                    # event loop that owns the subscriber queues.
                    loop = _main_loop()
                    if loop is not None:
                        asyncio.run_coroutine_threadsafe(live_store.publish(event, payload), loop)
                finally:
                    if db2:
                        db2.close()
    finally:
        db.close()


_LOOP: asyncio.AbstractEventLoop | None = None


def _main_loop() -> asyncio.AbstractEventLoop | None:
    return _LOOP


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _LOOP
    _LOOP = loop


def _auto_dispatch(db, incident: Incident, now) -> bool:
    """Commit an open incident the way a console operator would.

    Uses the real matching engine and the real hold table, so the simulator
    exercises the same code path a dispatcher does rather than writing a
    shortcut. Returns the websocket envelopes the commit should emit, or None
    if nothing could be committed.
    """
    from .models import BedHold, HoldStatus
    from .routers.dispatch import build_shortlist

    shortlist = build_shortlist(db, incident=incident, limit=5)
    best = next((c for c in shortlist if c["eligible"]), None)
    if best is None:
        return None

    available = db.execute(
        select(Ambulance).where(
            Ambulance.status == AmbulanceStatus.AVAILABLE,
            Ambulance.operator_type == "108",
        )
    ).scalars().all()
    if not available:
        return None

    # Nearest few available units, then pick among them: strictly nearest would
    # pin every call to the same unit, but sampling the fleet at random instead
    # let a unit from another district take a call with a fifty-kilometre drive
    # to the scene while a free unit sat four kilometres away. A dispatcher
    # chooses between the two or three closest, so that is what this does.
    by_distance = sorted(
        available,
        key=lambda a: estimate_leg(a.lat, a.lng, incident.lat, incident.lng).road_km,
    )
    unit = _rng.choice(by_distance[:3])

    resource = "icu" if incident.requires_icu else "bed"
    incident.assigned_hospital_id = best["hospital_id"]
    incident.assigned_ambulance_id = unit.id
    incident.status = IncidentStatus.DISPATCHED
    incident.dispatched_at = now
    unit.status = AmbulanceStatus.ASSIGNED

    db.add(
        BedHold(
            hospital_id=best["hospital_id"],
            incident_id=incident.id,
            resource=resource,
            status=HoldStatus.ACTIVE,
            created_by=incident.created_by,
            created_at=now,
            expires_at=now + timedelta(seconds=settings.default_hold_ttl_seconds),
        )
    )
    db.flush()
    sync_hold_projection(db, best["hospital_id"])

    audit.record(
        db,
        action="incident.dispatch",
        entity_type="incident",
        entity_id=incident.id,
        summary=f"{incident.reference} → {best['short_name']} via {unit.call_sign} (simulator commit)",
        actor=None,
        payload={"engine_score": best["score"], "engine_rank": 1, "reasons": best["reasons"]},
    )

    # Same two envelopes the console's own dispatch endpoint publishes. The
    # hospital prep alert in particular is a push, not a historical record --
    # if the simulator stayed quiet, a dashboard opened after the fact would
    # never show the inbound panel doing anything.
    leg = estimate_leg(unit.lat, unit.lng, incident.lat, incident.lng)
    return [
        (
            "incident.dispatched",
            {
                "incident_id": incident.id,
                "reference": incident.reference,
                "hospital_id": best["hospital_id"],
                "hospital_name": best["short_name"],
                "ambulance_call_sign": unit.call_sign,
                "eta_to_scene_minutes": leg.eta_minutes,
            },
        ),
        (
            "hospital.inbound",
            {
                "hospital_id": best["hospital_id"],
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
                "hold_resource": resource,
            },
        ),
    ]


# Wall-clock seconds a real travel minute costs in the pilot dataset. See the
# lifecycle block in _workflow_tick for why this is not a fixed constant.
DEMO_PACE = 20.0
#: Minutes between reaching the patient and having them aboard.
SCENE_LOAD_MINUTES = 5.0
#: Minutes at the receiving desk between arrival and the handover being signed.
HANDOVER_MINUTES = 6.0

# Scene vocabulary for the simulator, keyed by what the call is about.
_MECHANISM_BY_CATEGORY = {
    IncidentCategory.ROAD_ACCIDENT: Mechanism.TWO_WHEELER,
    IncidentCategory.TRAUMA_FALL: Mechanism.FALL_HEIGHT,
    IncidentCategory.BURNS: Mechanism.OTHER,
    IncidentCategory.SNAKEBITE: Mechanism.NONE,
    IncidentCategory.CARDIAC: Mechanism.NONE,
    IncidentCategory.STROKE: Mechanism.NONE,
    IncidentCategory.OBSTETRIC: Mechanism.NONE,
    IncidentCategory.PAEDIATRIC: Mechanism.NONE,
    IncidentCategory.RESPIRATORY: Mechanism.NONE,
    IncidentCategory.POISONING: Mechanism.NONE,
    IncidentCategory.DIALYSIS: Mechanism.NONE,
    IncidentCategory.OTHER: Mechanism.NONE,
}

_OBSERVATIONS_BY_CATEGORY = {
    IncidentCategory.ROAD_ACCIDENT: [ObservationFlag.SUSPECTED_FRACTURE, ObservationFlag.LIMB_DEFORMITY],
    IncidentCategory.TRAUMA_FALL: [ObservationFlag.SUSPECTED_FRACTURE, ObservationFlag.SEVERE_HEADACHE],
    IncidentCategory.CARDIAC: [ObservationFlag.CHEST_PAIN, ObservationFlag.BREATHLESSNESS],
    IncidentCategory.STROKE: [ObservationFlag.PARALYSIS_ONE_SIDE, ObservationFlag.SLURRED_SPEECH],
    IncidentCategory.OBSTETRIC: [ObservationFlag.OBSTETRIC_LABOUR, ObservationFlag.POSTPARTUM_BLEEDING],
    IncidentCategory.PAEDIATRIC: [ObservationFlag.FEVER, ObservationFlag.SEIZURE],
    IncidentCategory.BURNS: [ObservationFlag.BURNS_SURFACE, ObservationFlag.INHALATION_SMOKE],
    IncidentCategory.SNAKEBITE: [ObservationFlag.SNAKEBITE_SWELLING],
    IncidentCategory.POISONING: [ObservationFlag.POISON_INGESTED, ObservationFlag.VOMITING],
    IncidentCategory.RESPIRATORY: [ObservationFlag.BREATHLESSNESS, ObservationFlag.FEVER],
    IncidentCategory.DIALYSIS: [ObservationFlag.DIALYSIS_MISSED],
    IncidentCategory.OTHER: [ObservationFlag.ABDOMINAL_PAIN],
}

INCIDENT_VOCAB = [
    (IncidentCategory.ROAD_ACCIDENT, "Road traffic accident", True, False, "Avinashi Road", "Trichy Road", "Sathy Road", "Mettupalayam Road"),
    (IncidentCategory.CARDIAC, "Cardiac emergency", True, False, "Sungam bypass", "Gandhipuram", "Ramanathapuram", "Saibaba Colony"),
    (IncidentCategory.TRAUMA_FALL, "Fall from height", True, False, "construction site", "residential block", "factory floor"),
    (IncidentCategory.SNAKEBITE, "Snakebite", True, False, "village outskirts", "farm land", "canal bank"),
    (IncidentCategory.RESPIRATORY, "Respiratory distress", True, False, "Kuniamuthur", "Ukkadam", "Singanallur"),
    (IncidentCategory.OBSTETRIC, "Obstetric emergency", False, True, "Peelamedu", "Ganapathy", "Vadavalli"),
    (IncidentCategory.BURNS, "Burns — kitchen fire", True, False, "household", "workshop", "hotel kitchen"),
]


def _spawn_incident(db, now) -> None:
    """Create a realistic incoming call and run matching, exactly as the console
    would. Keeps the demo populated once the seeded incidents are handled."""
    from .routers.dispatch import build_shortlist, snapshot_from_list

    district = db.execute(select(District)).scalars().first()
    if district is None:
        return

    category, label, needs_icu, needs_blood, *places = _rng.choice(INCIDENT_VOCAB)
    place = _rng.choice(places)

    # A believable scene assessment for this category, drawn from the same
    # structured vocabulary the console uses. The simulator must not invent a
    # second, looser incident shape -- everything downstream reads these fields.
    state = _rng.choices(
        [
            PatientState.ALERT,
            PatientState.DROWSY,
            PatientState.UNCONSCIOUS_BREATHING,
            PatientState.UNCONSCIOUS_NOT_BREATHING,
            PatientState.UNKNOWN,
        ],
        weights=[5, 2, 2, 1, 1],
    )[0]
    mechanism = _MECHANISM_BY_CATEGORY.get(category, Mechanism.NONE)
    bleeding = _rng.choices([Bleeding.NONE, Bleeding.MINOR, Bleeding.SEVERE], weights=[6, 3, 1])[0]
    picked_observations = _rng.sample(
        _OBSERVATIONS_BY_CATEGORY.get(category, []), k=min(2, len(_OBSERVATIONS_BY_CATEGORY.get(category, [])))
    )
    dispatcher = db.execute(select(User).where(User.role == "dispatcher")).scalars().first()

    reference = references.allocate_reference(db, now=now)

    incident = Incident(
        reference=reference,
        category=category,
        urgency=Urgency.P1 if _rng.random() < 0.75 else Urgency.P2,
        lat=round(district.lat + _rng.uniform(-0.07, 0.07), 5),
        lng=round(district.lng + _rng.uniform(-0.07, 0.07), 5),
        landmark=f"{place}",
        district_id=district.id,
        patient_state=state,
        mechanism=mechanism,
        bleeding=bleeding,
        hazard=Hazard.NONE,
        casualty_count=1,
        observations=",".join(o.value for o in picked_observations),
        requires_icu=needs_icu and _rng.random() < 0.7,
        requires_blood=needs_blood or _rng.random() < 0.25,
        status=IncidentStatus.OPEN,
        created_by=dispatcher.id if dispatcher else 1,
        created_at=now,
    )
    db.add(incident)
    try:
        db.flush()
    except IntegrityError:
        # The allocator checks before it takes, so this is the narrow window
        # between that check and this insert -- another writer took the same
        # suffix in between. Redraw once rather than letting the exception
        # unwind out of the background loop, because a simulator that stops
        # ticking is indistinguishable from a platform that has gone down.
        db.rollback()
        incident.reference = references.allocate_reference(db, now=now)
        db.add(incident)
        db.flush()
    shortlist = build_shortlist(db, incident=incident, limit=6)
    incident.match_snapshot = snapshot_from_list(shortlist)

    audit.record(
        db,
        action="incident.create",
        entity_type="incident",
        entity_id=incident.id,
        summary=f"{reference} {label} at {place} (auto-ingested call)",
        actor=None,
        payload={"source": "simulator"},
    )

    asyncio_payload = {
        "id": incident.id,
        "reference": reference,
        "category": category.value,
        "urgency": incident.urgency.value,
        "landmark": incident.landmark,
        "district_id": district.id,
        "at": incident.created_at.isoformat() + "Z",
    }
    loop = _main_loop()
    if loop is not None:
        asyncio.run_coroutine_threadsafe(live_store.publish("incident.created", asyncio_payload), loop)


async def start_background_loops() -> list[asyncio.Task]:
    if not settings.simulator_enabled:
        return []
    set_main_loop(asyncio.get_running_loop())
    tasks = [asyncio.create_task(ingest_loop(), name="ingest"), asyncio.create_task(workflow_loop(), name="workflow")]
    log.info("background loops started (ingest, workflow)")
    return tasks


# --------------------------------------------------------------------------- #
# Demo intake
#
# The pilot's incidents are synthetic, and the workflow loop above advances each
# one to handover and stops. After a couple of hours every case in the dataset is
# closed, so the console opens on "No incidents in this view", the crew app shows
# a standing driver, and the ward has no inbound panel -- the three screens the
# pilot exists to demonstrate, all showing their empty state.
#
# This keeps a small number of cases live. It is deliberately modest: an intake of
# two to four concurrent cases at a time is what a single control room handles,
# and a board with sixty open incidents would misrepresent the load the dashboard
# is designed to show.
#
# Only runs in the simulator, never against real facilities, and every case it
# creates is indistinguishable from one an operator raised -- same reference
# scheme, same district, same structured assessment -- because a demo record with
# a "DEMO" marker behaves differently from a real one everywhere it matters.
# --------------------------------------------------------------------------- #

#: How many cases to keep open. Below this, one is created per workflow tick.
DEMO_TARGET_OPEN = 3

#: Probability of creating one per tick, so the board does not fill instantly.
DEMO_INTAKE_CHANCE = 0.15

#: Landmarks worth dispatching to, by category, with the district code they sit
#: in. Real places, because the map draws them and a crew reads them out.
DEMO_SCENES: list[tuple] = [
    ("road_accident", "P1", "Avakatti bypass, NH-948", "COI"),
    ("cardiac", "P1", "Mettupalayam Road, near Thudiyalur", "COI"),
    ("snakebite", "P2", "Kallar farming settlement", "COI"),
    ("obstetric", "P1", "Annur primary health centre", "COI"),
    ("road_accident", "P1", "Salem-Coimbatore highway, Sankari", "SLM"),
    ("stroke", "P1", "Thillai Nagar 4th cross", "TRY"),
    ("paediatric", "P2", "Bhavani bus stand", "ERD"),
    ("burns", "P1", "Sivakasi match factory unit 3", "VRN"),
    ("poisoning", "P2", "Kumbakonam market street", "TJV"),
    ("trauma_fall", "P2", "Yercaud ghat road, hairpin 12", "SLM"),
    ("respiratory", "P2", "Thoothukudi harbour road", "TUT"),
    ("road_accident", "P1", "Madurai ring road, Thirunagar", "MDU"),
]


def _demo_intake(db) -> int:
    """Raise a new case if the board is running thin. Returns 1 if created."""
    from .models import LocationSource
    from .services import triage

    live = db.execute(
        select(func.count())
        .select_from(Incident)
        .where(Incident.status.in_(tuple(lifecycle.ACTIVE_TRIP_STATES) + (IncidentStatus.OPEN,)))
    ).scalar_one()
    if live >= DEMO_TARGET_OPEN or _rng.random() > DEMO_INTAKE_CHANCE:
        return 0

    category, urgency, landmark, code = _rng.choice(DEMO_SCENES)
    district = db.execute(select(District).where(District.code == code)).scalar_one_or_none()
    if district is None:
        district = db.execute(select(District).order_by(District.id)).scalars().first()
    if district is None:
        return 0

    scene = _demo_scene(category)
    # Same derivation the console runs on a live call, so a demo case carries the
    # ICU/ventilator/blood requirement its assessment implies rather than a flag
    # somebody set by hand.
    needs = triage.derive(
        category=IncidentCategory(category),
        patient_state=scene["patient_state"],
        mechanism=scene["mechanism"],
        bleeding=scene["bleeding"],
        hazard=scene["hazard"],
        observations=scene["observations"],
        trapped=scene["trapped"],
        bystander_cpr=scene["bystander_cpr"],
        casualty_count=scene["casualty_count"],
    )

    incident = Incident(
        reference=references.allocate_reference(db),
        category=IncidentCategory(category),
        urgency=Urgency(urgency),
        lat=round(district.lat + _rng.uniform(-0.06, 0.06), 5),
        lng=round(district.lng + _rng.uniform(-0.06, 0.06), 5),
        landmark=landmark,
        district_id=district.id,
        taluk=district.name,
        location_source=LocationSource.MAP,
        patient_state=scene["patient_state"],
        mechanism=scene["mechanism"],
        bleeding=scene["bleeding"],
        hazard=scene["hazard"],
        casualty_count=scene["casualty_count"],
        trapped=scene["trapped"],
        bystander_cpr=scene["bystander_cpr"],
        observations=",".join(str(o) for o in scene["observations"]),
        required_specialty=needs.specialty,
        requires_icu=needs.requires_icu,
        requires_ventilator=needs.requires_ventilator,
        requires_blood=needs.requires_blood,
        status=IncidentStatus.OPEN,
        created_by=1,
        created_at=utcnow(),
    )
    db.add(incident)
    db.flush()
    return 1


#: Structured assessment per category. Non-identifying fields only, matching what
#: the console's composer collects -- the demo must not be able to record anything
#: an operator could not.
_DEMO_ASSESSMENT: dict[str, dict] = {
    "road_accident": dict(
        patient_state=PatientState.DROWSY, mechanism=Mechanism.TWO_WHEELER, bleeding=Bleeding.MINOR,
        hazard=Hazard.TRAFFIC_ACTIVE, observations=[ObservationFlag.SUSPECTED_FRACTURE, ObservationFlag.LIMB_DEFORMITY],
    ),
    "cardiac": dict(
        patient_state=PatientState.ALERT, mechanism=Mechanism.NONE, bleeding=Bleeding.NONE,
        hazard=Hazard.NONE, observations=[ObservationFlag.CHEST_PAIN, ObservationFlag.BREATHLESSNESS],
    ),
    "snakebite": dict(
        patient_state=PatientState.ALERT, mechanism=Mechanism.OTHER, bleeding=Bleeding.NONE,
        hazard=Hazard.NONE, observations=[ObservationFlag.SNAKEBITE_SWELLING],
    ),
    "obstetric": dict(
        patient_state=PatientState.ALERT, mechanism=Mechanism.NONE, bleeding=Bleeding.SEVERE,
        hazard=Hazard.NONE, observations=[ObservationFlag.OBSTETRIC_LABOUR, ObservationFlag.POSTPARTUM_BLEEDING],
    ),
    "stroke": dict(
        patient_state=PatientState.ALERT, mechanism=Mechanism.NONE, bleeding=Bleeding.NONE,
        hazard=Hazard.NONE, observations=[ObservationFlag.PARALYSIS_ONE_SIDE, ObservationFlag.SLURRED_SPEECH],
    ),
    "paediatric": dict(
        patient_state=PatientState.DROWSY, mechanism=Mechanism.NONE, bleeding=Bleeding.NONE,
        hazard=Hazard.NONE, observations=[ObservationFlag.FEVER, ObservationFlag.VOMITING],
    ),
    "burns": dict(
        patient_state=PatientState.ALERT, mechanism=Mechanism.OTHER, bleeding=Bleeding.NONE,
        hazard=Hazard.FIRE, observations=[ObservationFlag.BURNS_SURFACE, ObservationFlag.INHALATION_SMOKE],
    ),
    "poisoning": dict(
        patient_state=PatientState.DROWSY, mechanism=Mechanism.OTHER, bleeding=Bleeding.NONE,
        hazard=Hazard.CHEMICAL, observations=[ObservationFlag.POISON_INGESTED, ObservationFlag.VOMITING],
    ),
    "trauma_fall": dict(
        patient_state=PatientState.ALERT, mechanism=Mechanism.FALL_HEIGHT, bleeding=Bleeding.MINOR,
        hazard=Hazard.NONE, observations=[ObservationFlag.SUSPECTED_FRACTURE],
    ),
    "respiratory": dict(
        patient_state=PatientState.ALERT, mechanism=Mechanism.NONE, bleeding=Bleeding.NONE,
        hazard=Hazard.NONE, observations=[ObservationFlag.BREATHLESSNESS],
    ),
}


def _demo_scene(category: str) -> dict:
    """Assessment for a category, with the fields every Incident needs filled."""
    scene = dict(_DEMO_ASSESSMENT.get(category, _DEMO_ASSESSMENT["respiratory"]))
    scene.setdefault("casualty_count", 1)
    scene.setdefault("trapped", False)
    scene.setdefault("bystander_cpr", False)
    return scene
