"""Geometric distance and ETA -- the fallback, not the source of truth.

`estimate_leg()` is straight-line distance inflated by a winding factor, divided
by an assumed speed. It is fast, free, offline, and *wrong in a specific and
predictable way*: it cannot know about a river, a hill, or a national highway
that runs the long way round but is twice as quick.

It therefore no longer feeds the matching engine directly. Ranking uses road legs
resolved by `services/routing.py`, which answers the question the score actually
asks -- how long an ambulance takes to arrive -- and this module is what that
service falls back to when there is no routing key or the provider is
unreachable. Legs carry a `provider` so the difference is never invisible in the
UI: an ETA that came from geometry says so.

Direction-bearing maths and the deterministic corridor generator live here too;
neither is a routing service, and `route_polyline()` is named to make that plain.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..config import settings

EARTH_R_KM = 6371.0088

# The state rectangle, inclusive, with a margin wide enough for the coastal
# belt. Used to reject incident coordinates that cannot be in Tamil Nadu -- a
# transposed latitude, a stray decimal place, a stale default. The frontend
# enforces the same box (see `mobile/src/components/LocationPicker.tsx`) so the
# operator is corrected while they are still on the call rather than with a 422.
TN_BOUNDS = {
    "lat_min": 7.5,
    "lat_max": 14.5,
    "lng_min": 75.5,
    "lng_max": 81.0,
}


def in_tamil_nadu(lat: float, lng: float) -> bool:
    return (
        TN_BOUNDS["lat_min"] <= lat <= TN_BOUNDS["lat_max"]
        and TN_BOUNDS["lng_min"] <= lng <= TN_BOUNDS["lng_max"]
    )


@dataclass(slots=True)
class Leg:
    """A journey from one point to another.

    `provider` and `traffic_aware` are provenance, and they are load-bearing
    rather than decorative: every surface that shows an ETA uses them to decide
    whether to present the number as a road journey or as an estimate. A leg
    that silently mixed the two would be worse than either.
    """

    straight_km: float
    road_km: float
    eta_minutes: int
    bearing_deg: float
    label: str  # "4.2 km · 9 min"
    provider: str = "estimate"  # "google-distance-matrix" when road-derived
    traffic_aware: bool = False  # duration came from live traffic, not free-flow


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_KM * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def estimate_leg(lat1: float, lng1: float, lat2: float, lng2: float) -> Leg:
    """Road distance is straight-line inflated by a winding factor; ETA blends an
    urban crawl speed for the first 6 km with a higher inter-city speed beyond
    it. Tuned against observed Coimbatore 108 response times."""
    straight = haversine_km(lat1, lng1, lat2, lng2)
    road = straight * settings.road_winding_factor

    urban_leg = min(road, 6.0) / settings.urban_speed_kmph
    rural_leg = max(0.0, road - 6.0) / settings.highway_speed_kmph
    minutes = (urban_leg + rural_leg) * 60.0

    # 90 s of unavoidable scene/loading time for anything beyond a walk.
    if road > 1.0:
        minutes += 1.5
    eta = max(1, int(round(minutes)))
    return Leg(
        straight_km=round(straight, 2),
        road_km=round(road, 1),
        eta_minutes=eta,
        bearing_deg=round(bearing_deg(lat1, lng1, lat2, lng2), 1),
        label=f"{road:.1f} km · {eta} min",
        provider="estimate",
        traffic_aware=False,
    )


def compass_point(deg: float) -> str:
    points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return points[int((deg % 360) / 22.5 + 0.5) % 16]


def route_polyline(
    lat1: float,
    lng1: float,
    lat2: float,
    lng2: float,
    *,
    seed: int = 0,
    points: int = 26,
) -> list[tuple[float, float]]:
    """Deterministic pseudo-road geometry for the driver app's route rendering.

    This is *not* a routing service. It produces a stable, plausible corridor
    between two points so the mobile client can demonstrate turn-trace rendering
    offline. Replaced by the encoded Google Directions polyline in production --
    the client only needs a list of lat/lng pairs, so nothing downstream changes.
    """
    out: list[tuple[float, float]] = []
    # Cheap deterministic PRNG -- avoids importing random and gives identical
    # geometry for identical inputs, which matters for snapshot tests.
    state = (seed * 2654435761) % 4294967296

    def rnd() -> float:
        nonlocal state
        state = (1103515245 * state + 12345) % 2147483648
        return state / 2147483648.0

    # A gentle sinusoidal offset makes the corridor read as a road rather than
    # a ruler line, with an amplitude scaled to the trip length.
    span = haversine_km(lat1, lng1, lat2, lng2)
    amp = min(0.0016, 0.02 / max(span, 0.4))
    phase = rnd() * math.tau

    for i in range(points):
        t = i / (points - 1)
        base_lat = lat1 + (lat2 - lat1) * t
        base_lng = lng1 + (lng2 - lng1) * t
        wobble = math.sin(phase + t * math.pi * 2.4) * amp * math.sin(t * math.pi)
        # Perpendicular offset
        dlat, dlng = lat2 - lat1, lng2 - lng1
        norm = math.hypot(dlat, dlng) or 1.0
        out.append((round(base_lat + wobble * (-dlng / norm), 5), round(base_lng + wobble * (dlat / norm), 5)))
    return out


def bbox(lat: float, lng: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km / 111.0
    dlng = radius_km / (111.0 * max(math.cos(math.radians(lat)), 0.15))
    return lat - dlat, lat + dlat, lng - dlng, lng + dlng
