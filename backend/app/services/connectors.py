"""Connectors: how a hospital's own system feeds MedMesh.

Three ingest shapes are supported, all normalised into the one internal capacity
model before anything else sees them:

*   **HL7 FHIR R4** — a `Bundle` containing a `MeasureReport` whose group
    populations carry the counts, plus a `Location` for identity. This is the
    standard interface the report asks for; a vendor that already speaks FHIR
    needs no bespoke integration.
*   **Vendor REST** — a flat JSON body for the many hospital systems that have
    an API but no FHIR facade. Mapped field by field in `from_vendor_rest`.
*   **Manual** — no connector at all. The facility uses the dashboard keypad,
    and its submissions arrive through the same trust engine as a connector's,
    which is the point: the data-quality rules must not depend on how the number
    arrived.

Authentication is by connector key rather than by user login, because a hospital
system cannot open a browser and sign in. Only the hash is stored.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Connector, ConnectorKind, EdCongestion, Hospital, IntegrationMode, utcnow

KEY_PREFIX = "mm_live_"


class ConnectorError(Exception):
    """Bad payload, unknown facility, or an inactive connector."""

    def __init__(self, detail: str, *, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


# --------------------------------------------------------------------------- #
# Credentials
# --------------------------------------------------------------------------- #


def hash_key(key: str) -> str:
    """SHA-256 of the key.

    A plain digest is enough here and bcrypt/argon2 would be wrong: this is a
    high-entropy machine credential looked up on every ingest, not a
    human-chosen password, so there is nothing to brute-force and the cost of a
    slow KDF on a hot path buys nothing.
    """
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def issue_key(db: Session, connector: Connector) -> str:
    """Mint a new key, store its hash, and return the plaintext exactly once."""
    raw = KEY_PREFIX + secrets.token_urlsafe(24)
    connector.key_prefix = raw[:16]
    connector.key_hash = hash_key(raw)
    connector.rotated_at = utcnow()
    db.flush()
    return raw


def connector_for_key(db: Session, key: str) -> Connector:
    if not key:
        raise ConnectorError("Missing connector key", status_code=401)

    connector = db.execute(
        select(Connector).where(Connector.key_hash == hash_key(key))
    ).scalar_one_or_none()

    if connector is None:
        raise ConnectorError("Unknown connector key", status_code=401)
    if not connector.active:
        raise ConnectorError("Connector is disabled", status_code=403)
    return connector


def note_ingest(db: Session, connector: Connector, *, ok: bool, error: str = "", code: int = 200) -> None:
    connector.last_seen_at = utcnow()
    connector.last_status_code = code
    connector.last_error = "" if ok else error[:300]
    if ok:
        connector.accepted_24h += 1
    else:
        connector.rejected_24h += 1


# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class NormalisedCapacity:
    """The one shape every ingress collapses to."""

    beds_available: int
    icu_available: int
    ventilators_available: int
    ed_congestion: EdCongestion
    ed_waiting: int
    blood_units: int | None
    antivenom_vials: int | None
    recorded_at: datetime
    external_id: str = ""
    raw: dict | None = None


CONGESTION_FROM_CODE = {
    "low": EdCongestion.LOW,
    "moderate": EdCongestion.MODERATE,
    "high": EdCongestion.HIGH,
    "critical": EdCongestion.CRITICAL,
    # FHIR MeasureReport populations are counts, not levels, so a waiting-room
    # count is mapped to a level here in one place.
    "l": EdCongestion.LOW,
    "m": EdCongestion.MODERATE,
    "h": EdCongestion.HIGH,
    "c": EdCongestion.CRITICAL,
}


def congestion_from_waiting(waiting: int) -> EdCongestion:
    """ED congestion is derived from the queue, not separately reported by most
    systems. Same thresholds the manual dashboard uses, so a manual facility and
    a connector-integrated one land on comparable values."""
    if waiting >= 18:
        return EdCongestion.CRITICAL
    if waiting >= 10:
        return EdCongestion.HIGH
    if waiting >= 4:
        return EdCongestion.MODERATE
    return EdCongestion.LOW


def from_fhir_bundle(bundle: dict) -> NormalisedCapacity:
    """Extract capacity from a FHIR R4 Bundle.

    Looks for a `MeasureReport` and reads its `group.population` entries by
    code. FHIR models aggregate bed availability exactly this way, so this is
    standard mapping rather than a bespoke dialect dressed up in FHIR clothes.
    Falls back to `Location` extensions when a system publishes capacity there
    instead, which several Indian HIS products do.
    """
    if not isinstance(bundle, dict) or bundle.get("resourceType") != "Bundle":
        raise ConnectorError("Expected a FHIR Bundle with resourceType 'Bundle'")

    entries = bundle.get("entry") or []
    if not entries:
        raise ConnectorError("FHIR Bundle contains no entries")

    beds = icu = vents = waiting = None
    blood = antivenom = None
    congestion: EdCongestion | None = None
    external_id = ""

    for entry in entries:
        resource = entry.get("resource") or {}
        rtype = resource.get("resourceType")

        if rtype == "Location":
            external_id = external_id or (resource.get("id") or "")

        elif rtype == "MeasureReport":
            for group in resource.get("group") or []:
                for pop in group.get("population") or []:
                    code = ((pop.get("code") or {}).get("coding") or [{}])[0].get("code", "")
                    count = pop.get("count")
                    if count is None:
                        continue
                    code_l = code.lower()
                    if code_l in ("beds-available", "beds_available", "available-beds"):
                        beds = int(count)
                    elif code_l in ("icu-available", "icu_available", "available-icu"):
                        icu = int(count)
                    elif code_l in ("ventilators-available", "ventilator", "vents"):
                        vents = int(count)
                    elif code_l in ("ed-waiting", "waiting", "ed-queue"):
                        waiting = int(count)
                    elif code_l in ("blood-units", "blood"):
                        blood = int(count)
                    elif code_l in ("antivenom", "antivenom-vials"):
                        antivenom = int(count)
                    elif code_l in ("ed-congestion", "congestion"):
                        congestion = CONGESTION_FROM_CODE.get(str(count).lower())

        elif rtype == "Observation":
            # Some systems push the ED queue as an Observation with a valueQuantity.
            code = (((resource.get("code") or {}).get("coding") or [{}])[0]).get("code", "")
            value = (resource.get("valueQuantity") or {}).get("value")
            if value is None:
                continue
            if code in ("ed-waiting", "waiting-room-count"):
                waiting = int(value)

    if beds is None and icu is None and vents is None:
        raise ConnectorError(
            "Bundle carried no recognisable capacity populations — expected a MeasureReport "
            "with coded group.population entries (beds-available, icu-available, ventilators-available)"
        )

    waiting_count = waiting if waiting is not None else 0
    return NormalisedCapacity(
        beds_available=int(beds or 0),
        icu_available=int(icu or 0),
        ventilators_available=int(vents or 0),
        ed_congestion=congestion or congestion_from_waiting(waiting_count),
        ed_waiting=waiting_count,
        blood_units=blood,
        antivenom_vials=antivenom,
        recorded_at=utcnow(),
        external_id=external_id,
        raw=bundle,
    )


def from_vendor_rest(body: dict) -> NormalisedCapacity:
    """Flat JSON from a hospital system that has an API but no FHIR facade.

    Accepts the obvious spellings rather than demanding one, because the whole
    point of this ingress is that the facility cannot change its vendor.
    """
    if not isinstance(body, dict):
        raise ConnectorError("Expected a JSON object")

    def pick(*names, default=None):
        for n in names:
            if n in body and body[n] is not None:
                return body[n]
        return default

    beds = pick("beds_available", "available_beds", "beds", "general_beds_free")
    icu = pick("icu_available", "available_icu", "icu", "icu_beds_free")
    vents = pick("ventilators_available", "available_ventilators", "ventilators", "vents_free")

    if beds is None and icu is None and vents is None:
        raise ConnectorError(
            "No capacity fields found — expected at least one of "
            "beds_available, icu_available, ventilators_available"
        )

    waiting = int(pick("ed_waiting", "waiting_room", "ed_queue", default=0) or 0)
    congestion_raw = pick("ed_congestion", "congestion")
    congestion = (
        CONGESTION_FROM_CODE.get(str(congestion_raw).lower()) if congestion_raw else None
    )

    blood = pick("blood_units", "blood_bank_units")
    antivenom = pick("antivenom_vials", "antivenom")

    return NormalisedCapacity(
        beds_available=int(beds or 0),
        icu_available=int(icu or 0),
        ventilators_available=int(vents or 0),
        ed_congestion=congestion or congestion_from_waiting(waiting),
        ed_waiting=waiting,
        blood_units=int(blood) if blood is not None else None,
        antivenom_vials=int(antivenom) if antivenom is not None else None,
        recorded_at=utcnow(),
        external_id=str(pick("facility_code", "location_id", "id", default="")),
        raw=body,
    )


def normalise(kind: ConnectorKind, body: dict) -> NormalisedCapacity:
    if kind is ConnectorKind.FHIR_R4:
        return from_fhir_bundle(body)
    if kind is ConnectorKind.VENDOR_REST:
        return from_vendor_rest(body)
    raise ConnectorError(
        f"Connector kind '{kind.value}' does not accept HTTP pushes — "
        "manual facilities submit through the dashboard",
        status_code=409,
    )


def ensure_connector(db: Session, hospital: Hospital) -> Connector:
    """Every facility has a connector row, even a manual one.

    A uniform row means the setup page, the health dashboard and the audit trail
    do not each need a special case for "this facility has no connector".
    """
    existing = db.execute(
        select(Connector).where(Connector.hospital_id == hospital.id)
    ).scalar_one_or_none()
    if existing:
        return existing

    kind = (
        ConnectorKind.FHIR_R4
        if hospital.integration is IntegrationMode.API
        else ConnectorKind.MANUAL
    )
    connector = Connector(
        hospital_id=hospital.id,
        kind=kind,
        source_system=hospital.source_system or "",
        active=True,
    )
    db.add(connector)
    db.flush()
    return connector


def connector_summary(connector: Connector, *, hospital: Hospital | None = None) -> dict:
    """Wire shape for the setup and health screens."""
    now = utcnow()
    if connector.last_seen_at is None:
        health = "never_seen"
    else:
        age = (now - connector.last_seen_at).total_seconds()
        if not connector.active:
            health = "disabled"
        elif (connector.last_status_code or 200) >= 400:
            # A rejected push is the more urgent fact, whatever its age. An
            # estate table that says "healthy" about a system which errored on
            # its last attempt is worse than no table: it is actively misleading
            # during the incident it was built to catch.
            health = "failing"
        elif connector.rejected_24h and not connector.accepted_24h:
            health = "failing"
        elif age > 6 * 3600:
            health = "quiet"
        else:
            health = "healthy"

    return {
        "id": connector.id,
        "hospital_id": connector.hospital_id,
        "hospital_name": hospital.name if hospital else None,
        "hospital_short_name": hospital.short_name if hospital else None,
        "kind": connector.kind.value,
        "source_system": connector.source_system,
        "active": connector.active,
        "key_prefix": connector.key_prefix or None,
        "has_key": bool(connector.key_hash),
        "last_seen_at": connector.last_seen_at.isoformat() + "Z" if connector.last_seen_at else None,
        "last_seen_age_seconds": (
            int((now - connector.last_seen_at).total_seconds()) if connector.last_seen_at else None
        ),
        "last_status_code": connector.last_status_code,
        "last_error": connector.last_error or None,
        "accepted_24h": connector.accepted_24h,
        "rejected_24h": connector.rejected_24h,
        "health": health,
        "created_at": connector.created_at.isoformat() + "Z",
        "rotated_at": connector.rotated_at.isoformat() + "Z" if connector.rotated_at else None,
    }


DEFAULT_SAMPLE = {
    "beds_available": 42,
    "icu_available": 6,
    "ventilators_available": 3,
    "ed_waiting": 7,
    "blood_units": 64,
    "antivenom_vials": 12,
}


def sample_payload(
    kind: ConnectorKind,
    *,
    current: dict | None = None,
    facility_code: str = "FACILITY-01",
) -> dict:
    """A worked example the integrator can paste and adapt.

    The setup page shows this rather than documenting the schema in prose,
    because the fastest way to get a hospital system talking is to hand its
    engineer a request body that already works.

    When the caller knows the facility's current capacity, the sample is built
    from it as a small plausible movement rather than from fixed numbers. That
    matters more than it looks: the trust engine quarantines implausible jumps,
    so a hard-coded sample would be *rejected* the first time an engineer pasted
    it against a live facility, and they would have no way to tell whether the
    rejection meant "your integration is wrong" or "these figures are stale
    boilerplate".

    The movement is deliberately a **gain**, never a loss. The sample gets pasted
    into real systems by real engineers, and arbitrary figures taken straight
    from it would otherwise be published as the facility's capacity. A sample
    that reads "beds 42, ICU 6" against a hospital that actually holds 326 and
    19 is merely wrong; a sample that decrements whatever the facility currently
    has can push its last free ICU bed to zero purely because somebody pressed
    "Test connection", and dispatchers route on that number.
    """
    if current:
        figures = {
            "beds_available": int(current.get("beds_available") or 0) + 2,
            "icu_available": int(current.get("icu_available") or 0) + 1,
            "ventilators_available": int(current.get("ventilators_available") or 0) + 1,
            "ed_waiting": int(current.get("ed_waiting") or 0),
            "blood_units": int(current.get("blood_units") or 0) + 2,
            "antivenom_vials": int(current.get("antivenom_vials") or 0),
        }
    else:
        figures = dict(DEFAULT_SAMPLE)

    if kind is ConnectorKind.FHIR_R4:
        populations = [
            {"code": {"coding": [{"code": "beds-available"}]}, "count": figures["beds_available"]},
            {"code": {"coding": [{"code": "icu-available"}]}, "count": figures["icu_available"]},
            {
                "code": {"coding": [{"code": "ventilators-available"}]},
                "count": figures["ventilators_available"],
            },
            {"code": {"coding": [{"code": "ed-waiting"}]}, "count": figures["ed_waiting"]},
            {"code": {"coding": [{"code": "blood-units"}]}, "count": figures["blood_units"]},
        ]
        if figures["antivenom_vials"]:
            populations.append(
                {
                    "code": {"coding": [{"code": "antivenom-vials"}]},
                    "count": figures["antivenom_vials"],
                }
            )
        return {
            "resourceType": "Bundle",
            "type": "collection",
            "entry": [
                {"resource": {"resourceType": "Location", "id": facility_code}},
                {
                    "resource": {
                        "resourceType": "MeasureReport",
                        "status": "complete",
                        "type": "summary",
                        "measure": "https://medmesh.in/fhir/Measure/capacity",
                        "group": [{"population": populations}],
                    }
                },
            ],
        }
    return {"facility_code": facility_code, **figures}
