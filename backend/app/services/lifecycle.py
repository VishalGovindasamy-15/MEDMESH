"""The ambulance trip lifecycle.

This module exists because the trip state was previously implicit. The status
endpoint accepted any status the caller sent, wrote it straight onto the
incident, and the ambulance's own state was derived from a dictionary inside the
same function. Nothing anywhere said which transitions were legal, what each
timestamp meant, or when a trip was finished -- so the answers were spread across
the endpoint, the driver screen, the analytics queries and the ward's inbox, and
they did not agree.

The concrete symptom the audit found: the backend's `arrived` means "the crew is
at the scene", while the driver app's screen labelled it "patient onboard". A
driver who pressed it therefore told the platform the patient was in the vehicle
when they had only just parked, and the ward's countdown started against the
wrong event. That is a modelling failure, not a labelling one, so the fix is
here: one vocabulary, used by the API, both mobile surfaces and the analytics
layer, with the legal transitions written down in one place.

Vocabulary, in order:

    dispatched        control room has committed a unit; crew has not accepted
    en_route          crew travelling to the scene
    at_scene          crew at the scene, patient not yet loaded
    patient_onboard   patient loaded and being treated on scene
    transporting      vehicle moving, patient aboard
    at_hospital       vehicle at the receiving facility, handover not complete
    handed_over       clinical responsibility transferred; trip complete
    closed            administrative close (no handover recorded)
    cancelled         stood down before transport

`arrived` is retained as an accepted *input* spelling of `at_scene` because it
appears in older clients, exports and the SLA report. It is never emitted.
"""

from __future__ import annotations

from datetime import datetime

from ..models import AmbulanceStatus, Incident, IncidentStatus

# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #

#: The ordered spine of a trip. Used for the mobile progress indicator and for
#: deciding whether a transition moves forwards or backwards.
TRIP_STATES: tuple[IncidentStatus, ...] = (
    IncidentStatus.DISPATCHED,
    IncidentStatus.EN_ROUTE,
    IncidentStatus.AT_SCENE,
    IncidentStatus.PATIENT_ONBOARD,
    IncidentStatus.TRANSPORTING,
    IncidentStatus.AT_HOSPITAL,
    IncidentStatus.HANDED_OVER,
)

STATUS_LABELS: dict[IncidentStatus, str] = {
    IncidentStatus.OPEN: "Open — awaiting dispatch",
    IncidentStatus.DISPATCHED: "Dispatched",
    IncidentStatus.EN_ROUTE: "En route to scene",
    IncidentStatus.AT_SCENE: "At scene",
    IncidentStatus.PATIENT_ONBOARD: "Patient onboard",
    IncidentStatus.TRANSPORTING: "Transporting patient",
    IncidentStatus.AT_HOSPITAL: "At hospital",
    IncidentStatus.HANDED_OVER: "Handed over",
    IncidentStatus.CLOSED: "Closed",
    IncidentStatus.CANCELLED: "Cancelled",
    # The deprecated spelling, kept in the label table so that a row written
    # before the migration still renders as something an operator can read.
    # `incident_out` reads this table directly, and a missing key there is a 500
    # on the whole incident list -- which is how a single stale row took out the
    # dispatcher's queue.
    IncidentStatus.ARRIVED: "At scene",
}

#: What the driver's button says, and the one phrase the ward is told. Kept
#: distinct from STATUS_LABELS because a control-room operator reads "At scene"
#: on a queue row while the person at the scene reads "Patient loaded" on a
#: button, and forcing them to share a string makes one of the two worse.
CREW_ACTION_LABELS: dict[IncidentStatus, str] = {
    IncidentStatus.DISPATCHED: "Accept and start driving",
    IncidentStatus.EN_ROUTE: "Still driving — mark arrival",
    IncidentStatus.AT_SCENE: "Arrived at scene",
    IncidentStatus.PATIENT_ONBOARD: "Patient loaded",
    IncidentStatus.TRANSPORTING: "Departed scene",
    IncidentStatus.AT_HOSPITAL: "Arrived at hospital",
    IncidentStatus.HANDED_OVER: "Handover complete",
    IncidentStatus.CLOSED: "Close trip",
    IncidentStatus.CANCELLED: "Stand down",
}

#: Deprecated spellings accepted from older clients and mapped on the way in.
STATUS_ALIASES: dict[str, IncidentStatus] = {
    "arrived": IncidentStatus.AT_SCENE,
    "enroute": IncidentStatus.EN_ROUTE,
    "on_board": IncidentStatus.PATIENT_ONBOARD,
    "onboard": IncidentStatus.PATIENT_ONBOARD,
    "complete": IncidentStatus.HANDED_OVER,
    "completed": IncidentStatus.HANDED_OVER,
}

#: Legal transitions. A trip is a sequence, not a set of states, so this is
#: deliberately strict: skipping "patient onboard" would leave a gap in the
#: timeline that the analytics depend on, and going backwards would write a
#: second scene-arrival timestamp over the first.
ALLOWED_TRANSITIONS: dict[IncidentStatus, tuple[IncidentStatus, ...]] = {
    IncidentStatus.OPEN: (IncidentStatus.DISPATCHED, IncidentStatus.CANCELLED),
    IncidentStatus.DISPATCHED: (
        IncidentStatus.EN_ROUTE,
        IncidentStatus.AT_SCENE,  # crews that accept and arrive in one action
        IncidentStatus.HANDED_OVER,  # the ward takes the patient without a hold
        IncidentStatus.CANCELLED,
    ),
    IncidentStatus.EN_ROUTE: (
        IncidentStatus.AT_SCENE,
        IncidentStatus.HANDED_OVER,  # facility-to-facility transfers
        IncidentStatus.CANCELLED,
    ),
    IncidentStatus.AT_SCENE: (
        IncidentStatus.PATIENT_ONBOARD,
        IncidentStatus.TRANSPORTING,  # treated on scene, no transport
        IncidentStatus.HANDED_OVER,
        IncidentStatus.CANCELLED,
    ),
    IncidentStatus.PATIENT_ONBOARD: (
        IncidentStatus.TRANSPORTING,
        IncidentStatus.AT_HOSPITAL,  # short hops: vehicle never got moving
        IncidentStatus.HANDED_OVER,
        IncidentStatus.CANCELLED,
    ),
    IncidentStatus.TRANSPORTING: (
        IncidentStatus.AT_HOSPITAL,
        IncidentStatus.HANDED_OVER,
        IncidentStatus.CANCELLED,
    ),
    IncidentStatus.AT_HOSPITAL: (IncidentStatus.HANDED_OVER, IncidentStatus.CLOSED, IncidentStatus.CANCELLED),
    IncidentStatus.HANDED_OVER: (IncidentStatus.CLOSED,),
    IncidentStatus.CLOSED: (),
    IncidentStatus.CANCELLED: (),
}

#: The states in which the patient is physically in the vehicle. Drives both the
#: vehicle's status and whether the ward should be counting down to handover
#: rather than to arrival.
PATIENT_ABOARD = (IncidentStatus.PATIENT_ONBOARD, IncidentStatus.TRANSPORTING)

#: States where the trip is over.
TERMINAL_STATES = (IncidentStatus.HANDED_OVER, IncidentStatus.CLOSED, IncidentStatus.CANCELLED)

#: Incident status -> the state the assigned vehicle should be in.
AMBULANCE_FOR_STATUS: dict[IncidentStatus, AmbulanceStatus] = {
    IncidentStatus.OPEN: AmbulanceStatus.AVAILABLE,
    IncidentStatus.DISPATCHED: AmbulanceStatus.ASSIGNED,
    IncidentStatus.EN_ROUTE: AmbulanceStatus.EN_ROUTE,
    IncidentStatus.AT_SCENE: AmbulanceStatus.AT_SCENE,
    IncidentStatus.PATIENT_ONBOARD: AmbulanceStatus.AT_SCENE,
    IncidentStatus.TRANSPORTING: AmbulanceStatus.TRANSPORTING,
    IncidentStatus.AT_HOSPITAL: AmbulanceStatus.TRANSPORTING,
    IncidentStatus.HANDED_OVER: AmbulanceStatus.AVAILABLE,
    IncidentStatus.CLOSED: AmbulanceStatus.AVAILABLE,
    IncidentStatus.CANCELLED: AmbulanceStatus.AVAILABLE,
}

#: Which column records the moment a status was entered. Every state on the
#: spine has somewhere to put its timestamp, which is what makes the analytics
#: able to report scene-arrival, load, depart and handover separately instead of
#: inferring four intervals from two columns.
TIMESTAMP_COLUMN: dict[IncidentStatus, str] = {
    IncidentStatus.DISPATCHED: "dispatched_at",
    IncidentStatus.EN_ROUTE: "en_route_at",
    IncidentStatus.AT_SCENE: "scene_arrived_at",
    IncidentStatus.PATIENT_ONBOARD: "patient_onboard_at",
    IncidentStatus.TRANSPORTING: "departed_scene_at",
    IncidentStatus.AT_HOSPITAL: "hospital_arrived_at",
    IncidentStatus.HANDED_OVER: "handed_over_at",
    IncidentStatus.CLOSED: "closed_at",
    IncidentStatus.CANCELLED: "closed_at",
}


class TransitionError(ValueError):
    """Raised for an illegal transition, carrying enough context to explain it."""

    def __init__(self, current: IncidentStatus, requested: IncidentStatus, allowed: tuple[IncidentStatus, ...]):
        self.current = current
        self.requested = requested
        self.allowed = allowed
        super().__init__(
            f"{STATUS_LABELS.get(current, current.value)} → "
            f"{STATUS_LABELS.get(requested, requested.value)} is not a legal trip transition"
        )


def normalise(value: str | IncidentStatus) -> IncidentStatus:
    """Accept the current spelling, an alias, or an enum member."""
    if isinstance(value, IncidentStatus):
        return value
    cleaned = str(value).strip().lower().replace("-", "_").replace(" ", "_")
    if cleaned in STATUS_ALIASES:
        return STATUS_ALIASES[cleaned]
    try:
        return IncidentStatus(cleaned)
    except ValueError as exc:  # pragma: no cover - FastAPI validates the body first
        raise TransitionError(IncidentStatus.OPEN, IncidentStatus.OPEN, ()) from exc


def allowed_from(status: IncidentStatus) -> tuple[IncidentStatus, ...]:
    return ALLOWED_TRANSITIONS.get(status, ())


def can_transition(current: IncidentStatus, requested: IncidentStatus) -> bool:
    return requested in allowed_from(current)


def assert_transition(current: IncidentStatus, requested: IncidentStatus) -> IncidentStatus:
    """Raise unless the move is legal. Returns the normalised target."""
    if current in TERMINAL_STATES and requested in TERMINAL_STATES:
        # Closing an already-closed trip is idempotent rather than an error: a
        # crew screen that retries after a dropped response must not be told it
        # did something wrong.
        return current
    if not can_transition(current, requested):
        raise TransitionError(current, requested, allowed_from(current))
    return requested


def apply_timestamps(incident: Incident, status: IncidentStatus, when: datetime) -> list[str]:
    """Stamp the moment this state was entered, and *only* if it is new.

    Re-entering a state must not overwrite the original timestamp. The reason is
    that these columns are the measurement: scene arrival is `scene_arrived_at`,
    and a duplicate call that silently rewrote it would corrupt the response-time
    series for that incident without any error surfacing.
    """
    column = TIMESTAMP_COLUMN.get(status)
    written: list[str] = []
    if column and getattr(incident, column, None) is None:
        setattr(incident, column, when)
        written.append(column)
    if status is IncidentStatus.AT_SCENE and incident.arrived_at is None:
        # Legacy column, kept in step for the SLA report and older exports.
        incident.arrived_at = when
    if status in TERMINAL_STATES and incident.closed_at is None:
        incident.closed_at = when
    return written


def intervals(incident: Incident) -> dict[str, float | None]:
    """Derived durations, in seconds, for the analytics layer.

    Named for what they measure rather than for the two endpoints they are
    computed from, because "arrived_at - created_at" was being reported as
    "arrival minutes" while actually covering the whole period from the call to
    the crew parking at the scene -- including dispatch time, which is a
    different operational problem. Splitting it is what makes the numbers
    actionable.
    """

    def gap(start: str, end: str) -> float | None:
        a = getattr(incident, start, None)
        b = getattr(incident, end, None)
        return (b - a).total_seconds() if a and b else None

    return {
        "call_to_dispatch_seconds": gap("created_at", "dispatched_at"),
        "dispatch_to_scene_seconds": gap("dispatched_at", "scene_arrived_at"),
        "scene_to_load_seconds": gap("scene_arrived_at", "patient_onboard_at"),
        "load_to_depart_seconds": gap("patient_onboard_at", "departed_scene_at"),
        "transport_seconds": gap("departed_scene_at", "hospital_arrived_at"),
        "handover_seconds": gap("hospital_arrived_at", "handed_over_at"),
        "total_seconds": gap("created_at", "handed_over_at"),
    }
