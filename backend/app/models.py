"""Operational data model.

Design constraint carried straight from the architecture report: this schema has
no place to put a patient. There is no patient table, no MRN, no diagnosis field
and no free-text clinical note column. Incident records carry only a
non-identifying category and a location. That is enforced structurally, not by
policy, so a future feature cannot accidentally leak PHI through an existing
column.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def enum_col(enum_cls, **kwargs):
    """Persist enum *values* (``"public"``, ``"manual"``), not member names.

    Two reasons, both practical: the raw column reads correctly in psql during an
    incident, and an export or warehouse load does not need a lookup table to
    turn ``HOSPITAL_ADMIN`` back into something a human recognises.
    """
    return Enum(enum_cls, values_callable=lambda e: [m.value for m in e], **kwargs)


class UserRole(str, enum.Enum):
    CITIZEN = "citizen"
    DISPATCHER = "dispatcher"  # 108 call-taker / console operator
    DRIVER = "driver"  # ambulance crew
    HOSPITAL_ADMIN = "hospital_admin"
    GOV_OFFICIAL = "gov_official"
    PLATFORM_ADMIN = "platform_admin"


class HospitalType(str, enum.Enum):
    PUBLIC = "public"
    PRIVATE = "private"
    TRUST = "trust"  # charitable / mission hospitals


class VerificationStatus(str, enum.Enum):
    UNVERIFIED = "unverified"
    PENDING = "pending"
    VERIFIED = "verified"
    SUSPENDED = "suspended"


class IntegrationMode(str, enum.Enum):
    API = "api"  # HL7-FHIR or vendor REST connector
    MANUAL = "manual"  # staff keypad, no hospital IT required


class EdCongestion(str, enum.Enum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


class LocationSource(str, enum.Enum):
    """How the incident coordinate was obtained.

    Distinct from the coordinate itself because the two are not equally
    trustworthy and the difference has to survive to the dispatcher's screen and
    to any later review. A handset fix is accurate to tens of metres; a
    district-centre fallback can be sixty kilometres out. Storing only a pair of
    floats made those indistinguishable, which is how a call from Pollachi came
    to be dispatched as though it had come from the middle of Coimbatore.
    """

    GPS = "gps"  # caller's handset reported a position
    MAP = "map"  # operator placed the pin on the map during the call
    MANUAL = "manual"  # operator resolved a spoken address to a point
    DISTRICT = "district"  # district centre only -- approximate, flagged in the UI


class IncidentStatus(str, enum.Enum):
    """The trip's position in the ambulance lifecycle.

    The previous vocabulary had five states for a seven-stage journey, and one of
    them -- `arrived` -- meant "the crew is at the scene" in the backend while the
    driver app's screen used the same word for "the patient is in the vehicle".
    Two stages were therefore unrepresentable, and the ward's countdown started
    against the wrong event.

    `ARRIVED` is retained as a value because it exists in stored data and in
    older client payloads, but it is never written by the current code: the
    lifecycle normalises it to `AT_SCENE` on the way in. See
    app/services/lifecycle.py for the transition table.
    """

    OPEN = "open"
    DISPATCHED = "dispatched"
    EN_ROUTE = "en_route"
    AT_SCENE = "at_scene"
    PATIENT_ONBOARD = "patient_onboard"
    TRANSPORTING = "transporting"
    AT_HOSPITAL = "at_hospital"
    HANDED_OVER = "handed_over"
    CLOSED = "closed"
    CANCELLED = "cancelled"

    ARRIVED = "arrived"  # deprecated: read as AT_SCENE


class IncidentCategory(str, enum.Enum):
    """Non-clinical triage buckets. Deliberately coarse -- enough to pick a
    destination, not enough to identify a person."""

    ROAD_ACCIDENT = "road_accident"
    CARDIAC = "cardiac"
    STROKE = "stroke"
    OBSTETRIC = "obstetric"
    PAEDIATRIC = "paediatric"
    BURNS = "burns"
    TRAUMA_FALL = "trauma_fall"
    SNAKEBITE = "snakebite"
    POISONING = "poisoning"
    RESPIRATORY = "respiratory"
    DIALYSIS = "dialysis"
    OTHER = "other"


class PatientState(str, enum.Enum):
    """Observed condition at the scene, in the coarsest useful terms.

    These are observations a caller can report over the phone, not a clinical
    assessment and not an identity. Deliberately ordinal and small: an operator
    under pressure picks one of five, and the value drives what the matching
    engine requires (an unbreathing patient needs advanced life support and a
    ventilator, not a general bed).
    """

    ALERT = "alert"  # conscious and talking
    DROWSY = "drowsy"  # conscious but not fully responsive
    UNCONSCIOUS_BREATHING = "unconscious_breathing"
    UNCONSCIOUS_NOT_BREATHING = "unconscious_not_breathing"
    UNKNOWN = "unknown"


class Mechanism(str, enum.Enum):
    """How the injury happened. Only meaningful for trauma categories, but
    stored for all so the operator does not have to branch while typing."""

    NONE = "none"
    TWO_WHEELER = "two_wheeler"
    CAR = "car"
    PEDESTRIAN = "pedestrian"
    HEAVY_VEHICLE = "heavy_vehicle"
    FALL_LOW = "fall_low"
    FALL_HEIGHT = "fall_height"
    ASSAULT = "assault"
    MACHINERY = "machinery"
    OTHER = "other"


class Bleeding(str, enum.Enum):
    NONE = "none"
    MINOR = "minor"
    SEVERE = "severe"  # visible major haemorrhage — drives the blood requirement


class Hazard(str, enum.Enum):
    """Scene hazards. Not about the patient at all: they change what the crew
    needs and whether a facility must be warned before the ambulance arrives."""

    NONE = "none"
    TRAFFIC_ACTIVE = "traffic_active"
    FIRE = "fire"
    CHEMICAL = "chemical"
    ELECTRICAL = "electrical"
    CONFINED_SPACE = "confined_space"


class ObservationFlag(str, enum.Enum):
    """Structured presentation flags. A checklist, not a sentence -- an
    operator ticks what the caller said instead of transcribing it, which is
    both faster and the reason no narrative field needs to exist."""

    CHEST_PAIN = "chest_pain"
    BREATHLESSNESS = "breathlessness"
    SEIZURE = "seizure"
    PARALYSIS_ONE_SIDE = "paralysis_one_side"
    SLURRED_SPEECH = "slurred_speech"
    SEVERE_HEADACHE = "severe_headache"
    ABDOMINAL_PAIN = "abdominal_pain"
    VOMITING = "vomiting"
    FEVER = "fever"
    BURNS_SURFACE = "burns_surface"
    INHALATION_SMOKE = "inhalation_smoke"
    SNAKEBITE_SWELLING = "snakebite_swelling"
    SUSPECTED_FRACTURE = "suspected_fracture"
    LIMB_DEFORMITY = "limb_deformity"
    OBSTETRIC_LABOUR = "obstetric_labour"
    POSTPARTUM_BLEEDING = "postpartum_bleeding"
    DIALYSIS_MISSED = "dialysis_missed"
    POISON_INGESTED = "poison_ingested"


class Urgency(str, enum.Enum):
    P1 = "P1"  # immediate / lights and siren
    P2 = "P2"  # urgent
    P3 = "P3"  # stable transfer


class AmbulanceStatus(str, enum.Enum):
    AVAILABLE = "available"
    ASSIGNED = "assigned"
    EN_ROUTE = "en_route"
    AT_SCENE = "at_scene"
    TRANSPORTING = "transporting"
    OUT_OF_SERVICE = "out_of_service"


class HoldStatus(str, enum.Enum):
    ACTIVE = "active"
    CONSUMED = "consumed"
    EXPIRED = "expired"
    RELEASED = "released"
    BUSTED = "busted"  # hospital's own system consumed the bed first


class ConnectorKind(str, enum.Enum):
    """What a facility's own system speaks. Drives which ingress a connector
    posts to, and what the setup page tells the integrator to configure."""

    FHIR_R4 = "fhir_r4"  # HL7 FHIR R4 Bundle (MeasureReport / Location)
    VENDOR_REST = "vendor_rest"  # vendor-specific JSON, mapped field by field
    CSV_SFTP = "csv_sftp"  # scheduled file drop, parsed on arrival
    MANUAL = "manual"  # no upstream system; staff key numbers in


class NotificationKind(str, enum.Enum):
    """Everything that lands in a facility's or an operator's inbox."""

    INBOUND_PATIENT = "inbound_patient"  # two-way prep alert from dispatch
    HOLD_PLACED = "hold_placed"
    HOLD_EXPIRING = "hold_expiring"
    HOLD_RELEASED = "hold_released"
    STALENESS_REMINDER = "staleness_reminder"  # §6.2 nudge to update
    AUTH_PASSWORD_RESET = "auth_password_reset"  # reset link issued
    SUBMISSION_QUARANTINED = "submission_quarantined"
    FEEDBACK_RAISED = "feedback_raised"
    VERIFICATION_DECIDED = "verification_decided"
    SURGE_OPENED = "surge_opened"
    SURGE_CLOSED = "surge_closed"
    CONNECTOR_FAILING = "connector_failing"


class FeedbackStatus(str, enum.Enum):
    OPEN = "open"
    UNDER_REVIEW = "under_review"
    UPHELD = "upheld"
    DISMISSED = "dismissed"


# --------------------------------------------------------------------------- #
# Reference / directory
# --------------------------------------------------------------------------- #


class District(Base):
    __tablename__ = "districts"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(12), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    name_ta: Mapped[str | None] = mapped_column(String(120))  # Tamil label
    state: Mapped[str] = mapped_column(String(60), default="Tamil Nadu")
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    population: Mapped[int] = mapped_column(Integer, default=0)

    hospitals: Mapped[list["Hospital"]] = relationship(back_populates="district")


class Hospital(Base):
    __tablename__ = "hospitals"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    short_name: Mapped[str] = mapped_column(String(40))
    type: Mapped[HospitalType] = mapped_column(enum_col(HospitalType))
    district_id: Mapped[int] = mapped_column(ForeignKey("districts.id"))
    address: Mapped[str] = mapped_column(String(240))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)

    verification: Mapped[VerificationStatus] = mapped_column(
        Enum(VerificationStatus), default=VerificationStatus.UNVERIFIED
    )
    integration: Mapped[IntegrationMode] = mapped_column(enum_col(IntegrationMode))
    source_system: Mapped[str | None] = mapped_column(String(60))  # HL7-FHIR / TeleTracking / ...
    contact_phone: Mapped[str] = mapped_column(String(32))
    emergency_phone: Mapped[str | None] = mapped_column(String(32))

    # Declared capacity. `beds` here is the *total*, availability lives on
    # CapacityRecord so we keep a full history for the analytics warehouse.
    total_beds: Mapped[int] = mapped_column(Integer)
    total_icu: Mapped[int] = mapped_column(Integer)
    total_ventilators: Mapped[int] = mapped_column(Integer)

    specialties: Mapped[str] = mapped_column(Text, default="")  # comma list, indexed by search
    has_blood_bank: Mapped[bool] = mapped_column(Boolean, default=False)
    has_trauma_centre: Mapped[bool] = mapped_column(Boolean, default=False)
    has_cath_lab: Mapped[bool] = mapped_column(Boolean, default=False)
    has_burn_unit: Mapped[bool] = mapped_column(Boolean, default=False)
    has_dialysis: Mapped[bool] = mapped_column(Boolean, default=False)
    has_neonatal_icu: Mapped[bool] = mapped_column(Boolean, default=False)
    antivenom_stock: Mapped[int] = mapped_column(Integer, default=0)

    # Commercial: private hospitals may opt out of doctor-level exposure.
    expose_doctor_directory: Mapped[bool] = mapped_column(Boolean, default=True)

    onboarding_completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    district: Mapped[District] = relationship(back_populates="hospitals")
    capacity: Mapped[list["CapacityRecord"]] = relationship(
        back_populates="hospital", order_by="CapacityRecord.recorded_at.desc()"
    )
    doctors: Mapped[list["Doctor"]] = relationship(back_populates="hospital")

    __table_args__ = (Index("ix_hospitals_district_type", "district_id", "type"),)


class CapacityRecord(Base):
    """Append-only capacity snapshot. Never updated in place -- the live store is
    a projection of the newest row per hospital, and the analytics warehouse
    consumes the whole series."""

    __tablename__ = "capacity_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"), index=True)

    beds_available: Mapped[int] = mapped_column(Integer)
    icu_available: Mapped[int] = mapped_column(Integer)
    ventilators_available: Mapped[int] = mapped_column(Integer)
    ed_congestion: Mapped[EdCongestion] = mapped_column(enum_col(EdCongestion))
    # Waiting-room headcount is the single best leading indicator of ED collapse
    # and it costs nothing to collect.
    ed_waiting: Mapped[int] = mapped_column(Integer, default=0)

    blood_units: Mapped[int] = mapped_column(Integer, default=0)
    antivenom_vials: Mapped[int] = mapped_column(Integer, default=0)

    # Provenance
    source: Mapped[IntegrationMode] = mapped_column(enum_col(IntegrationMode))
    reported_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    # Trust engine verdict, computed at ingest time and stored so the audit
    # trail can be replayed exactly as it was served.
    trust_state: Mapped[str] = mapped_column(String(16), default="live")
    anomaly_flags: Mapped[str] = mapped_column(Text, default="")  # JSON array
    quarantined: Mapped[bool] = mapped_column(Boolean, default=False)

    hospital: Mapped[Hospital] = relationship(back_populates="capacity")

    __table_args__ = (Index("ix_capacity_hospital_recorded", "hospital_id", "recorded_at"),)


class Doctor(Base):
    __tablename__ = "doctors"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"), index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    # Nullable, because the field is not always to hand when a clinician is
    # added: a bed-control clerk knows the name and the specialty and the
    # registration number is in a filing cabinet. The directory does not publish
    # it, so the cost of its absence is zero -- whereas requiring it meant the
    # roster simply stayed empty.
    registration_no: Mapped[str | None] = mapped_column(String(32))  # TNMC registration
    specialty: Mapped[str] = mapped_column(String(60), index=True)
    department: Mapped[str] = mapped_column(String(80))
    designation: Mapped[str] = mapped_column(String(60))
    on_duty: Mapped[bool] = mapped_column(Boolean, default=False)
    duty_start: Mapped[datetime | None] = mapped_column(DateTime)
    duty_end: Mapped[datetime | None] = mapped_column(DateTime)
    # Shift pattern drives the automatic on-duty flip when a hospital does not
    # use roster integration.
    shift: Mapped[str] = mapped_column(String(16), default="morning")
    #: Free-form override for the shift band. The shift enum is coarse (morning /
    #: afternoon / night) and real rosters are not: "07:30 – 13:30" is a normal
    #: way to describe a duty period, and forcing it into one of four buckets
    #: loses information the ward clerk took the trouble to record. Null means
    #: "use the bucket", so existing rows read unchanged.
    shift_window: Mapped[str | None] = mapped_column(String(32))
    accepts_emergency: Mapped[bool] = mapped_column(Boolean, default=True)
    languages: Mapped[str] = mapped_column(String(80), default="Tamil, English")
    last_toggled_at: Mapped[datetime | None] = mapped_column(DateTime)

    hospital: Mapped[Hospital] = relationship(back_populates="doctors")

    __table_args__ = (Index("ix_doctors_specialty_duty", "specialty", "on_duty"),)


# --------------------------------------------------------------------------- #
# Emergency workflow
# --------------------------------------------------------------------------- #


class Ambulance(Base):
    __tablename__ = "ambulances"

    id: Mapped[int] = mapped_column(primary_key=True)
    call_sign: Mapped[str] = mapped_column(String(24), unique=True)  # e.g. "108-TN37-4412"
    registration: Mapped[str] = mapped_column(String(16))
    operator_type: Mapped[str] = mapped_column(String(16), default="108")  # 108 | private
    operator_name: Mapped[str] = mapped_column(String(80))
    base_district_id: Mapped[int] = mapped_column(ForeignKey("districts.id"))
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    status: Mapped[AmbulanceStatus] = mapped_column(enum_col(AmbulanceStatus), default=AmbulanceStatus.AVAILABLE)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    capabilities: Mapped[str] = mapped_column(String(80), default="bls")  # bls | als | nicu | mortuary
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    __table_args__ = (
        # One driver, one active vehicle. A partial unique index rather than a
        # plain one because most vehicles have no linked driver, and the rule is
        # about *links*, not about rows: a null driver_id means "crew unassigned"
        # and any number of vehicles may be in that state.
        #
        # This was previously only implied -- `ambulance_for_user` used
        # `scalar_one_or_none`, which reads as if the invariant held but raises
        # the moment it does not. Expressing it in the schema means the database
        # refuses the bad state instead of the driver's screen discovering it.
        Index(
            "uq_ambulance_driver",
            "driver_id",
            unique=True,
            sqlite_where=text("driver_id IS NOT NULL"),
            postgresql_where=text("driver_id IS NOT NULL"),
        ),
    )


class Incident(Base):
    """A dispatch request. Contains no patient identifiers by construction."""

    __tablename__ = "incidents"

    id: Mapped[int] = mapped_column(primary_key=True)
    reference: Mapped[str] = mapped_column(String(20), unique=True)  # e.g. "TN-2609-0417"
    category: Mapped[IncidentCategory] = mapped_column(enum_col(IncidentCategory))
    urgency: Mapped[Urgency] = mapped_column(enum_col(Urgency), default=Urgency.P1)

    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    # `landmark` is a place the crew drives to, not a person. It is the one free
    # text field on this table and the only one that has to be, because
    # "Avinashi Road, opposite the bus depot" cannot be enumerated in advance.
    landmark: Mapped[str] = mapped_column(String(200))
    district_id: Mapped[int] = mapped_column(ForeignKey("districts.id"))
    # Taluk and landmark are supporting information for the crew, which is what
    # the intake design asks for: the coordinate leads, the words confirm it.
    # Both name a place, never a person, so they fit the no-patient-data rule
    # for the same reason `landmark` does.
    taluk: Mapped[str | None] = mapped_column(String(80))
    location_source: Mapped[LocationSource] = mapped_column(
        enum_col(LocationSource), default=LocationSource.MAP
    )

    # Structured scene assessment, replacing the previous `caller_notes` free
    # text column. See the enums above: every field is a closed set, so no
    # narrative field exists for an identifier to be typed into. This is
    # enforced by the schema rather than by a keyword filter over a string,
    # which was the earlier approach and could only ever catch what it had been
    # told to look for.
    patient_state: Mapped[PatientState] = mapped_column(
        enum_col(PatientState), default=PatientState.UNKNOWN
    )
    mechanism: Mapped[Mechanism] = mapped_column(enum_col(Mechanism), default=Mechanism.NONE)
    bleeding: Mapped[Bleeding] = mapped_column(enum_col(Bleeding), default=Bleeding.NONE)
    hazard: Mapped[Hazard] = mapped_column(enum_col(Hazard), default=Hazard.NONE)
    casualty_count: Mapped[int] = mapped_column(Integer, default=1)  # patients at the scene
    trapped: Mapped[bool] = mapped_column(Boolean, default=False)  # needs extrication
    bystander_cpr: Mapped[bool] = mapped_column(Boolean, default=False)
    observations: Mapped[str] = mapped_column(String(400), default="")  # comma-joined flags

    required_specialty: Mapped[str | None] = mapped_column(String(60))
    requires_icu: Mapped[bool] = mapped_column(Boolean, default=False)
    requires_ventilator: Mapped[bool] = mapped_column(Boolean, default=False)
    requires_blood: Mapped[bool] = mapped_column(Boolean, default=False)

    status: Mapped[IncidentStatus] = mapped_column(enum_col(IncidentStatus), default=IncidentStatus.OPEN)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    assigned_hospital_id: Mapped[int | None] = mapped_column(ForeignKey("hospitals.id"))
    assigned_ambulance_id: Mapped[int | None] = mapped_column(ForeignKey("ambulances.id"))
    # One column per stage of the trip. The original schema had three
    # timestamps for a seven-stage journey, which forced every analytics
    # question to be answered by subtracting two numbers that each meant more
    # than one thing: "arrival time" was reported as `arrived_at - created_at`
    # and therefore included the dispatch delay, the drive to the scene and the
    # on-scene time without ever separating them.
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime)
    en_route_at: Mapped[datetime | None] = mapped_column(DateTime)
    scene_arrived_at: Mapped[datetime | None] = mapped_column(DateTime)
    patient_onboard_at: Mapped[datetime | None] = mapped_column(DateTime)
    departed_scene_at: Mapped[datetime | None] = mapped_column(DateTime)
    hospital_arrived_at: Mapped[datetime | None] = mapped_column(DateTime)
    handed_over_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Legacy: scene arrival. Kept in step by lifecycle.apply_timestamps so that
    # the SLA report and any stored export keep working, and so that a row
    # written before this change still reads correctly.
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime)

    # The receiving ward's answer. The inbound alert had no reply path, so a
    # facility that could not take the patient had to telephone a control room
    # that had nowhere to record the outcome -- the hold stayed until it expired
    # and the next shortlist still showed the bed as free.
    facility_acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime)
    facility_declined_at: Mapped[datetime | None] = mapped_column(DateTime)
    facility_decline_reason: Mapped[str | None] = mapped_column(String(32))

    # Facilities that have refused this incident, oldest first, as a comma-joined
    # id list. Kept because a decline has to be remembered across the shortlist
    # rebuilds that follow it: the ward that just said "no ICU" is exactly the
    # one the next shortlist would otherwise offer again, and a dispatcher
    # re-routing a P1 should not have to remember which doors are already shut.
    declined_hospital_ids: Mapped[str] = mapped_column(String(200), default="")

    # Ranked shortlist is snapshotted at dispatch time so we can later answer
    # "why was this hospital chosen instead of that one".
    match_snapshot: Mapped[str] = mapped_column(Text, default="")  # JSON


class BedHold(Base):
    """Time-boxed reservation preventing two ambulances converging on one bed."""

    __tablename__ = "bed_holds"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"), index=True)
    incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id"))
    resource: Mapped[str] = mapped_column(String(16))  # bed | icu | ventilator
    status: Mapped[HoldStatus] = mapped_column(enum_col(HoldStatus), default=HoldStatus.ACTIVE)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    released_at: Mapped[datetime | None] = mapped_column(DateTime)
    release_reason: Mapped[str | None] = mapped_column(String(120))


# --------------------------------------------------------------------------- #
# Platform / governance
# --------------------------------------------------------------------------- #


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(20))
    full_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(enum_col(UserRole))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    hospital_id: Mapped[int | None] = mapped_column(ForeignKey("hospitals.id"))
    district_id: Mapped[int | None] = mapped_column(ForeignKey("districts.id"))  # official jurisdiction
    amr_scope: Mapped[str | None] = mapped_column(String(40))  # state | district | facility

    # Forced first-login rotation. An administrator mints the account and hands
    # the password over out of band, so it is a one-time credential by
    # construction; this flag is what makes the "one-time" part enforceable
    # rather than advisory.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime)

    # Password reset. Only the hash of the token is stored -- see
    # app/services/audit.hash_secret -- so that a dump of this table does not
    # contain working reset links.
    reset_token_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    reset_expires_at: Mapped[datetime | None] = mapped_column(DateTime)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)


class AuditLog(Base):
    """Append-only. Every write that touches capacity, dispatch or verification
    lands here with an actor, so disputes are answerable."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    actor_label: Mapped[str] = mapped_column(String(120), default="system")
    actor_role: Mapped[str] = mapped_column(String(32), default="system")
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(40))
    summary: Mapped[str] = mapped_column(String(300), default="")
    payload: Mapped[str] = mapped_column(Text, default="")  # JSON diff
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Feedback(Base):
    """Citizen / crew report that a hospital's published numbers did not match
    reality on arrival. Feeds back into the trust score."""

    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"), index=True)
    incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id"))
    submitted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    reporter_role: Mapped[str] = mapped_column(String(32), default="citizen")
    kind: Mapped[str] = mapped_column(String(32))  # beds_unavailable | wrong_hours | closed | other
    comment: Mapped[str] = mapped_column(String(400), default="")
    status: Mapped[FeedbackStatus] = mapped_column(enum_col(FeedbackStatus), default=FeedbackStatus.OPEN)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    __table_args__ = (UniqueConstraint("hospital_id", "incident_id", name="uq_feedback_incident"),)


class Connector(Base):
    """A facility's live data pipe.

    One per facility. Holds the credential the facility's system authenticates
    with, the shape it speaks, and the operational state an integrator needs to
    debug it without reading the server log. Kept separate from `Hospital`
    because a facility can be re-onboarded onto a different connector without
    touching its directory record, and because the key must be revocable on its
    own.
    """

    __tablename__ = "connectors"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"), unique=True, index=True)
    kind: Mapped[ConnectorKind] = mapped_column(enum_col(ConnectorKind), default=ConnectorKind.MANUAL)

    # Only a hash of the key is stored. The plaintext is shown once at creation,
    # the way an API key should be -- an integrator who loses it gets a new one
    # rather than asking an operator to read out the old one.
    key_prefix: Mapped[str] = mapped_column(String(16), default="")  # e.g. "mm_live_3f9a"
    key_hash: Mapped[str] = mapped_column(String(128), default="")

    source_system: Mapped[str] = mapped_column(String(80), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_status_code: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[str] = mapped_column(String(300), default="")
    accepted_24h: Mapped[int] = mapped_column(Integer, default=0)
    rejected_24h: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime)


class Notification(Base):
    """Operator and facility inbox.

    Every event that requires a human to *do* something ends up here, so a ward
    clerk who is not staring at the dashboard still learns that an ambulance is
    inbound. Deliberately not a generic event log -- that is what the audit
    table is for; this is a worklist, and it is dismissible.
    """

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[NotificationKind] = mapped_column(enum_col(NotificationKind), index=True)

    # Addressed to either a facility or a specific user, never both.
    hospital_id: Mapped[int | None] = mapped_column(ForeignKey("hospitals.id"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)

    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(String(500), default="")
    severity: Mapped[str] = mapped_column(String(16), default="info")  # info | warm | critical

    incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id"))
    hospital_ref: Mapped[int | None] = mapped_column(Integer)  # subject facility, when it differs
    payload: Mapped[str] = mapped_column(String(1000), default="")  # JSON

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime)
    acknowledged_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class SurgeEvent(Base):
    """Mass-casualty / disaster mode. Activating one widens the trust window
    (freshness thresholds relax) and switches the analytics surface to a
    district wall display."""

    __tablename__ = "surge_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    district_id: Mapped[int] = mapped_column(ForeignKey("districts.id"))
    scope: Mapped[str] = mapped_column(String(20), default="district")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime)
    opened_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    note: Mapped[str] = mapped_column(String(300), default="")
