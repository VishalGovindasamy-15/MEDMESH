"""Government analytics (§6.9) -- district and state aggregation, surge mode,
export.

Everything here is aggregate. The drill-down to a facility returns the same
public capacity figures any citizen can already see; the district figures are
derived from the append-only capacity series so a report regenerated next month
for the same window returns the same numbers.
"""

from __future__ import annotations

import csv
import io
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..live import live_store
from ..models import (
    Ambulance,
    AmbulanceStatus,
    CapacityRecord,
    District,
    EdCongestion,
    Feedback,
    FeedbackStatus,
    Hospital,
    Incident,
    IncidentStatus,
    SurgeEvent,
    User,
    UserRole,
    utcnow,
)
from ..repository import active_holds, active_surge, open_incidents
from ..schemas import SurgeCreate
from ..security import CurrentUser, OptionalUser, require_roles
from ..services import audit

router = APIRouter(prefix="/analytics", tags=["analytics"])

CONGESTION_WEIGHT = {"low": 0.1, "moderate": 0.4, "high": 0.75, "critical": 1.0}


def _district_ids(db: Session, user: User | None) -> list[int]:
    rows = db.execute(select(District.id).order_by(District.name)).scalars().all()
    if user is not None and user.role is UserRole.GOV_OFFICIAL and user.district_id:
        return [user.district_id]
    return list(rows)


def _district_rollup(db: Session, district: District) -> dict:
    hospitals = list(db.execute(select(Hospital).where(Hospital.district_id == district.id)).scalars().all())
    if not hospitals:
        return {
            "district_id": district.id,
            "district_name": district.name,
            "population": district.population,
            "hospitals": 0,
            "beds": {"total": 0, "available": 0, "occupancy_pct": None},
            "icu": {"total": 0, "available": 0, "occupancy_pct": None},
            "ventilators": {"total": 0, "available": 0, "occupancy_pct": None},
            "ed_congestion_index": None,
            "reporting_facilities": 0,
            "stale_facilities": 0,
        }

    totals = {"beds": 0, "icu": 0, "vent": 0}
    for h in hospitals:
        totals["beds"] += h.total_beds
        totals["icu"] += h.total_icu
        totals["vent"] += h.total_ventilators

    live_beds = live_icu = live_vent = 0
    congestion_sum = 0.0
    reporting = stale = 0
    for h in hospitals:
        view = live_store.get(h.id)
        if view is None:
            continue
        reporting += 1
        live_beds += view.beds_effective
        live_icu += view.icu_effective
        live_vent += view.vent_effective
        congestion_sum += CONGESTION_WEIGHT.get(view.ed_congestion, 0.5)
        age = (utcnow() - view.recorded_at).total_seconds()
        if age > 3600:
            stale += 1

    def pct(busy: float, total: int) -> float | None:
        if total <= 0:
            return None
        # Holds count as occupied -- a bed promised to an inbound ambulance is
        # not available, and a dashboard that counts it as free overstates
        # capacity at exactly the worst moment.
        occupied = max(0.0, total - busy)
        return round(occupied / total * 100, 1)

    return {
        "district_id": district.id,
        "district_name": district.name,
        "population": district.population,
        "hospitals": len(hospitals),
        "beds": {
            "total": totals["beds"],
            "available": live_beds,
            "occupied": max(0, totals["beds"] - live_beds),
            "occupancy_pct": pct(live_beds, totals["beds"]),
        },
        "icu": {
            "total": totals["icu"],
            "available": live_icu,
            "occupied": max(0, totals["icu"] - live_icu),
            "occupancy_pct": pct(live_icu, totals["icu"]),
        },
        "ventilators": {
            "total": totals["vent"],
            "available": live_vent,
            "occupied": max(0, totals["vent"] - live_vent),
            "occupancy_pct": pct(live_vent, totals["vent"]),
        },
        "ed_congestion_index": round(congestion_sum / reporting * 100, 1) if reporting else None,
        "reporting_facilities": reporting,
        "stale_facilities": stale,
    }


@router.get("/overview")
def overview(user: OptionalUser, db: Session = Depends(get_db)):
    """State-level header plus per-district rows. One call powers the entire
    government dashboard above the fold."""
    districts = list(db.execute(select(District).order_by(District.name)).scalars().all())
    rows = [_district_rollup(db, d) for d in districts]
    rows.sort(key=lambda r: -(r["beds"]["occupancy_pct"] or 0))

    hospitals = list(db.execute(select(Hospital)).scalars().all())
    facility_total_beds = sum(h.total_beds for h in hospitals)
    facility_total_icu = sum(h.total_icu for h in hospitals)
    live_beds = sum((live_store.get(h.id).beds_effective if live_store.get(h.id) else 0) for h in hospitals)
    live_icu = sum((live_store.get(h.id).icu_effective if live_store.get(h.id) else 0) for h in hospitals)

    fleet = list(db.execute(select(Ambulance)).scalars().all())
    incidents_today = db.execute(
        select(func.count()).select_from(Incident).where(Incident.created_at >= utcnow() - timedelta(hours=24))
    ).scalar_one()
    open_now = len(open_incidents(db))
    pend_feedback = db.execute(
        select(func.count()).select_from(Feedback).where(Feedback.status == FeedbackStatus.OPEN)
    ).scalar_one()
    surge = active_surge(db)

    return {
        "generated_at": utcnow().isoformat() + "Z",
        "state": {
            "facilities": len(hospitals),
            "facilities_reporting": sum(1 for h in hospitals if live_store.get(h.id) is not None),
            "beds_total": facility_total_beds,
            "beds_available": live_beds,
            "beds_occupancy_pct": round((facility_total_beds - live_beds) / facility_total_beds * 100, 1)
            if facility_total_beds
            else None,
            "icu_total": facility_total_icu,
            "icu_available": live_icu,
            "icu_occupancy_pct": round((facility_total_icu - live_icu) / facility_total_icu * 100, 1)
            if facility_total_icu
            else None,
        },
        "operations": {
            "incidents_last_24h": incidents_today,
            "incidents_open": open_now,
            "ambulances": len(fleet),
            "ambulances_available": sum(1 for a in fleet if a.status is AmbulanceStatus.AVAILABLE),
            "holds_active": len(active_holds(db)),
            "open_feedback": pend_feedback,
        },
        "surge": (
            {
                "id": surge.id,
                "title": surge.title,
                "district_id": surge.district_id,
                "scope": surge.scope,
                "opened_at": surge.opened_at.isoformat() + "Z",
                "elapsed_minutes": int((utcnow() - surge.opened_at).total_seconds() // 60),
            }
            if surge
            else None
        ),
        "districts": rows,
    }


@router.get("/district/{district_id}")
def district_detail(
    district_id: int,
    user: CurrentUser,
    db: Session = Depends(get_db),
    hours: int = Query(default=24, ge=1, le=168),
):
    district = db.get(District, district_id)
    if district is None:
        raise HTTPException(status_code=404, detail="District not found")
    if user.role is UserRole.GOV_OFFICIAL and user.district_id and user.district_id != district_id:
        raise HTTPException(status_code=403, detail="Your jurisdiction does not cover this district")

    rollup = _district_rollup(db, district)
    hospitals = list(db.execute(select(Hospital).where(Hospital.district_id == district_id)).scalars().all())

    facilities = []
    for h in hospitals:
        view = live_store.get(h.id)
        facilities.append(
            {
                "id": h.id,
                "name": h.name,
                "short_name": h.short_name,
                "type": h.type.value,
                "verification": h.verification.value,
                "integration": h.integration.value,
                "total_beds": h.total_beds,
                "total_icu": h.total_icu,
                "beds_available": view.beds_effective if view else None,
                "icu_available": view.icu_effective if view else None,
                "vent_available": view.vent_effective if view else None,
                "occupancy_pct": round(
                    (h.total_beds - view.beds_effective) / h.total_beds * 100, 1
                ) if view and h.total_beds else None,
                "ed_congestion": view.ed_congestion if view else None,
                "ed_waiting": view.ed_waiting if view else None,
                "holds": view.holds_active if view else 0,
                "last_report_age_seconds": int((utcnow() - view.recorded_at).total_seconds()) if view else None,
            }
        )

    # Trend line: hourly mean occupancy over the window, computed from the
    # append-only series rather than the live projection so historic points do
    # not drift as new reports land.
    since = utcnow() - timedelta(hours=hours)
    rows = db.execute(
        select(CapacityRecord)
        .join(Hospital, Hospital.id == CapacityRecord.hospital_id)
        .where(Hospital.district_id == district_id, CapacityRecord.recorded_at >= since)
    ).scalars().all()

    buckets: dict[str, dict] = {}
    for r in rows:
        key = r.recorded_at.strftime("%Y-%m-%dT%H:00")
        b = buckets.setdefault(key, {"t": key + ":00Z", "beds": [], "icu": [], "vent": [], "ed_waiting": [], "cong": []})
        b["beds"].append(r.beds_available)
        b["icu"].append(r.icu_available)
        b["vent"].append(r.ventilators_available)
        b["ed_waiting"].append(r.ed_waiting)
        b["cong"].append(CONGESTION_WEIGHT.get(r.ed_congestion.value, 0.5))

    trend = [
        {
            "t": b["t"],
            "beds_available": round(sum(b["beds"]) / len(b["beds"]), 1),
            "icu_available": round(sum(b["icu"]) / len(b["icu"]), 1),
            "vent_available": round(sum(b["vent"]) / len(b["vent"]), 1),
            "ed_waiting": round(sum(b["ed_waiting"]) / len(b["ed_waiting"]), 1),
            "ed_congestion_index": round(sum(b["cong"]) / len(b["cong"]) * 100, 1),
        }
        for b in sorted(buckets.values(), key=lambda x: x["t"])
    ]

    incidents = open_incidents(db, district_id=district_id)

    return {
        **rollup,
        "trend": trend,
        "facilities": sorted(facilities, key=lambda f: -(f["occupancy_pct"] or 0)),
        "open_incidents": [
            {
                "id": i.id,
                "reference": i.reference,
                "category": i.category.value,
                "urgency": i.urgency.value,
                "status": i.status.value,
                "landmark": i.landmark,
                "created_at": i.created_at.isoformat() + "Z",
                "age_minutes": int((utcnow() - i.created_at).total_seconds() // 60),
                "hospital_id": i.assigned_hospital_id,
            }
            for i in incidents
        ],
        "access": {"role": user.role.value, "drilldown_enabled": user.role in (UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL)},
    }


@router.get("/facility/{hospital_id}/trend")
def facility_trend(
    hospital_id: int,
    user: CurrentUser,
    db: Session = Depends(get_db),
    hours: int = Query(default=72, ge=6, le=720),
):
    hospital = db.get(Hospital, hospital_id)
    if hospital is None:
        raise HTTPException(status_code=404, detail="Hospital not found")

    since = utcnow() - timedelta(hours=hours)
    rows = list(
        db.execute(
            select(CapacityRecord)
            .where(CapacityRecord.hospital_id == hospital_id, CapacityRecord.recorded_at >= since)
            .order_by(CapacityRecord.recorded_at.asc())
        ).scalars().all()
    )

    buckets: dict[str, dict] = {}
    for r in rows:
        key = r.recorded_at.strftime("%Y-%m-%dT%H:00")
        b = buckets.setdefault(key, {"t": key + ":00Z", "n": 0, "beds": 0, "icu": 0, "vent": 0})
        b["n"] += 1
        b["beds"] += r.beds_available
        b["icu"] += r.icu_available
        b["vent"] += r.ventilators_available

    series = [
        {
            "t": b["t"],
            "reports": b["n"],
            "beds_available": round(b["beds"] / b["n"], 1),
            "icu_available": round(b["icu"] / b["n"], 1),
            "vent_available": round(b["vent"] / b["n"], 1),
        }
        for b in sorted(buckets.values(), key=lambda x: x["t"])
    ]

    quarantined = sum(1 for r in rows if r.quarantined)
    return {
        "hospital": {"id": hospital.id, "name": hospital.name, "total_beds": hospital.total_beds},
        "window_hours": hours,
        "samples": len(rows),
        "quarantined_samples": quarantined,
        "reporting_completeness": round(len(buckets) / hours * 100, 1) if hours else None,
        "series": series,
    }


# --------------------------------------------------------------------------- #
# Surge / disaster mode
# --------------------------------------------------------------------------- #


@router.post("/surge", status_code=201)
async def open_surge(
    payload: SurgeCreate,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL)),
    db: Session = Depends(get_db),
):
    if db.get(District, payload.district_id) is None:
        raise HTTPException(status_code=422, detail="Unknown district")
    existing = active_surge(db, payload.district_id)
    if existing:
        raise HTTPException(status_code=409, detail=f"Surge mode already active: {existing.title}")

    event = SurgeEvent(
        title=payload.title,
        district_id=payload.district_id,
        scope=payload.scope,
        note=payload.note,
        opened_by=user.id,
        opened_at=utcnow(),
    )
    db.add(event)
    db.flush()
    audit.record(
        db,
        action="surge.open",
        entity_type="surge",
        entity_id=event.id,
        summary=f"SURGE MODE — {payload.title} ({payload.scope})",
        actor=user,
    )
    db.commit()

    # Freshness windows relax for the affected district, so facilities are not
    # greyed out mid-response because their last report is 20 minutes old.
    await live_store.publish(
        "surge.opened", {"id": event.id, "title": event.title, "district_id": event.district_id, "scope": event.scope}
    )
    return {"id": event.id, "title": event.title, "opened_at": event.opened_at.isoformat() + "Z"}


@router.delete("/surge/{surge_id}")
async def close_surge(
    surge_id: int,
    user: User = Depends(require_roles(UserRole.PLATFORM_ADMIN, UserRole.GOV_OFFICIAL)),
    db: Session = Depends(get_db),
):
    event = db.get(SurgeEvent, surge_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Surge event not found")
    if not event.active:
        raise HTTPException(status_code=409, detail="Surge event already closed")

    event.active = False
    event.closed_at = utcnow()
    audit.record(
        db,
        action="surge.close",
        entity_type="surge",
        entity_id=event.id,
        summary=f"Surge mode stood down — {event.title}",
        actor=user,
    )
    db.commit()
    await live_store.publish("surge.closed", {"id": event.id, "title": event.title})
    return {"id": event.id, "active": False, "duration_minutes": int((event.closed_at - event.opened_at).total_seconds() // 60)}


@router.get("/surge/active")
def current_surge(db: Session = Depends(get_db)):
    events = list(db.execute(select(SurgeEvent).where(SurgeEvent.active.is_(True))).scalars().all())
    return {
        "active": bool(events),
        "results": [
            {
                "id": e.id,
                "title": e.title,
                "district_id": e.district_id,
                "scope": e.scope,
                "note": e.note,
                "opened_at": e.opened_at.isoformat() + "Z",
                "elapsed_minutes": int((utcnow() - e.opened_at).total_seconds() // 60),
            }
            for e in events
        ],
    }


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #


@router.get("/export/capacity.csv")
def export_capacity(
    user: User = Depends(require_roles(UserRole.GOV_OFFICIAL, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
    district_id: int | None = None,
    hours: int = Query(default=168, ge=1, le=2160),
):
    """Streamed rather than buffered: a state-wide week of 5-minute samples is
    millions of rows and will not fit in a request-scoped allocation."""
    since = utcnow() - timedelta(hours=hours)
    stmt = (
        select(CapacityRecord, Hospital)
        .join(Hospital, Hospital.id == CapacityRecord.hospital_id)
        .where(CapacityRecord.recorded_at >= since)
    )
    if district_id:
        stmt = stmt.where(Hospital.district_id == district_id)
    if user.role is UserRole.GOV_OFFICIAL and user.district_id:
        stmt = stmt.where(Hospital.district_id == user.district_id)

    def rows():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(
            [
                "hospital_id",
                "hospital_name",
                "district_id",
                "type",
                "recorded_at_utc",
                "beds_available",
                "beds_total",
                "icu_available",
                "icu_total",
                "ventilators_available",
                "ventilators_total",
                "ed_congestion",
                "ed_waiting",
                "source",
                "trust_state",
                "quarantined",
            ]
        )
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)

        for record, hospital in db.execute(stmt.order_by(CapacityRecord.recorded_at.desc())).all():
            writer.writerow(
                [
                    hospital.id,
                    hospital.name,
                    hospital.district_id,
                    hospital.type.value,
                    record.recorded_at.isoformat() + "Z",
                    record.beds_available,
                    hospital.total_beds,
                    record.icu_available,
                    hospital.total_icu,
                    record.ventilators_available,
                    hospital.total_ventilators,
                    record.ed_congestion.value,
                    record.ed_waiting,
                    record.source.value,
                    record.trust_state,
                    "yes" if record.quarantined else "no",
                ]
            )
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate(0)

    filename = f"medmesh-capacity-{utcnow():%Y%m%d-%H%M}.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/incidents.csv")
def export_incidents(
    user: User = Depends(require_roles(UserRole.GOV_OFFICIAL, UserRole.PLATFORM_ADMIN)),
    db: Session = Depends(get_db),
    days: int = Query(default=30, ge=1, le=365),
):
    """Incident export for policy review. Every column here is non-identifying by
    construction -- the schema has nowhere to put a patient."""
    since = utcnow() - timedelta(days=days)
    stmt = select(Incident).where(Incident.created_at >= since)
    incidents = list(db.execute(stmt.order_by(Incident.created_at.desc())).scalars().all())
    hospitals = {h.id: h for h in db.execute(select(Hospital)).scalars().all()}

    def rows():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(
            [
                "reference",
                "created_at_utc",
                "category",
                "urgency",
                "district_id",
                "landmark",
                "status",
                "assigned_hospital_id",
                "assigned_hospital",
                "requires_icu",
                "requires_ventilator",
                "requires_blood",
                "dispatch_minutes",
                "time_to_hospital_minutes",
            ]
        )
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        for i in incidents:
            hospital = hospitals.get(i.assigned_hospital_id)
            writer.writerow(
                [
                    i.reference,
                    i.created_at.isoformat() + "Z",
                    i.category.value,
                    i.urgency.value,
                    i.district_id,
                    i.landmark,
                    i.status.value,
                    i.assigned_hospital_id or "",
                    hospital.name if hospital else "",
                    "yes" if i.requires_icu else "no",
                    "yes" if i.requires_ventilator else "no",
                    "yes" if i.requires_blood else "no",
                    round((i.dispatched_at - i.created_at).total_seconds() / 60, 2) if i.dispatched_at else "",
                    round((i.arrived_at - i.created_at).total_seconds() / 60, 2) if i.arrived_at else "",
                ]
            )
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate(0)

    filename = f"medmesh-incidents-{utcnow():%Y%m%d}.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/sla")
def sla_report(user: CurrentUser, db: Session = Depends(get_db), days: int = Query(default=7, ge=1, le=90)):
    """Operational SLA numbers for the platform team's own dashboard. Median
    dispatch latency is the headline metric -- it is the number the whole
    platform exists to move."""
    since = utcnow() - timedelta(days=days)
    incidents = list(
        db.execute(select(Incident).where(Incident.created_at >= since).order_by(Incident.created_at)).scalars().all()
    )

    dispatch_secs = [
        (i.dispatched_at - i.created_at).total_seconds()
        for i in incidents
        if i.dispatched_at
    ]
    arrival_secs = [(i.arrived_at - i.created_at).total_seconds() for i in incidents if i.arrived_at]

    def pct(values: list[float], p: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        idx = min(len(ordered) - 1, int(round((len(ordered) - 1) * p)))
        return round(ordered[idx], 1)

    total_samples = db.execute(
        select(func.count()).select_from(CapacityRecord).where(CapacityRecord.recorded_at >= since)
    ).scalar_one()
    quarantined_samples = db.execute(
        select(func.count())
        .select_from(CapacityRecord)
        .where(CapacityRecord.recorded_at >= since, CapacityRecord.quarantined.is_(True))
    ).scalar_one()

    return {
        "window_days": days,
        "incidents": {
            "total": len(incidents),
            "dispatched": len(dispatch_secs),
            "completed": len(arrival_secs),
            "dispatch_seconds_p50": pct(dispatch_secs, 0.5),
            "dispatch_seconds_p90": pct(dispatch_secs, 0.9),
            "arrival_minutes_p50": round(pct(arrival_secs, 0.5) / 60, 1) if arrival_secs else None,
            "arrival_minutes_p90": round(pct(arrival_secs, 0.9) / 60, 1) if arrival_secs else None,
        },
        "ingest": {
            "samples": total_samples,
            "quarantined": quarantined_samples,
            "quarantine_rate_pct": round(quarantined_samples / total_samples * 100, 2) if total_samples else 0.0,
        },
        "realtime": {"websocket_clients": live_store.subscriber_count},
    }
