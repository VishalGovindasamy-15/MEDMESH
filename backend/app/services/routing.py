"""Road routing as an input to matching, not a decoration on a map.

The problem this module exists to solve
---------------------------------------

The first version of the matching engine scored proximity from a geometric
estimate: straight-line distance inflated by a winding factor, divided by an
assumed speed. It then drew a Google route on the map *after* the decision was
made. That ordering is backwards, and it produces decisions a dispatcher would
immediately disagree with, because the two numbers disagree in exactly the cases
that matter:

  * A river, a railway line or a hill between two points makes the straight line
    a fiction. Coimbatore to the Nilgiris is 55 km as the crow flies and 95 km by
    the only road that exists, and the road climbs.
  * A national highway that runs the long way round can be *faster* than the
    short way through a city. Twelve kilometres of city traffic is a worse trip
    than twenty-eight kilometres of NH.
  * Two facilities can be equidistant in metres and twenty minutes apart in time.

So routing here answers the question the ranking actually asks -- "how long does
an ambulance take to reach this facility" -- and the answer is an input to the
score and to the catchment test. The map is a rendering of a decision that was
already made on road data, not the source of it.

Order of operations
-------------------

    incident origin ─┐
                     ├─→ geometric prefilter ─→ road matrix ─→ ranked shortlist
    candidate set ───┘        (free)              (billed)      (scored on road ETA)

The prefilter matters commercially. A district-scoped candidate set is around
150 facilities; refining all of them through Distance Matrix is several billed
requests per shortlist, and the shortlist is rebuilt every time the console
refreshes. Facilities whose *straight-line* distance already puts them outside
the catchment cannot come back inside it -- a road is never shorter than a
straight line -- so they are dropped before a single request is spent. Only the
survivors are worth paying to route.

Caching
-------

Distance and duration have different shelf lives, and treating them the same
wastes money in one direction and serves stale numbers in the other:

  * Road *distance* between two fixed points is effectively a property of the
    road network. It does not change when traffic changes. Long TTL.
  * Road *duration* is traffic. It is worth what it cost only while it is fresh.
    Short TTL.

So the cache stores the pair and expires the duration component sooner, falling
back to re-asking rather than to a stale figure.

Failure is normal, and must not become an outage
------------------------------------------------

Routing is a third-party network call in the path of an emergency dispatch. It is
treated as such: a hard timeout well inside a human's tolerance, per-element
fallback to the geometric estimate when the provider has no answer for one
destination, and whole-request fallback when the provider itself is unreachable.

A leg that came back estimated says so, and the shortlist carries the count of
estimated legs, so the console can tell a dispatcher whether the ranking in front
of them was built on roads or on geometry. The engine's behaviour when routing
fails is deliberately *degraded and labelled*, never blocked and never silent.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Iterable, Protocol, Sequence

from ..config import settings
from .geo import Leg, bearing_deg, estimate_leg, haversine_km

log = logging.getLogger("medmesh.routing")

# Google caps a standard Distance Matrix request at 25 destinations; a premium
# plan raises it to 100. Chunking at the conservative limit means the code is
# correct on either plan, and on a big candidate set it simply makes more calls.
MAX_ELEMENTS_PER_REQUEST = 25

DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json"


# --------------------------------------------------------------------------- #
# Provider interface
# --------------------------------------------------------------------------- #


class RoutingProvider(Protocol):
    """Resolve road legs from one origin to many destinations.

    Implementations must be honest: a leg returned with `provider="estimate"` is
    understood by every caller to be geometry, not a road. That is the contract
    the console relies on when it warns a dispatcher.
    """

    name: str

    def matrix(
        self,
        origin: tuple[float, float],
        destinations: Sequence[tuple[float, float]],
    ) -> list[Leg | None]:
        """One leg per destination, in order. `None` means "no answer available",
        and the caller substitutes an estimate."""
        ...


@dataclass(slots=True)
class _CacheEntry:
    road_km: float
    duration_minutes: float
    traffic_aware: bool
    distance_at: float
    duration_at: float


class GoogleDistanceMatrixProvider:
    """Distance Matrix: one request resolves an origin against many destinations.

    Distance Matrix rather than Directions because of the shape of the question.
    The engine asks "how far is each of these thirty hospitals" -- thirty
    questions with one answer each. Directions answers one pair per request and
    returns geometry nobody in this path needs yet, so it would be thirty
    billed calls where one will do.

    Directions is still the right API for the *chosen* route, where geometry and
    turn-by-turn are the point, and the crew screen uses it for exactly that.
    """

    name = "google-distance-matrix"

    def __init__(self, api_key: str, *, timeout: float | None = None) -> None:
        self.api_key = api_key
        self.timeout = timeout if timeout is not None else settings.routing_timeout_seconds
        self._cache: dict[str, _CacheEntry] = {}

    # -- cache ------------------------------------------------------------- #

    @staticmethod
    def _key(origin: tuple[float, float], destination: tuple[float, float]) -> str:
        # Rounded to ~11 m. Two incidents on the same street corner should share
        # a cache entry; two a kilometre apart should not.
        return f"{origin[0]:.4f},{origin[1]:.4f}->{destination[0]:.4f},{destination[1]:.4f}"

    def _from_cache(self, key: str) -> _CacheEntry | None:
        entry = self._cache.get(key)
        if entry is None:
            return None
        now = time.monotonic()
        distance_fresh = now - entry.distance_at < settings.routing_distance_ttl_minutes * 60
        duration_fresh = now - entry.duration_at < settings.routing_duration_ttl_minutes * 60
        if not distance_fresh:
            self._cache.pop(key, None)
            return None
        # Distance still valid but duration stale: return the entry and let the
        # caller refresh just the duration. The split is the whole point -- a
        # known 14 km road does not become an unknown road when the clock ticks.
        return entry if duration_fresh else replace(entry, duration_at=0.0)

    def _store(self, key: str, *, road_km: float, minutes: float, traffic_aware: bool) -> None:
        now = time.monotonic()
        self._cache[key] = _CacheEntry(
            road_km=road_km,
            duration_minutes=minutes,
            traffic_aware=traffic_aware,
            distance_at=now,
            duration_at=now,
        )
        # Bounded so a long-running process cannot grow without limit. Simple
        # eviction: drop the oldest tenth once over the cap. An LRU is not worth
        # the bookkeeping here -- misses cost one batched request, not a call.
        if len(self._cache) > settings.routing_cache_entries:
            for stale_key in list(self._cache)[: settings.routing_cache_entries // 10]:
                self._cache.pop(stale_key, None)

    def cache_stats(self) -> dict:
        return {"entries": len(self._cache), "provider": self.name if self.api_key else "estimate"}

    def clear_cache(self) -> None:
        self._cache.clear()

    # -- resolution -------------------------------------------------------- #

    def matrix(
        self,
        origin: tuple[float, float],
        destinations: Sequence[tuple[float, float]],
    ) -> list[Leg | None]:
        if not destinations:
            return []

        results: list[Leg | None] = [None] * len(destinations)
        pending: list[int] = []

        for index, destination in enumerate(destinations):
            cached = self._from_cache(self._key(origin, destination))
            if cached is None:
                pending.append(index)
                continue
            if cached.duration_at == 0.0:
                # Distance known, traffic unknown: route it again so the ETA is
                # live rather than the one measured when the cache was filled.
                pending.append(index)
                continue
            results[index] = self._leg(
                origin, destination, cached.road_km, cached.duration_minutes, cached.traffic_aware
            )

        if not pending:
            return results

        for start in range(0, len(pending), MAX_ELEMENTS_PER_REQUEST):
            chunk = pending[start : start + MAX_ELEMENTS_PER_REQUEST]
            resolved = self._request(origin, [destinations[i] for i in chunk])
            for slot, index in enumerate(chunk):
                destination = destinations[index]
                element = resolved[slot] if slot < len(resolved) else None
                if element is None:
                    # Provider had no answer for this one destination (an island,
                    # a point with no road access). Cached negatively only by
                    # omission: the caller estimates it and says so.
                    continue
                road_km, minutes, traffic_aware = element
                self._store(
                    self._key(origin, destination),
                    road_km=road_km,
                    minutes=minutes,
                    traffic_aware=traffic_aware,
                )
                results[index] = self._leg(origin, destination, road_km, minutes, traffic_aware)

        return results

    def _leg(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        road_km: float,
        minutes: float,
        traffic_aware: bool,
    ) -> Leg:
        eta = max(1, int(round(minutes)))
        straight = haversine_km(origin[0], origin[1], destination[0], destination[1])
        return Leg(
            straight_km=round(straight, 2),
            road_km=round(road_km, 1),
            eta_minutes=eta,
            bearing_deg=round(bearing_deg(origin[0], origin[1], destination[0], destination[1]), 1),
            label=f"{road_km:.1f} km · {eta} min",
            provider=self.name,
            traffic_aware=traffic_aware,
        )

    def _request(
        self,
        origin: tuple[float, float],
        destinations: Sequence[tuple[float, float]],
    ) -> list[tuple[float, float, bool] | None]:
        """Return (road_km, minutes, traffic_aware) per destination, or None."""
        params = {
            "origins": f"{origin[0]:.5f},{origin[1]:.5f}",
            "destinations": "|".join(f"{lat:.5f},{lng:.5f}" for lat, lng in destinations),
            "mode": "driving",
            # departure_time in the future is required for duration_in_traffic.
            # "now" makes Google return its best current estimate.
            "departure_time": "now",
            "traffic_model": "best_guess",
            "key": self.api_key,
        }
        url = f"{DISTANCE_MATRIX_URL}?{urllib.parse.urlencode(params)}"

        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            # Never raises. A dispatch in progress is not helped by an exception
            # from a third party; it is helped by an ETA it can act on.
            log.warning("distance matrix unavailable (%s) — falling back to estimates", exc)
            return [None] * len(destinations)

        if payload.get("status") != "OK":
            log.warning(
                "distance matrix returned %s: %s",
                payload.get("status"),
                payload.get("error_message", "-"),
            )
            return [None] * len(destinations)

        rows = payload.get("rows") or []
        elements = (rows[0].get("elements") if rows else None) or []
        out: list[tuple[float, float, bool] | None] = []
        for element in elements:
            if element.get("status") != "OK":
                out.append(None)
                continue
            distance = element.get("distance") or {}
            # duration_in_traffic is present when departure_time was supplied and
            # the region supports it; duration is the free-flow fallback.
            duration = element.get("duration_in_traffic") or element.get("duration") or {}
            metres = distance.get("value")
            seconds = duration.get("value")
            if metres is None or seconds is None:
                out.append(None)
                continue
            out.append((metres / 1000.0, seconds / 60.0, "duration_in_traffic" in element))

        while len(out) < len(destinations):
            out.append(None)
        return out


class EstimateProvider:
    """The geometric fallback, used when no key is configured or the provider is
    unreachable. It is the same maths the engine used before routing existed, and
    it is kept as a real provider rather than an error path so the platform
    behaves identically -- but honestly labelled -- with or without a key."""

    name = "estimate"

    def matrix(
        self,
        origin: tuple[float, float],
        destinations: Sequence[tuple[float, float]],
    ) -> list[Leg | None]:
        return [estimate_leg(origin[0], origin[1], lat, lng) for lat, lng in destinations]


# --------------------------------------------------------------------------- #
# Service
# --------------------------------------------------------------------------- #


def _build_provider() -> RoutingProvider:
    key = settings.google_maps_server_key
    if settings.routing_enabled and key:
        return GoogleDistanceMatrixProvider(key)
    return EstimateProvider()


class RoutingService:
    """The seam the matching engine talks to.

    Holds the provider, applies the geometric prefilter, fills gaps with
    estimates, and reports how much of a result was actually routed.
    """

    def __init__(self, provider: RoutingProvider | None = None) -> None:
        self._provider = provider or _build_provider()

    @property
    def enabled(self) -> bool:
        return self._provider.name != "estimate"

    @property
    def provider_name(self) -> str:
        return self._provider.name

    def resolve(
        self,
        origin: tuple[float, float],
        targets: Sequence[tuple[float, float]],
        *,
        max_road_distance_km: float | None = None,
    ) -> list[Leg]:
        """Road legs for every target, in order, never raising.

        Targets beyond `max_road_distance_km` by straight line are not routed --
        they cannot be within it by road, so the request would be wasted. They
        still get a leg, built from the geometric estimate, so callers get one
        leg per target and never have to special-case a hole in the list.
        """
        if not targets:
            return []

        legs: list[Leg | None] = [None] * len(targets)
        routable: list[int] = []

        for index, (lat, lng) in enumerate(targets):
            if max_road_distance_km is not None:
                straight = haversine_km(origin[0], origin[1], lat, lng)
                if straight > max_road_distance_km:
                    continue
            routable.append(index)

        if routable:
            resolved = self._provider.matrix(origin, [targets[i] for i in routable])
            for slot, index in enumerate(routable):
                if slot < len(resolved) and resolved[slot] is not None:
                    legs[index] = resolved[slot]

        for index, (lat, lng) in enumerate(targets):
            if legs[index] is None:
                legs[index] = estimate_leg(origin[0], origin[1], lat, lng)

        return legs  # type: ignore[return-value]

    def legs_for_rows(
        self,
        origin: tuple[float, float],
        rows: Sequence[tuple[int, float, float]],
        *,
        max_road_distance_km: float | None = None,
    ) -> dict[int, Leg]:
        """Convenience wrapper for `(id, lat, lng)` tuples -- the shape callers
        have when they are holding database rows."""
        legs = self.resolve(origin, [(lat, lng) for _, lat, lng in rows], max_road_distance_km=max_road_distance_km)
        return {row[0]: leg for row, leg in zip(rows, legs)}

    def stats(self) -> dict:
        underlying = self._provider
        payload = {"enabled": self.enabled, "provider": self.provider_name}
        if isinstance(underlying, GoogleDistanceMatrixProvider):
            payload.update(underlying.cache_stats())
        return payload


# A generous highway average. Deliberately fast: the prefilter must not drop a
# facility that *could* be reachable, because a dropped candidate that was
# actually the right answer is a worse failure than a wasted request.
MAX_PLAUSIBLE_KMPH = 70.0


def prefilter_km(catchment_minutes: float, *, ceiling_km: float | None = None) -> float:
    """How far away it is worth asking the router about a candidate.

    Derived from the clinical catchment rather than set to a constant, because
    the catchment is what decides eligibility. A P1 cardiac call has 75 minutes;
    at a generous highway average that is 88 km of road, and since a road is
    never shorter than a straight line, anything beyond 88 km straight-line
    cannot be inside the catchment by any route that exists. Asking about it
    would be a billed request that cannot change the answer.

    Scaling with the catchment matters at both ends. A flat 260 km -- roughly the
    height of Tamil Nadu -- drops almost nothing, so a statewide shortlist would
    route all 147 facilities, six billed requests per rebuild, on every console
    refresh. A flat 50 km would silently hide the distant trauma centre that is
    the only correct answer to a P3 transfer.
    """
    radius = max(15.0, catchment_minutes / 60.0 * MAX_PLAUSIBLE_KMPH)
    if ceiling_km is not None:
        radius = min(radius, ceiling_km)
    return radius


def summarise(legs: Iterable[Leg]) -> dict:
    """How much of a ranking was built on roads.

    The console shows this. A dispatcher looking at a shortlist is entitled to
    know whether the ETAs beside it came from the road network or from geometry
    with a winding factor applied, because the two disagree most in exactly the
    terrain where the decision is hardest.
    """
    legs = list(legs)
    routed = sum(1 for leg in legs if leg.provider != "estimate")
    traffic = sum(1 for leg in legs if leg.traffic_aware)
    return {
        "total": len(legs),
        "routed": routed,
        "estimated": len(legs) - routed,
        "traffic_aware": traffic,
        "road_derived": routed > 0,
        "fully_routed": routed == len(legs) and len(legs) > 0,
    }


# --------------------------------------------------------------------------- #
# Module-level API
# --------------------------------------------------------------------------- #
#
# The default service is a process-wide singleton, because its distance cache has
# to survive between requests: a per-request cache would re-bill for the same
# road on every console refresh, which is the entire cost this design avoids.
#
# It is kept private and reached through these functions rather than exported
# directly. `routing.routing` -- module and instance sharing a name -- is the
# kind of thing that reads fine in the file it is written in and confuses every
# caller afterwards.

_default: RoutingService | None = None


def service() -> RoutingService:
    """The process-wide service, built on first use.

    Lazily so importing this module never reads configuration or constructs a
    network client, which keeps it importable from tests that want to inject
    their own provider.
    """
    global _default
    if _default is None:
        _default = RoutingService()
    return _default


def resolve(
    origin: tuple[float, float],
    targets: Sequence[tuple[float, float]],
    *,
    max_road_distance_km: float | None = None,
) -> list[Leg]:
    """Road legs for every target, in order."""
    return service().resolve(origin, targets, max_road_distance_km=max_road_distance_km)


def legs_for_rows(
    origin: tuple[float, float],
    rows: Sequence[tuple[int, float, float]],
    *,
    max_road_distance_km: float | None = None,
) -> dict[int, Leg]:
    """Road legs keyed by id, for `(id, lat, lng)` rows."""
    return service().legs_for_rows(origin, rows, max_road_distance_km=max_road_distance_km)


def provider_name() -> str:
    return service().provider_name


def enabled() -> bool:
    return service().enabled


def stats() -> dict:
    return service().stats()


def reset() -> None:
    """Drop the singleton so the next call rebuilds from current settings.
    Used by tests, which swap providers and must not leak the swap."""
    global _default
    _default = None


def use(provider: RoutingProvider) -> None:
    """Swap the provider. For tests and for the console's own diagnostics -- a
    stubbed provider makes the routing path deterministically testable without a
    billed key or a network."""
    global _default
    _default = RoutingService(provider)
