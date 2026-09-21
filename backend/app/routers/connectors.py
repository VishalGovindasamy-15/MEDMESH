"""Connectors, notifications and facility onboarding.

Three things a facility needs before it is a working member of the network, and
which had no surface at all in the first pass:

1.  **A way in.** `POST /ingest/fhir` and `POST /ingest/vendor` accept pushes
    from a hospital's own system, authenticated with a connector key rather than
    a user login. The plaintext key is returned exactly once, at issue time.

2.  **A way to be told things.** The inbox endpoints back the facility
    notification screen: inbound ambulances, expiring holds, stale-data
    reminders and quarantine notices.

3.  **A way to join.** `POST /onboarding/facility` is the public application a
    hospital without any compatible system uses to register. It lands in the
    verification queue, which is where a platform admin decides between API
    onboarding and manual dashboard access.

Route naming note: the ingest endpoints are mounted *outside* `/api/v1` in
`main.py` because they are a machine interface for third-party systems, not part
of the console's API surface. A hospital's integration is versioned separately
from the app's endpoints.
"""

from __future__ import annotations

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status as http_status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..live import live_store
from ..models import (
    Connector,
    ConnectorKind,
    District,
    Hospital,
    HospitalType,
    Incident,
    IntegrationMode,
    Notification,
    User,
    UserRole,
    VerificationStatus,
    utcnow,
)
from .. import repository
from ..repository import sync_hold_projection
from ..schemas import (
    ConnectorCreate,
    ConnectorKeyRotate,
    FacilityApplication,
    FacilityDecision,
    NotificationAck,
)
from ..security import CurrentUser, require_roles
from ..services import audit, connectors as connector_svc, notifications as notify
from ..services.notifications import notification_out

# --------------------------------------------------------------------------- #
# Ingest — machine interface, connector-key authenticated
# --------------------------------------------------------------------------- #

def _live_figures(db: Session, hospital: Hospital) -> dict | None:
    """The facility's committed capacity, used to keep the sample plausible."""
    record = repository.latest_capacity_map(db, [hospital.id]).get(hospital.id)
    if record is None:
        return None
    return {
        "beds_available": record.beds_available,
        "icu_available": record.icu_available,
        "ventilators_available": record.ventilators_available,
        "ed_waiting": record.ed_waiting,
        "blood_units": record.blood_units,
        "antivenom_vials": record.antivenom_vials,
    }


ingest_router = APIRouter(prefix="/ingest", tags=["ingest"])


def _ingest(
    db: Session,
    *,
    key: str,
    body: dict,
    expected: ConnectorKind | None = None,
) -> dict:
    """Shared path for both ingresses.

    Normalises, then runs the same trust screen the dashboard uses. A connector
    must not get an easier ride than a human keying numbers in: the trust engine
    is what makes mixed-provenance data comparable, and bypassing it for
    machine-submitted data would quietly break that.
    """
    from .hospitals import ingest_capacity

    connector = connector_svc.connector_for_key(db, key)
    if expected is not None and connector.kind is not expected:
        connector_svc.note_ingest(
            db, connector, ok=False, error=f"posted {expected.value} to a {connector.kind.value} connector", code=409
        )
        db.commit()
        raise HTTPException(
            status_code=409,
            detail=(
                f"This connector is registered as {connector.kind.value}. "
                f"Post to the matching ingress or change the connector kind in the console."
            ),
        )

    try:
        normalised = connector_svc.normalise(connector.kind, body)
    except connector_svc.ConnectorError as exc:
        connector_svc.note_ingest(db, connector, ok=False, error=exc.detail, code=exc.status_code)
        audit.record(
            db,
            action="ingest.rejected",
            entity_type="connector",
            entity_id=connector.id,
            summary=f"Rejected push: {exc.detail[:160]}",
            actor=None,
        )
        db.commit()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    hospital = db.get(Hospital, connector.hospital_id)

    # The single capacity write path — the same function the dashboard calls, so
    # a machine submission is screened exactly as a human one is.
    outcome = ingest_capacity(
        db,
        hospital=hospital,
        values={
            "beds_available": normalised.beds_available,
            "icu_available": normalised.icu_available,
            "ventilators_available": normalised.ventilators_available,
            "ed_congestion": normalised.ed_congestion,
            "ed_waiting": normalised.ed_waiting,
            "blood_units": normalised.blood_units if normalised.blood_units is not None else 0,
            "antivenom_vials": (
                normalised.antivenom_vials if normalised.antivenom_vials is not None else 0
            ),
        },
        source=hospital.integration,
        actor=None,
        note=f"{connector.kind.value} connector",
    )

    verdict = outcome["trust"]
    quarantined = not outcome["accepted"]
    flags = verdict.get("flags", [])

    connector_svc.note_ingest(
        db,
        connector,
        ok=not quarantined,
        error="; ".join(flags),
        code=202 if quarantined else 200,
    )

    if quarantined:
        notify.notify_facility_staff(
            db,
            hospital_id=hospital.id,
            kind=notify.NotificationKind.SUBMISSION_QUARANTINED,
            title="Connector submission quarantined",
            body=(
                f"{connector.source_system or 'Your system'} pushed figures that failed the anomaly "
                f"screen: {'; '.join(flags)}. The values were stored but are not published, so the "
                "public directory and dispatch are still using the previous figures."
            ),
            severity="critical",
        )

    audit.record(
        db,
        action="ingest.accepted" if not quarantined else "ingest.quarantined",
        entity_type="connector",
        entity_id=connector.id,
        summary=f"{connector.kind.value} push from {hospital.short_name}",
        actor=None,
        payload={"flags": flags, "trust_score": verdict.get("score")},
    )
    db.commit()

    return {
        "accepted": not quarantined,
        "hospital": hospital.short_name,
        "hospital_id": hospital.id,
        "quarantined": quarantined,
        "trust_score": verdict.get("score"),
        "flags": flags,
        "published": outcome["record"],
        "message": (
            "Stored and published to the live feed."
            if not quarantined
            else "Stored but withheld from the live feed pending review."
        ),
    }


@ingest_router.post("/fhir", status_code=http_status.HTTP_202_ACCEPTED)
def ingest_fhir(
    body: dict,
    x_connector_key: str = Header(default="", alias="X-Connector-Key"),
    db: Session = Depends(get_db),
):
    """HL7 FHIR R4 Bundle ingress. See app/services/connectors.py for the mapping."""
    return _ingest(db, key=x_connector_key, body=body, expected=ConnectorKind.FHIR_R4)


@ingest_router.post("/vendor", status_code=http_status.HTTP_202_ACCEPTED)
def ingest_vendor(
    body: dict,
    x_connector_key: str = Header(default="", alias="X-Connector-Key"),
    db: Session = Depends(get_db),
):
    """Flat-JSON ingress for hospital systems without a FHIR facade."""
    return _ingest(db, key=x_connector_key, body=body, expected=ConnectorKind.VENDOR_REST)


# --------------------------------------------------------------------------- #
# Console — connectors
# --------------------------------------------------------------------------- #

router = APIRouter(tags=["connectors"])


@router.get("/connectors")
def list_connectors(
    user: CurrentUser,
    db: Session = Depends(get_db),
    health: str | None = Query(default=None),
):
    """Platform admins see the whole estate; hospital staff see only their own."""
    stmt = select(Connector)
    if user.role is not UserRole.PLATFORM_ADMIN:
        if user.hospital_id is None:
            raise HTTPException(status_code=403, detail="Your account is not scoped to a facility")
        stmt = stmt.where(Connector.hospital_id == user.hospital_id)

    rows = list(db.execute(stmt).scalars().all())
    hospitals = {
        h.id: h for h in db.execute(select(Hospital)).scalars().all()
    }
    out = [connector_svc.connector_summary(c, hospital=hospitals.get(c.hospital_id)) for c in rows]
    if health:
        out = [c for c in out if c["health"] == health]
    out.sort(key=lambda c: (c["health"] == "healthy", c["hospital_short_name"] or ""))
    return {"count": len(out), "results": out}


@router.get("/connectors/estate")
def connector_estate(user: CurrentUser, db: Session = Depends(get_db)):
    """Roll-up for the platform-admin ops view: how much of the network is
    actually pushing data, broken down by connector kind and health."""
    if user.role is not UserRole.PLATFORM_ADMIN:
        raise HTTPException(status_code=403, detail="Platform admin only")

    hospitals = list(db.execute(select(Hospital)).scalars().all())
    rows = list(db.execute(select(Connector)).scalars().all())

    by_health: dict[str, int] = {}
    by_kind: dict[str, int] = {}
    by_integration: dict[str, int] = {}

    for connector in rows:
        summary = connector_svc.connector_summary(connector)
        by_health[summary["health"]] = by_health.get(summary["health"], 0) + 1
        by_kind[connector.kind.value] = by_kind.get(connector.kind.value, 0) + 1

    for hospital in hospitals:
        key = hospital.integration.value
        by_integration[key] = by_integration.get(key, 0) + 1

    linked = {c.hospital_id for c in rows}
    # The interesting set is not "everything without a connector" — most of the
    # network is deliberately manual, and listing them buries the real problem.
    # It is the facilities that claim to be API-integrated but have no credential
    # to push with: those will silently go stale and dispatchers will route on
    # their last known figures.
    api_without_connector = [
        h.short_name for h in hospitals if h.integration is IntegrationMode.API and h.id not in linked
    ]
    manual = [h for h in hospitals if h.integration is IntegrationMode.MANUAL]

    return {
        "facilities": len(hospitals),
        "connectors": len(rows),
        "by_health": by_health,
        "by_kind": by_kind,
        "by_integration": by_integration,
        "manual_facilities": len(manual),
        "api_without_connector": api_without_connector,
        "ingest_url_fhir": "/ingest/fhir",
        "ingest_url_vendor": "/ingest/vendor",
    }


@router.post("/connectors", status_code=http_status.HTTP_201_CREATED)
def create_connector(
    payload: ConnectorCreate,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.HOSPITAL_ADMIN)),
    db: Session = Depends(get_db),
):
    """Register a connector and issue its key. The plaintext key is in this
    response only — it is never retrievable afterwards."""
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != payload.hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")

    existing = db.execute(
        select(Connector).where(Connector.hospital_id == hospital.id)
    ).scalar_one_or_none()

    connector = existing or connector_svc.ensure_connector(db, hospital)
    connector.kind = payload.kind
    connector.source_system = payload.source_system or connector.source_system
    connector.active = True

    # A facility registered as manual that now has a working connector should be
    # reported as API-integrated, or the directory badges and the trust
    # provenance factor would keep saying "manual entry" about machine data.
    if payload.kind is not ConnectorKind.MANUAL:
        hospital.integration = IntegrationMode.API
        hospital.source_system = payload.source_system or hospital.source_system or payload.kind.value
    else:
        hospital.integration = IntegrationMode.MANUAL

    key = connector_svc.issue_key(db, connector)

    audit.record(
        db,
        action="connector.created" if not existing else "connector.updated",
        entity_type="connector",
        entity_id=connector.id,
        summary=f"{payload.kind.value} connector for {hospital.short_name}",
        actor=user,
    )
    db.commit()

    return {
        "connector_id": connector.id,
        "hospital_id": hospital.id,
        "kind": connector.kind.value,
        "key": key,
        "key_shown_once": True,
        "ingest_url": "/ingest/fhir" if payload.kind is ConnectorKind.FHIR_R4 else "/ingest/vendor",
        "sample_payload": connector_svc.sample_payload(
            payload.kind,
            current=_live_figures(db, hospital),
            facility_code=hospital.short_name,
        ),
        "warning": "Store this key now — only its hash is retained and it cannot be shown again.",
    }


@router.post("/connectors/{connector_id}/rotate")
def rotate_connector_key(
    connector_id: int,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.HOSPITAL_ADMIN)),
    db: Session = Depends(get_db),
):
    connector = db.get(Connector, connector_id)
    if connector is None:
        raise HTTPException(status_code=404, detail="Connector not found")
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != connector.hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    key = connector_svc.issue_key(db, connector)
    audit.record(
        db,
        action="connector.key_rotated",
        entity_type="connector",
        entity_id=connector.id,
        summary="Connector key rotated",
        actor=user,
    )
    db.commit()
    return {"connector_id": connector.id, "key": key, "key_shown_once": True}


@router.post("/connectors/{connector_id}/active")
def set_connector_active(
    connector_id: int,
    payload: dict,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.HOSPITAL_ADMIN)),
    db: Session = Depends(get_db),
):
    connector = db.get(Connector, connector_id)
    if connector is None:
        raise HTTPException(status_code=404, detail="Connector not found")
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != connector.hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")

    connector.active = bool(payload.get("active", True))
    audit.record(
        db,
        action="connector.enabled" if connector.active else "connector.disabled",
        entity_type="connector",
        entity_id=connector.id,
        summary=f"Connector {'enabled' if connector.active else 'disabled'}",
        actor=user,
    )
    db.commit()
    return connector_svc.connector_summary(
        connector, hospital=db.get(Hospital, connector.hospital_id)
    )


@router.post("/connectors/{connector_id}/test")
def test_connector(
    connector_id: int,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.HOSPITAL_ADMIN)),
    db: Session = Depends(get_db),
):
    """Replay the sample payload through the parser without touching live data.

    Integrators need to know whether the mapping is wrong or the network is,
    and the fastest way to answer that is to parse a known-good body and report
    exactly what it produced.
    """
    connector = db.get(Connector, connector_id)
    if connector is None:
        raise HTTPException(status_code=404, detail="Connector not found")
    if user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id != connector.hospital_id:
        raise HTTPException(status_code=403, detail="Your account is scoped to a different facility")
    if connector.kind is ConnectorKind.MANUAL:
        return {
            "ok": True,
            "kind": "manual",
            "message": "Manual facilities have no machine ingress — staff submit through the dashboard keypad.",
        }

    hospital = db.get(Hospital, connector.hospital_id)
    body = connector_svc.sample_payload(
        connector.kind,
        current=_live_figures(db, hospital) if hospital else None,
        facility_code=hospital.short_name if hospital else "FACILITY-01",
    )
    try:
        parsed = connector_svc.normalise(connector.kind, body)
    except connector_svc.ConnectorError as exc:
        return {"ok": False, "kind": connector.kind.value, "message": exc.detail}

    return {
        "ok": True,
        "kind": connector.kind.value,
        "message": "Sample payload parsed successfully. Send this body to the ingest URL to publish it.",
        "parsed": {
            "beds_available": parsed.beds_available,
            "icu_available": parsed.icu_available,
            "ventilators_available": parsed.ventilators_available,
            "ed_congestion": parsed.ed_congestion.value,
            "ed_waiting": parsed.ed_waiting,
            "blood_units": parsed.blood_units,
        },
        "sample_payload": body,
        "ingest_url": "/ingest/fhir" if connector.kind is ConnectorKind.FHIR_R4 else "/ingest/vendor",
    }


# --------------------------------------------------------------------------- #
# Console — notifications
# --------------------------------------------------------------------------- #


@router.get("/notifications")
def list_notifications(
    user: CurrentUser,
    db: Session = Depends(get_db),
    unread_only: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
):
    rows = notify.inbox(db, user=user, unread_only=unread_only, limit=limit)
    return {
        "count": len(rows),
        "results": _render(db, rows),
        "unread": notify.unread_count(db, user=user),
    }


def _render(db: Session, rows: list[Notification]) -> list[dict]:
    """Resolve facility names and case references for a page of inbox rows.

    Two dictionary lookups for the whole page rather than a query per row: an
    inbox is the one screen where an N+1 is guaranteed to be noticed.
    """
    hospital_ids = {r.hospital_id for r in rows if r.hospital_id is not None}
    incident_ids = {r.incident_id for r in rows if r.incident_id is not None}

    hospitals = (
        {h.id: h for h in db.execute(select(Hospital).where(Hospital.id.in_(hospital_ids))).scalars()}
        if hospital_ids
        else {}
    )
    incidents = (
        {
            i.id: i.reference
            for i in db.execute(select(Incident).where(Incident.id.in_(incident_ids))).scalars()
        }
        if incident_ids
        else {}
    )

    return [
        notification_out(
            r,
            hospital=hospitals.get(r.hospital_id) if r.hospital_id else None,
            incident_reference=incidents.get(r.incident_id) if r.incident_id else None,
        )
        for r in rows
    ]


@router.post("/notifications/{notification_id}/read")
def mark_read(
    notification_id: int,
    user: CurrentUser,
    db: Session = Depends(get_db),
):
    row = db.get(Notification, notification_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    # A user may only acknowledge what is addressed to them or to their facility.
    if row.user_id not in (None, user.id) and row.hospital_id != user.hospital_id:
        raise HTTPException(status_code=403, detail="This notification is not addressed to you")

    if row.read_at is None:
        row.read_at = utcnow()
        row.acknowledged_by = user.id
        db.commit()
    return notification_out(
        row,
        hospital=db.get(Hospital, row.hospital_id) if row.hospital_id else None,
        incident_reference=(
            db.get(Incident, row.incident_id).reference if row.incident_id else None
        ),
    )


@router.post("/notifications/read-all")
def mark_all_read(payload: NotificationAck, user: CurrentUser, db: Session = Depends(get_db)):
    rows = notify.inbox(db, user=user, unread_only=True, limit=200)
    for row in rows:
        if payload.kind is not None and row.kind.value != payload.kind:
            continue
        row.read_at = utcnow()
        row.acknowledged_by = user.id
    db.commit()
    return {"acknowledged": len(rows), "unread": notify.unread_count(db, user=user)}


@router.post("/notifications/sweep")
def sweep(
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Run the staleness reminder job on demand.

    Also runs on a schedule in the background loop; exposed here because
    demonstrating "the facility that has not updated in two hours gets nudged"
    should not require waiting two hours.
    """
    created = notify.remind_stale(db)
    db.commit()
    return {
        "queued": len(created),
        "facilities": [c.hospital_id for c in created],
    }


# --------------------------------------------------------------------------- #
# Onboarding — public application, admin decision
# --------------------------------------------------------------------------- #

onboarding_router = APIRouter(prefix="/onboarding", tags=["onboarding"])


@onboarding_router.post("/facility", status_code=http_status.HTTP_201_CREATED)
def apply_facility(payload: FacilityApplication, db: Session = Depends(get_db)):
    """Public application for a hospital to join the network.

    Unauthenticated by design: the person who knows a district hospital's bed
    count is a hospital administrator, not a MedMesh user, and requiring an
    account before they can apply is how onboarding stalls. The application
    creates an unverified listing — visible to nobody but the review queue —
    and a platform admin decides what happens next.
    """
    district = db.get(District, payload.district_id)
    if district is None:
        raise HTTPException(status_code=404, detail="District not found")

    slug = payload.name.lower().replace(" ", "-")[:60]
    if db.execute(select(Hospital).where(Hospital.slug == slug)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="A facility with this name is already registered")

    hospital = Hospital(
        slug=slug,
        name=payload.name,
        short_name=payload.short_name or payload.name[:12],
        type=payload.type,
        district_id=district.id,
        address=payload.address or f"{district.name}",
        lat=payload.lat,
        lng=payload.lng,
        verification=VerificationStatus.UNVERIFIED,
        # Applied-but-not-integrated facilities start manual. If the review
        # concludes they have a usable API, the connector is created then.
        integration=IntegrationMode.MANUAL,
        contact_phone=payload.contact_phone,
        emergency_phone=payload.emergency_phone,
        total_beds=payload.total_beds,
        total_icu=payload.total_icu,
        total_ventilators=payload.total_ventilators,
        specialties=",".join(sorted(set(payload.specialties))),
        has_blood_bank=payload.has_blood_bank,
        has_trauma_centre=payload.has_trauma_centre,
        expose_doctor_directory=True,
    )
    db.add(hospital)
    db.flush()

    connector_svc.ensure_connector(db, hospital)

    audit.record(
        db,
        action="onboarding.applied",
        entity_type="hospital",
        entity_id=hospital.id,
        summary=f"{hospital.name} applied to join from {district.name}",
        actor=None,
        payload={"contact": payload.contact_email, "has_system": payload.has_existing_system},
    )
    db.commit()

    return {
        "hospital_id": hospital.id,
        "reference": f"MM-ONB-{hospital.id:05d}",
        "verification": hospital.verification.value,
        "message": (
            "Application received. An onboarding officer will verify the facility before its "
            "figures appear in the public directory."
        ),
        "next_steps": (
            [
                "Verification call to the number supplied",
                "Decide between connector integration and manual dashboard access",
            ]
            if payload.has_existing_system
            else [
                "Verification call to the number supplied",
                "Manual dashboard access on approval — no hospital IT system required",
            ]
        ),
    }


@onboarding_router.get("/queue")
def onboarding_queue(
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """The verification worklist (§7 fraud prevention)."""
    rows = list(
        db.execute(
            select(Hospital)
            .where(Hospital.verification.in_((VerificationStatus.UNVERIFIED, VerificationStatus.PENDING)))
            .order_by(Hospital.created_at.desc())
        ).scalars().all()
    )
    connectors = {
        c.hospital_id: c for c in db.execute(select(Connector)).scalars().all()
    }
    districts = {d.id: d for d in db.execute(select(District)).scalars().all()}

    return {
        "count": len(rows),
        "results": [
            {
                "hospital_id": h.id,
                "name": h.name,
                "short_name": h.short_name,
                "type": h.type.value,
                "district": districts[h.district_id].name if h.district_id in districts else None,
                "district_id": h.district_id,
                "address": h.address,
                "beds": h.total_beds,
                "icu": h.total_icu,
                "ventilators": h.total_ventilators,
                "verification": h.verification.value,
                "integration": h.integration.value,
                "specialties": [s for s in (h.specialties or "").split(",") if s],
                "connector_kind": connectors[h.id].kind.value if h.id in connectors else None,
                "applied_at": h.created_at.isoformat() + "Z",
            }
            for h in rows
        ],
    }


@onboarding_router.post("/decide")
def decide_application(
    payload: FacilityDecision,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
):
    """Approve or refuse an application, and choose how the facility will report."""
    hospital = db.get(Hospital, payload.hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Facility not found")

    if payload.decision == "verify":
        hospital.verification = VerificationStatus.VERIFIED
        hospital.onboarding_completed_at = utcnow()
        if payload.integration is not None:
            hospital.integration = payload.integration
        if payload.specialties:
            hospital.specialties = ",".join(sorted(set(payload.specialties)))

        connector = connector_svc.ensure_connector(db, hospital)
        if payload.integration is IntegrationMode.MANUAL or payload.connector_kind is ConnectorKind.MANUAL:
            connector.kind = ConnectorKind.MANUAL
            hospital.integration = IntegrationMode.MANUAL
        elif payload.connector_kind is not None:
            connector.kind = payload.connector_kind
    else:
        hospital.verification = VerificationStatus.SUSPENDED

    audit.record(
        db,
        action=f"onboarding.{payload.decision}",
        entity_type="hospital",
        entity_id=hospital.id,
        summary=f"{hospital.name} {payload.decision}d by onboarding officer",
        actor=user,
        payload={"note": payload.note, "integration": hospital.integration.value},
    )
    db.commit()

    return {
        "hospital_id": hospital.id,
        "verification": hospital.verification.value,
        "integration": hospital.integration.value,
        "message": (
            "Facility verified and active."
            if payload.decision == "verify"
            else "Application refused and listing suspended."
        ),
    }


@router.get("/connectors/templates")
def connector_templates(user: CurrentUser):
    """Documentation the setup screen renders: what to send, and what shape.

    Served from the backend rather than hard-coded in the client so the sample
    an integrator copies is generated by the same code that will parse it.
    """
    return {
        "templates": [
            {
                "kind": ConnectorKind.FHIR_R4.value,
                "label": "HL7 FHIR R4",
                "ingest_url": "/ingest/fhir",
                "auth": "X-Connector-Key header",
                "description": (
                    "Post a Bundle containing a MeasureReport. Capacity is read from the coded "
                    "group.population entries; the Location entry identifies the facility."
                ),
                "population_codes": [
                    "beds-available",
                    "icu-available",
                    "ventilators-available",
                    "ed-waiting",
                    "blood-units",
                    "antivenom-vials",
                ],
                "sample": connector_svc.sample_payload(ConnectorKind.FHIR_R4),
            },
            {
                "kind": ConnectorKind.VENDOR_REST.value,
                "label": "Vendor REST",
                "ingest_url": "/ingest/vendor",
                "auth": "X-Connector-Key header",
                "description": (
                    "Flat JSON for hospital systems with an API but no FHIR facade. Common "
                    "spellings are accepted for each field, so the vendor does not need changing."
                ),
                "fields": [
                    "beds_available (or available_beds, beds)",
                    "icu_available (or available_icu)",
                    "ventilators_available (or vents)",
                    "ed_waiting · ed_congestion · blood_units · antivenom_vials",
                ],
                "sample": connector_svc.sample_payload(ConnectorKind.VENDOR_REST),
            },
            {
                "kind": ConnectorKind.MANUAL.value,
                "label": "Manual dashboard",
                "ingest_url": None,
                "auth": "Staff sign-in",
                "description": (
                    "For facilities without a compatible system. Staff use the one-tap keypad; "
                    "submissions pass through the same trust engine as connector data."
                ),
                "fields": ["General beds · ICU beds · Ventilators · ED congestion · waiting count"],
                "sample": None,
            },
        ]
    }
