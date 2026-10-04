"""WebSocket fan-out.

One endpoint, role-filters applied at subscribe time rather than at the client.
A hospital dashboard receives updates for its own facility only; the dispatcher
console and the government wall display receive everything. Client-side
filtering would mean shipping the whole state's capacity stream to every
connected tablet, which is both a privacy question and a bandwidth one.

Initial snapshot-then-delta: the client gets current state on connect so it never
renders an empty grid, then only deltas. Reconnect is cheap and idempotent.

DELTA SCOPING CONTRACT (fourth audit). The snapshot is the public directory and
stays whole; the deltas are not, and hiding a button in the UI is not a scope.
For every envelope after the snapshot:

  capacity.updated, doctor.duty
      Everyone, including anonymous sockets. The directory publishes these
      figures on unauthenticated HTTP by design; the socket carries no more.
  surge.opened, surge.closed
      Operations (dispatcher, platform admin) and government officials.
  notification.created
      The addressed user (``user_id == me``), or — for facility-addressed rows,
      which carry ``user_id`` null and a ``hospital_id`` — any hospital admin
      of that facility. A per-user row addressed to somebody else is nobody
      else's business.
  hospital.inbound, feedback.created, hold.placed, hold.released
      Operations, plus hospital admins of the facility the event names
      (null-guarded: an event without a facility id is operations-only).
  incident.*
      Operations. A driver never sees ``incident.created`` (the queue is not
      theirs) and sees every other incident event only for the trip carrying
      them — resolved by a per-event join, so re-crewing mid-connection
      changes what they see. A hospital admin never sees ``incident.created``
      either, and sees the rest only when the incident names their facility
      as destination or as the destination it was re-routed away from.
  anything unknown
      Operations only. New event kinds fail closed until somebody decides
      who they belong to.

An anonymous socket therefore receives public directory deltas and nothing
else, and ``scope=mine`` still narrows the snapshot when a client asks.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from ..database import SessionLocal
from ..live import live_store
from ..models import Hospital, Incident, User, UserRole
from ..repository import latest_capacity_map, trust_scores

router = APIRouter(tags=["realtime"])

PUBLIC_DELTAS = {"capacity.updated", "doctor.duty"}
SURGE_DELTAS = {"surge.opened", "surge.closed"}
FACILITY_DELTAS = {"hospital.inbound", "feedback.created", "hold.placed", "hold.released"}
OPS_ROLES = (UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN)


def _authenticate(token: str | None) -> User | None:
    if not token:
        return None
    from ..security import decode_token

    try:
        claims = decode_token(token)
    except Exception:
        return None
    db = SessionLocal()
    try:
        user = db.get(User, int(claims["sub"]))
        if user is None or not user.is_active:
            return None
        db.expunge(user)
        return user
    finally:
        db.close()


def _assigned_to_driver(incident_id: int | None, user_id: int) -> bool:
    """Is this user's linked ambulance carrying this incident, right now?

    Re-resolved per event on purpose: a trip re-crewed mid-connection must
    stop reaching the old driver and start reaching the new one, and a cached
    answer at subscribe time would get that wrong in both directions.
    """
    if incident_id is None:
        return False
    db = SessionLocal()
    try:
        row = db.execute(
            select(Incident.assigned_ambulance_id).where(Incident.id == incident_id)
        ).first()
        if row is None or row[0] is None:
            return False
        from ..models import Ambulance

        amb = db.get(Ambulance, row[0])
        return amb is not None and amb.driver_id == user_id
    finally:
        db.close()


def _visible(user: User | None, event: str, data: dict) -> bool:
    """May this socket receive this envelope? See the module contract."""
    if event in PUBLIC_DELTAS:
        return True
    if user is None:
        return False
    is_ops = user.role in OPS_ROLES
    if event in SURGE_DELTAS:
        return is_ops or user.role is UserRole.GOV_OFFICIAL
    if event == "notification.created":
        owner = data.get("user_id")
        if owner:
            return owner == user.id
        facility = data.get("hospital_id")
        if facility:
            return user.role is UserRole.HOSPITAL_ADMIN and user.hospital_id == facility
        return False
    if event in FACILITY_DELTAS:
        if is_ops:
            return True
        facility = data.get("hospital_id")
        return (
            facility is not None
            and user.role is UserRole.HOSPITAL_ADMIN
            and user.hospital_id == facility
        )
    if event.startswith("incident."):
        if is_ops:
            return True
        if event == "incident.created":
            return False
        incident_id = data.get("incident_id") or data.get("id")
        if user.role is UserRole.DRIVER:
            return _assigned_to_driver(incident_id, user.id)
        if user.role is UserRole.HOSPITAL_ADMIN:
            return user.hospital_id is not None and user.hospital_id in (
                data.get("hospital_id"),
                data.get("previous_hospital_id"),
            )
        return False
    # Unknown event kind: fail closed to operations.
    return is_ops


def _snapshot_for(user: User | None) -> dict:
    """Initial state pushed on connect."""
    from ..live import CapacityView  # local import avoids a cycle at module load

    db = SessionLocal()
    try:
        hospitals = list(db.execute(select(Hospital)).scalars().all())
        rows = latest_capacity_map(db, [h.id for h in hospitals])
        scores = trust_scores(db, hospitals)
        payload = []
        for h in hospitals:
            view = live_store.get(h.id)
            if view is None:
                continue
            row = rows.get(h.id)
            payload.append(
                {
                    "hospital": {
                        "id": h.id,
                        "name": h.name,
                        "short_name": h.short_name,
                        "type": h.type.value,
                        "district_id": h.district_id,
                        "lat": h.lat,
                        "lng": h.lng,
                        "verification": h.verification.value,
                        "integration": h.integration.value,
                    },
                    "capacity": view.to_wire(),
                    "ed_congestion": row.ed_congestion.value if row else view.ed_congestion,
                    "trust": scores.get(h.id),
                }
            )
        return {"hospitals": payload, "count": len(payload)}
    finally:
        db.close()


@router.websocket("/ws/feed")
async def feed(
    websocket: WebSocket,
    token: str | None = Query(default=None),
    scope: str = Query(default="all", pattern="^(all|mine)$"),
):
    user = _authenticate(token)
    await websocket.accept()

    hospital_filter: int | None = None
    if user is not None and user.role is UserRole.HOSPITAL_ADMIN and scope == "mine":
        hospital_filter = user.hospital_id

    queue = live_store.subscribe()
    try:
        snapshot = _snapshot_for(user)
        if hospital_filter is not None and user is not None and user.hospital_id:
            snapshot["hospitals"] = [h for h in snapshot["hospitals"] if h["hospital"]["id"] == hospital_filter]
            snapshot["count"] = len(snapshot["hospitals"])
        await websocket.send_text(json.dumps({"event": "snapshot", "data": snapshot}, default=str))

        # Heartbeat doubles as a liveness check for the ops wall display: a
        # silently dead socket is worse than a visibly broken one.
        last_ping = asyncio.get_event_loop().time()
        while True:
            try:
                envelope = await asyncio.wait_for(queue.get(), timeout=20.0)
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"event": "ping", "data": {"t": last_ping}}))
                continue

            if hospital_filter is not None:
                hid = envelope.get("data", {}).get("hospital_id")
                if hid is not None and hid != hospital_filter:
                    continue
            if not _visible(user, envelope.get("event", ""), envelope.get("data", {}) or {}):
                continue
            await websocket.send_text(json.dumps(envelope, default=str))
    except WebSocketDisconnect:
        pass
    except Exception:
        # Never let a single bad client take down the ingest loop.
        with contextlib.suppress(Exception):
            await websocket.close()
    finally:
        live_store.unsubscribe(queue)


@router.websocket("/ws/incidents")
async def incident_feed(websocket: WebSocket, token: str | None = Query(default=None)):
    """Dispatcher-only stream: incidents and holds, no capacity noise."""
    user = _authenticate(token)
    if user is None or user.role not in (UserRole.DISPATCHER, UserRole.PLATFORM_ADMIN, UserRole.DRIVER):
        await websocket.close(code=4403)
        return

    await websocket.accept()
    queue = live_store.subscribe()
    wanted = {"incident.created", "incident.dispatched", "incident.rerouted", "incident.status", "hospital.inbound"}
    try:
        while True:
            try:
                envelope = await asyncio.wait_for(queue.get(), timeout=25.0)
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"event": "ping", "data": {}}))
                continue
            if envelope.get("event") not in wanted:
                continue
            # Same contract as the main feed: a driver on this socket gets
            # their own trip's events, not the whole queue's.
            if not _visible(user, envelope.get("event", ""), envelope.get("data", {}) or {}):
                continue
            await websocket.send_text(json.dumps(envelope, default=str))
    except WebSocketDisconnect:
        pass
    except Exception:
        with contextlib.suppress(Exception):
            await websocket.close()
    finally:
        live_store.unsubscribe(queue)
