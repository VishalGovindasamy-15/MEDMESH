"""WebSocket fan-out.

One endpoint, role-filters applied at subscribe time rather than at the client.
A hospital dashboard receives updates for its own facility only; the dispatcher
console and the government wall display receive everything. Client-side
filtering would mean shipping the whole state's capacity stream to every
connected tablet, which is both a privacy question and a bandwidth one.

Initial snapshot-then-delta: the client gets current state on connect so it never
renders an empty grid, then only deltas. Reconnect is cheap and idempotent.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from ..database import SessionLocal
from ..live import live_store
from ..models import Hospital, User, UserRole
from ..repository import latest_capacity_map, trust_scores

router = APIRouter(tags=["realtime"])


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
            if envelope.get("event") in wanted:
                await websocket.send_text(json.dumps(envelope, default=str))
    except WebSocketDisconnect:
        pass
    except Exception:
        with contextlib.suppress(Exception):
            await websocket.close()
    finally:
        live_store.unsubscribe(queue)
