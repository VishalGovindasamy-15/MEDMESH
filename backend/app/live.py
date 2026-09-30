"""Live capacity store + fan-out.

Production runs this on Redis (per the architecture report) with Redis pub/sub
carrying the fan-out to WebSocket gateways. The pilot keeps the identical
interface -- `LiveStore` -- but backs it with a process-local dict and an
asyncio fan-out, so the API boots with zero infrastructure and the swap later is
a single class substitution.

The projection holds one `CapacityView` per hospital, which is what the public
portal, dispatcher console and driver app all read. Sub-second reads come from
here; PostgreSQL is only touched on ingest, and to rebuild the projection at
startup.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Iterable

from .models import EdCongestion, IntegrationMode, utcnow


@dataclass(slots=True)
class CapacityView:
    hospital_id: int
    beds_available: int
    total_beds: int
    icu_available: int
    total_icu: int
    ventilators_available: int
    total_ventilators: int
    ed_congestion: str
    ed_waiting: int
    blood_units: int
    antivenom_vials: int
    source: str
    recorded_at: datetime
    trust_state: str = "live"
    anomaly_flags: list[str] = field(default_factory=list)
    quarantined: bool = False
    # Holds are overlaid onto the projection rather than being a separate lookup
    # so a dispatcher never sees a bed that is already promised to another crew.
    holds_active: int = 0
    version: int = 1

    @property
    def beds_effective(self) -> int:
        return max(0, self.beds_available - self._holds_for("bed"))

    _holds_by_resource: dict[str, int] = field(default_factory=dict, repr=False)

    def _holds_for(self, resource: str) -> int:
        return self._holds_by_resource.get(resource, 0)

    @property
    def icu_effective(self) -> int:
        return max(0, self.icu_available - self._holds_for("icu"))

    @property
    def vent_effective(self) -> int:
        return max(0, self.ventilators_available - self._holds_for("ventilator"))

    def to_wire(self) -> dict[str, Any]:
        d = asdict(self)
        d["recorded_at"] = self.recorded_at.isoformat() + "Z"
        d.pop("_holds_by_resource", None)
        d["beds_effective"] = self.beds_effective
        d["icu_effective"] = self.icu_effective
        d["vent_effective"] = self.vent_effective
        return d


class LiveStore:
    def __init__(self) -> None:
        self._views: dict[int, CapacityView] = {}
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._lock = asyncio.Lock()
        self._seq = 0

    # -- projection --------------------------------------------------------
    def put(self, view: CapacityView) -> CapacityView:
        self._views[view.hospital_id] = view
        return view

    def get(self, hospital_id: int) -> CapacityView | None:
        return self._views.get(hospital_id)

    def all(self) -> Iterable[CapacityView]:
        return self._views.values()

    def touch(self, hospital_id: int) -> None:
        v = self._views.get(hospital_id)
        if v:
            v.version += 1

    def set_hold_counts(self, hospital_id: int, counts: dict[str, int]) -> CapacityView | None:
        v = self._views.get(hospital_id)
        if v is None:
            return None
        v._holds_by_resource = {k: c for k, c in counts.items() if c}
        v.holds_active = sum(v._holds_by_resource.values())
        v.version += 1
        return v

    def is_empty(self) -> bool:
        return not self._views

    # -- fan-out -----------------------------------------------------------
    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def _fan_out(self, event: str, payload: dict[str, Any]) -> None:
        """Envelope and enqueue. Must be called on the event loop thread.

        Slow consumers are dropped rather than allowed to back-pressure the
        ingest path -- an ops wall display that has stopped reading must never
        stall a hospital's update.
        """
        self._seq += 1
        envelope = {
            "seq": self._seq,
            "event": event,
            "at": utcnow().isoformat() + "Z",
            "data": payload,
        }
        for q in list(self._subscribers):
            if q.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(envelope)

    async def publish(self, event: str, payload: dict[str, Any]) -> None:
        self._fan_out(event, payload)

    async def broadcast_capacity(self, view: CapacityView) -> None:
        await self.publish("capacity.updated", {"hospital_id": view.hospital_id, "capacity": view.to_wire()})


# Imported as a module-level singleton by routers. Swap the class for a Redis
# implementation and nothing above this line changes.
# --------------------------------------------------------------------------- #
# Publishing from synchronous code
#
# Most of the write paths on this platform are synchronous: FastAPI runs a `def`
# endpoint in a worker thread, the connector ingest route is a plain function,
# the simulator is a plain function, and the seeder is a script. All of them
# update the in-memory capacity projection, and none of them can `await` a
# fan-out -- which is why the websocket clients used to learn about a capacity
# change only when some *other*, async code path happened to publish.
#
# The fix is to hand the application's event loop to this module at startup and
# schedule the fan-out onto it with `call_soon_threadsafe`. The queues are plain
# `asyncio.Queue` objects and are not thread-safe, so the hop back onto the loop
# thread is not an optimisation -- calling `_fan_out` from a worker thread would
# corrupt the queue's internal state under load.
# --------------------------------------------------------------------------- #

def _bind_methods() -> None:
    """Attach the synchronous-publishing helpers to the singleton.

    Defined here, after the class, because they are the one part of the store
    that exists purely for the loop/thread hand-off and reading them next to the
    explanation is more useful than having them buried in the class body.
    """

    def bind_loop(self: LiveStore, loop: asyncio.AbstractEventLoop | None) -> None:
        """Record the loop that websocket subscribers are attached to."""
        self._loop = loop

    def publish_soon(self: LiveStore, event: str, payload: dict[str, Any]) -> bool:
        """Fire-and-forget fan-out from a synchronous caller.

        Returns whether the event was scheduled, which is genuinely useful to
        the tests: a synchronous context (pytest, a CLI, the seeder) has no
        clients to notify, and that is a different situation from a live server
        dropping an event. Never raises -- a capacity update must not fail
        because the socket layer is unavailable.
        """
        loop = getattr(self, "_loop", None)
        if loop is None or loop.is_closed() or not loop.is_running():
            return False
        try:
            loop.call_soon_threadsafe(self._fan_out, event, payload)
        except RuntimeError:
            # Loop closed underneath us during shutdown; the update is
            # persisted, which is what matters.
            return False
        return True

    def publish_capacity_soon(self: LiveStore, hospital_id: int) -> bool:
        """Tell subscribed surfaces that a facility's capacity changed.

        Takes an id rather than a view so that the caller cannot pass a stale
        snapshot: the projection is the authority, and this reads it at the
        moment of publishing.
        """
        view = self.get(hospital_id)
        if view is None:
            return False
        return self.publish_soon(
            "capacity.updated", {"hospital_id": hospital_id, "capacity": view.to_wire()}
        )

    LiveStore._loop = None  # type: ignore[attr-defined]
    LiveStore.bind_loop = bind_loop  # type: ignore[attr-defined]
    LiveStore.publish_soon = publish_soon  # type: ignore[attr-defined]
    LiveStore.publish_capacity_soon = publish_capacity_soon  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# Serialisation helpers used in HTTP responses
# --------------------------------------------------------------------------- #


def dump_capacity(view: CapacityView | None, *, include_hold_detail: bool = True) -> dict[str, Any] | None:
    if view is None:
        return None
    return view.to_wire()


def jsonb(raw: str | None) -> Any:
    if not raw:
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return []


# The singleton is created last so that its synchronous-publishing helpers are
# already attached when routers import it.
live_store = LiveStore()
_bind_methods()
