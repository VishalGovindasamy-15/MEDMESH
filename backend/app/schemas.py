"""Request/response contracts.

Only inputs are modelled strictly. Read responses are assembled by the routers
from the live projection and returned as plain dicts, because a portal grid and a
dispatcher table want different shapes from the same underlying facility and
forcing both through one response model produces the kind of compromised schema
that leaks into clients and never comes out.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from .services.geo import TN_BOUNDS
from .models import (
    Bleeding,
    ConnectorKind,
    EdCongestion,
    Hazard,
    HospitalType,
    IncidentCategory,
    IntegrationMode,
    LocationSource,
    Mechanism,
    ObservationFlag,
    PatientState,
    Urgency,
    UserRole,
    VerificationStatus,
)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=160)
    password: str = Field(min_length=6, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: dict[str, Any]


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=2, max_length=120)
    phone: str | None = Field(default=None, max_length=20)
    role: UserRole = UserRole.CITIZEN
    hospital_id: int | None = None
    district_id: int | None = None

    @field_validator("password")
    @classmethod
    def _strength(cls, v: str) -> str:
        if v.isdigit() or v.isalpha():
            raise ValueError("Password must mix letters with digits or symbols")
        return v


class RefreshRequest(BaseModel):
    refresh_token: str


# --------------------------------------------------------------------------- #
# Ingestion
# --------------------------------------------------------------------------- #


class CapacityPush(BaseModel):
    """Payload accepted from an HL7-FHIR / vendor connector or the manual
    dashboard. Field names are MedMesh-canonical; the connector layer is
    responsible for mapping vendor codes onto them."""

    model_config = ConfigDict(extra="forbid")

    beds_available: int = Field(ge=0, le=5000)
    icu_available: int = Field(ge=0, le=1000)
    ventilators_available: int = Field(ge=0, le=1000)
    ed_congestion: EdCongestion = EdCongestion.MODERATE
    ed_waiting: int = Field(default=0, ge=0, le=400)
    blood_units: int = Field(default=0, ge=0, le=2000)
    antivenom_vials: int = Field(default=0, ge=0, le=500)
    source: IntegrationMode | None = None
    note: str | None = Field(default=None, max_length=200)


class QuickAdjust(BaseModel):
    """The '+1 bed freed' keypad path from §6.2. Bypasses full-form entry during
    a busy shift; the server transcribes it into a full record so the ingest
    pipeline and trust engine see one shape only."""

    model_config = ConfigDict(extra="forbid")

    deltas: dict[str, int] = Field(default_factory=dict)
    ed_congestion: EdCongestion | None = None
    ed_waiting_delta: int | None = Field(default=None, ge=-200, le=200)

    @field_validator("deltas")
    @classmethod
    def _known_keys(cls, v: dict[str, int]) -> dict[str, int]:
        allowed = {"beds_available", "icu_available", "ventilators_available", "blood_units", "antivenom_vials"}
        bad = set(v) - allowed
        if bad:
            raise ValueError(f"Unsupported adjustment key(s): {sorted(bad)}")
        return v


class HospitalCreate(BaseModel):
    slug: str = Field(min_length=3, max_length=64, pattern=r"^[a-z0-9-]+$")
    name: str = Field(min_length=3, max_length=160)
    short_name: str = Field(min_length=2, max_length=40)
    type: HospitalType
    district_id: int
    address: str = Field(max_length=240)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    contact_phone: str = Field(max_length=32)
    emergency_phone: str | None = Field(default=None, max_length=32)
    total_beds: int = Field(ge=1, le=5000)
    total_icu: int = Field(ge=0, le=1000)
    total_ventilators: int = Field(ge=0, le=1000)
    integration: IntegrationMode
    source_system: str | None = Field(default=None, max_length=60)
    specialties: list[str] = Field(default_factory=list)
    has_blood_bank: bool = False
    has_trauma_centre: bool = False
    has_cath_lab: bool = False
    has_burn_unit: bool = False
    has_dialysis: bool = False
    has_neonatal_icu: bool = False


# --------------------------------------------------------------------------- #
# Doctors
# --------------------------------------------------------------------------- #


class DoctorCreate(BaseModel):
    """A clinician entering the roster.

    `registration_no` was required, which made the roster unusable in the field:
    a bed-control clerk adding the surgeon on call has the name and the
    specialty, and the registration number is in a file somewhere. It is now
    optional, and a missing one is recorded as such rather than being invented —
    the directory does not publish it, so the cost of not having it is zero and
    the cost of blocking on it was that the roster stayed empty.

    `department` and `shift` also became optional with sensible derivations, and
    `shift_window` is accepted directly because that is the string the roster
    screen displays.
    """

    model_config = ConfigDict(extra="forbid")

    hospital_id: int
    full_name: str = Field(min_length=2, max_length=120)
    registration_no: str | None = Field(default=None, max_length=32)
    specialty: str = Field(min_length=2, max_length=60)
    department: str | None = Field(default=None, max_length=80)
    designation: str = Field(default="Consultant", max_length=60)
    shift: Literal["morning", "afternoon", "night", "on_call"] = "morning"
    shift_window: str | None = Field(default=None, max_length=32)
    accepts_emergency: bool = True
    on_duty: bool = False
    languages: str = Field(default="Tamil, English", max_length=80)


class DoctorUpdate(BaseModel):
    """Partial roster edit. Specialty is the field that matters most — the
    matching chain starts there — so it is validated the same way on update as
    on create."""

    model_config = ConfigDict(extra="forbid")

    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    registration_no: str | None = Field(default=None, max_length=32)
    specialty: str | None = Field(default=None, min_length=2, max_length=60)
    department: str | None = Field(default=None, max_length=80)
    designation: str | None = Field(default=None, max_length=60)
    shift: Literal["morning", "afternoon", "night", "on_call"] | None = None
    shift_window: str | None = Field(default=None, max_length=32)
    accepts_emergency: bool | None = None
    on_duty: bool | None = None
    languages: str | None = Field(default=None, max_length=80)


class DoctorDutyUpdate(BaseModel):
    on_duty: bool
    duty_end: datetime | None = None


# --------------------------------------------------------------------------- #
# Incidents & dispatch
# --------------------------------------------------------------------------- #


class IncidentCreate(BaseModel):
    """Incident intake.

    There is deliberately no free-text clinical field. Everything a call-taker
    records is a member of a closed set, which is what makes the no-patient-data
    rule structural rather than a filter: a field that cannot hold a sentence
    cannot hold a name. The single exception is `landmark`, which describes a
    place, because the crew has to be able to find the scene.

    Unknown keys are forbidden rather than ignored. Pydantic's default is to
    drop them, which would make a client that still sends the old
    `caller_notes` field appear to work while its contents vanish — and the
    operator would have no way to tell that the note they typed was never
    stored. A 422 is the honest answer.
    """

    model_config = ConfigDict(extra="forbid")

    category: IncidentCategory
    urgency: Urgency = Urgency.P1
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    landmark: str = Field(min_length=3, max_length=200)
    district_id: int

    # Where the coordinate came from, and the two supporting place fields the
    # intake design asks for. All optional so that a caller which predates them
    # still works, but the console always fills them.
    location_source: LocationSource = LocationSource.MAP
    taluk: str | None = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def _location_is_plausible(self) -> "IncidentCreate":
        """Reject coordinates outside Tamil Nadu.

        Not a substitute for a geocoder -- it is a guard against the failure that
        actually happens: a stray decimal place, or a latitude copied where a
        longitude belonged. Both put the scene in the Bay of Bengal or in
        Kerala, and the matching engine would dutifully rank hospitals by the
        drive time to the wrong one.
        """
        if not (TN_BOUNDS["lat_min"] <= self.lat <= TN_BOUNDS["lat_max"]):
            raise ValueError(
                f"latitude {self.lat:.4f} is outside Tamil Nadu "
                f"({TN_BOUNDS['lat_min']}-{TN_BOUNDS['lat_max']})"
            )
        if not (TN_BOUNDS["lng_min"] <= self.lng <= TN_BOUNDS["lng_max"]):
            raise ValueError(
                f"longitude {self.lng:.4f} is outside Tamil Nadu "
                f"({TN_BOUNDS['lng_min']}-{TN_BOUNDS['lng_max']})"
            )
        if self.location_source == LocationSource.DISTRICT:
            # Permitted, because a call from a landline with the caller unable
            # to say where they are is a real call and refusing it would be
            # worse than dispatching on an approximate fix. But it is recorded
            # as approximate so nobody later mistakes it for a survey.
            pass
        return self

    # Scene assessment — all closed enums, see models.py.
    patient_state: PatientState = PatientState.UNKNOWN
    mechanism: Mechanism = Mechanism.NONE
    bleeding: Bleeding = Bleeding.NONE
    hazard: Hazard = Hazard.NONE
    observations: list[ObservationFlag] = Field(default_factory=list, max_length=8)
    casualty_count: int = Field(default=1, ge=1, le=50)
    trapped: bool = False
    bystander_cpr: bool = False

    # Resource requirements. These default to being derived from the scene
    # assessment in the router, so an operator who ticks "unconscious, not
    # breathing" gets an ICU+ventilator request without having to reason about
    # it; an explicit value here overrides the derivation.
    requires_icu: bool | None = None
    requires_ventilator: bool | None = None
    requires_blood: bool | None = None
    required_specialty: str | None = Field(default=None, max_length=60)

    @field_validator("landmark")
    @classmethod
    def _landmark_is_a_place(cls, v: str) -> str:
        """A last structural guard on the one field that is not an enum.

        The previous version pattern-matched a list of banned substrings
        ("name:", "aadhaar", …) against free text and rejected a match. That can
        only ever catch what somebody thought to list. Now that every clinical
        field is an enum, the only way an identifier can enter the system is
        through the landmark, so the check is narrow enough to be worth having:
        a digit-run of six or more is a phone number in this context, never an
        address, and honourifics precede a person's name.
        """
        if re.search(r"\d{6,}", v):
            raise ValueError(
                "Landmark must describe a place, not a person — remove the number sequence"
            )
        lowered = v.lower()
        if any(b in lowered for b in ("mr ", "mrs ", "ms ", "patient", "name:", "aadhaar", "aadhar")):
            raise ValueError("Landmark must describe a place, not a person")
        return v


class DispatchRequest(BaseModel):
    hospital_id: int
    ambulance_id: int | None = None
    hold_resource: Literal["bed", "icu", "ventilator"] | None = None
    hold_seconds: int = Field(default=900, ge=120, le=3600)
    override_reason: str | None = Field(default=None, max_length=200)


# --------------------------------------------------------------------------- #
# Connectors & onboarding
# --------------------------------------------------------------------------- #


class ConnectorCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hospital_id: int
    kind: ConnectorKind
    source_system: str = Field(default="", max_length=80)


class ConnectorKeyRotate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=200)


class NotificationAck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str | None = Field(default=None, max_length=40)


class FacilityApplication(BaseModel):
    """Public facility onboarding application (§6.10).

    Carries the facility's operational facts and nothing about any patient: a
    hospital applying to join the network describes itself, not its caseload.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=3, max_length=160)
    short_name: str = Field(default="", max_length=20)
    type: HospitalType
    district_id: int
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    address: str = Field(default="", max_length=200)

    total_beds: int = Field(ge=0, le=5000)
    total_icu: int = Field(ge=0, le=2000)
    total_ventilators: int = Field(ge=0, le=1000)
    specialties: list[str] = Field(default_factory=list, max_length=24)

    has_blood_bank: bool = False
    has_trauma_centre: bool = False

    # An onboarding contact, not a patient contact. This is the one place a
    # phone number legitimately belongs in the system, and it is stored against
    # the facility rather than any individual.
    contact_phone: str = Field(min_length=6, max_length=20)
    emergency_phone: str = Field(default="", max_length=20)
    contact_email: EmailStr | None = None

    has_existing_system: bool = False


class FacilityDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hospital_id: int
    decision: Literal["verify", "refuse"]
    integration: IntegrationMode | None = None
    connector_kind: ConnectorKind | None = None
    specialties: list[str] = Field(default_factory=list, max_length=24)
    note: str | None = Field(default=None, max_length=300)


class HoldRequest(BaseModel):
    """A manual hold placed from the console, independent of a dispatch."""

    resource: Literal["bed", "icu", "ventilator"] = "bed"
    seconds: int = Field(default=900, ge=120, le=3600)
    incident_id: int | None = Field(
        default=None,
        description="Incident the hold is reserved for, when one is already open",
    )


class StatusUpdate(BaseModel):
    """A crew or dispatcher advancing the trip.

    The full lifecycle vocabulary is accepted here, including the deprecated
    `arrived` spelling, which is normalised rather than rejected so that an older
    installed build does not start failing after a server upgrade.
    """

    status: Literal[
        "dispatched",
        "en_route",
        "at_scene",
        "patient_onboard",
        "transporting",
        "at_hospital",
        "handed_over",
        "closed",
        "cancelled",
        "arrived",  # deprecated alias for at_scene
    ]
    note: str | None = Field(default=None, max_length=200)
    #: Optional crew-reported position, so the map does not have to wait for the
    #: separate location ping. Ignored for non-crew callers.
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class AmbulanceLocationUpdate(BaseModel):
    """A position fix from a crew phone.

    Bounded, and bounded to the state, for the same reason `IncidentCreate` is:
    a transposed coordinate or a stray decimal place otherwise moves a vehicle
    onto the console's map somewhere it is not. `StatusUpdate` already carried
    these bounds; this one did not, so a handset with a broken GNSS could and did
    paste `lat: 95.0` into the fleet.
    """

    lat: float = Field(ge=TN_BOUNDS["lat_min"], le=TN_BOUNDS["lat_max"])
    lng: float = Field(ge=TN_BOUNDS["lng_min"], le=TN_BOUNDS["lng_max"])


# --------------------------------------------------------------------------- #
# Governance
# --------------------------------------------------------------------------- #


class FeedbackCreate(BaseModel):
    hospital_id: int
    kind: Literal["beds_unavailable", "wrong_hours", "closed", "wrong_contact", "other"]
    comment: str = Field(default="", max_length=400)
    incident_id: int | None = None
    reporter_role: str = "citizen"


class FeedbackResolve(BaseModel):
    status: Literal["under_review", "upheld", "dismissed"]
    resolution_note: str | None = Field(default=None, max_length=300)


class VerificationUpdate(BaseModel):
    status: VerificationStatus
    note: str | None = Field(default=None, max_length=200)


class SurgeCreate(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    district_id: int
    scope: Literal["district", "state"] = "district"
    note: str = Field(default="", max_length=300)


class ReportQuery(BaseModel):
    district_id: int | None = None
    from_ts: datetime | None = None
    to_ts: datetime | None = None
    format: Literal["csv", "json"] = "csv"


# --------------------------------------------------------------------------- #
# Fleet
#
# Ambulance management did not exist as an API at all: the fleet was created by
# the seed script and never editable afterwards. That is why a driver could be an
# account with no vehicle and no way for anyone to fix it -- the only path was to
# re-run the seeder. These models make a vehicle and its crew ordinary
# administrative records.
# --------------------------------------------------------------------------- #


class AmbulanceCreate(BaseModel):
    call_sign: str = Field(min_length=3, max_length=24)
    registration: str = Field(min_length=3, max_length=16)
    operator_type: Literal["108", "private"] = "108"
    operator_name: str = Field(min_length=2, max_length=80)
    base_district_id: int
    capabilities: list[Literal["bls", "als", "nicu", "mortuary"]] = Field(default_factory=lambda: ["bls"])
    status: Literal["available", "out_of_service"] = "available"
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class AmbulanceUpdate(BaseModel):
    """Every field optional: a partial edit is the common case (a unit is
    re-based, or its capability changes on refit) and requiring the full body
    would make the caller responsible for not clobbering the rest."""

    call_sign: str | None = Field(default=None, min_length=3, max_length=24)
    registration: str | None = Field(default=None, min_length=3, max_length=16)
    operator_type: Literal["108", "private"] | None = None
    operator_name: str | None = Field(default=None, min_length=2, max_length=80)
    base_district_id: int | None = None
    capabilities: list[Literal["bls", "als", "nicu", "mortuary"]] | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class AmbulanceCrewAssign(BaseModel):
    """Link or unlink the driver account. `driver_user_id: null` unassigns.

    Explicit null rather than a separate DELETE so that "this vehicle now has no
    crew" is expressible in the same call that expresses "this vehicle now has
    that crew", which is what a form actually does.
    """

    driver_user_id: int | None = None
    reason: str | None = Field(default=None, max_length=200)


class AmbulanceStatusUpdate(BaseModel):
    status: Literal["available", "out_of_service"]
    reason: str | None = Field(default=None, max_length=200)


class FacilityResponse(BaseModel):
    """A receiving facility answering an inbound alert.

    Structured rather than free text, for the same reason incident intake is:
    the reply has to be actioned by software (release the hold, re-open the
    shortlist, tell the crew) and a sentence cannot be. `reason` is an enum and
    becomes part of the reroute suggestion.
    """

    model_config = ConfigDict(extra="forbid")

    response: Literal["accepted", "declined"]
    reason: Literal[
        "no_bed",
        "no_icu",
        "no_ventilator",
        "no_specialist",
        "theatre_unavailable",
        "diversion",
        "other",
    ] | None = None
    note: str | None = Field(default=None, max_length=200)
