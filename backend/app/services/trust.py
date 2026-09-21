"""Trust engine.

Two responsibilities, both taken from §6.3 of the architecture report:

1. `freshness()` -- pure function mapping an age to a state band. Kept pure and
   side-effect free so the analytics warehouse can re-derive it for any historic
   record without replaying application code.
2. `evaluate_ingest()` -- anomaly screen run on every incoming update *before*
   it is allowed to become the live projection. Quarantined updates are stored
   (they are evidence) but excluded from the live view.

The composite `trust_score` is what the dispatcher console shows next to a
facility name. It is intentionally explainable -- each factor contributes a
signed, displayable delta -- because "why is this hospital at 61?" is a question
an ops lead will ask, and "the model said so" is not an acceptable answer for
emergency infrastructure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from ..config import settings
from ..models import CapacityRecord, Hospital, IntegrationMode, VerificationStatus, utcnow


@dataclass(slots=True)
class FreshnessBand:
    state: str
    label: str
    age_seconds: int

    @property
    def is_actionable(self) -> bool:
        return self.state in ("live", "warm")


def freshness(recorded_at: datetime | None, *, now: datetime | None = None, relaxed: bool = False) -> FreshnessBand:
    """`relaxed` is used while a surge event is active -- during a mass-casualty
    response an update from 20 minutes ago is still operationally useful."""
    if recorded_at is None:
        return FreshnessBand("unknown", "never reported", 10**9)

    now = now or utcnow()
    age = int((now - recorded_at).total_seconds())
    live_m = settings.freshness_live_minutes * (3 if relaxed else 1)
    warm_m = settings.freshness_warm_minutes * (3 if relaxed else 1)
    stale_m = settings.freshness_stale_minutes * (2 if relaxed else 1)

    if age <= live_m * 60:
        return FreshnessBand("live", "live", age)
    if age <= warm_m * 60:
        return FreshnessBand("warm", "recent", age)
    if age <= stale_m * 60:
        return FreshnessBand("stale", "stale", age)
    return FreshnessBand("cold", "no recent data", age)


@dataclass(slots=True)
class TrustVerdict:
    score: int
    band: str  # high | medium | low
    factors: list[dict[str, str]] = field(default_factory=list)
    quarantined: bool = False
    flags: list[str] = field(default_factory=list)

    def to_wire(self) -> dict:
        return {
            "score": self.score,
            "band": self.band,
            "factors": self.factors,
            "quarantined": self.quarantined,
            "flags": self.flags,
        }


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def evaluate_ingest(
    incoming: dict[str, int | str],
    previous: CapacityRecord | None,
    hospital: Hospital,
) -> TrustVerdict:
    """Screen one update. Returns a verdict carrying both the quarantine decision
    and the per-factor explanation shown in the hospital portal."""
    flags: list[str] = []
    score = 100.0
    factors: list[dict[str, str]] = []

    def add(delta: float, label: str, detail: str) -> None:
        nonlocal score
        score += delta
        factors.append({"label": label, "detail": detail, "delta": f"{delta:+.0f}"})

    # --- Hard integrity checks: these quarantine outright ------------------
    impossible = []
    for key, total in (
        ("beds_available", hospital.total_beds),
        ("icu_available", hospital.total_icu),
        ("ventilators_available", hospital.total_ventilators),
    ):
        val = int(incoming.get(key, 0))
        if val < 0:
            impossible.append(f"{key} negative ({val})")
        elif val > total:
            impossible.append(f"{key} {val} exceeds declared capacity {total}")
    if impossible:
        return TrustVerdict(
            score=0,
            band="low",
            factors=[
                {
                    "label": "Rejected at ingest",
                    "detail": "; ".join(impossible),
                    "delta": "-100",
                }
            ],
            quarantined=True,
            flags=impossible,
        )

    # --- Rate-of-change screen --------------------------------------------
    if previous is not None:
        for key, flag in (
            ("beds_available", "beds"),
            ("icu_available", "icu"),
            ("ventilators_available", "ventilators"),
        ):
            old = int(getattr(previous, key))
            new = int(incoming.get(key, 0))
            delta = abs(new - old)
            if delta == 0:
                continue
            pct = delta / max(old, 1)
            if delta >= settings.anomaly_abs_delta and pct >= settings.anomaly_pct_delta:
                flags.append(f"{flag}: {old}→{new} in one update")
                add(-24, "Anomalous jump", f"{flag} moved {old}→{new} in a single report")
            elif delta >= settings.anomaly_abs_delta:
                add(-8, "Large step", f"{flag} moved by {delta} units")

    # --- Provenance --------------------------------------------------------
    if hospital.integration is IntegrationMode.API:
        add(4, "System-verified", f"Pushed by {hospital.source_system or 'hospital system'}")
    else:
        add(-6, "Manual entry", "Keyed by facility staff, not system-verified")

    if hospital.verification is VerificationStatus.VERIFIED:
        add(6, "Verified facility", "Onboarding verification complete")
    elif hospital.verification is VerificationStatus.UNVERIFIED:
        add(-12, "Not yet verified", "Awaiting onboarding review")

    if flags:
        add(-10, "Under review", "Flagged updates are withheld from the live feed")

    score = _clamp(score)
    band = "high" if score >= 80 else "medium" if score >= 55 else "low"
    return TrustVerdict(score=int(round(score)), band=band, factors=factors, quarantined=bool(flags), flags=flags)


def score_facility(
    hospital: Hospital,
    *,
    last_updated: datetime | None,
    open_feedback: int = 0,
    upheld_feedback: int = 0,
    quarantined_24h: int = 0,
    relaxed: bool = False,
) -> TrustVerdict:
    """Steady-state trust score for the directory ranking.

    Anchored at 52 so the scale actually discriminates: a verification-complete
    facility pushing live data through an HL7-FHIR connector lands around 90, and
    an unverified manual facility that has not reported in a day lands near 20.
    A model that returns 100 for almost everything tells a dispatcher nothing.
    """
    score = 52.0
    factors: list[dict[str, str]] = []

    def add(delta: float, label: str, detail: str) -> None:
        nonlocal score
        score += delta
        factors.append({"label": label, "detail": detail, "delta": f"{delta:+.0f}"})

    band = freshness(last_updated, relaxed=relaxed)
    add(
        {"live": 16, "warm": 6, "stale": -14, "cold": -26, "unknown": -30}[band.state],
        "Data freshness",
        "Reported moments ago" if band.state == "live" else f"Last report {humanise_age(band.age_seconds)} ago",
    )

    if hospital.integration is IntegrationMode.API:
        add(10, "Integration", f"Live feed via {hospital.source_system or 'API'}")
    else:
        add(-4, "Integration", "Manual dashboard — depends on staff updating")

    add(
        {"verified": 12, "pending": 0, "unverified": -14, "suspended": -40}[hospital.verification.value],
        "Verification",
        {"verified": "Verified by MedMesh onboarding review", "pending": "Under review",
         "unverified": "Not yet reviewed", "suspended": "Suspended by platform admin"}[hospital.verification.value],
    )

    if hospital.has_trauma_centre and hospital.has_blood_bank:
        add(4, "Capability", "Trauma centre with on-site blood bank")

    if upheld_feedback:
        add(-6 * min(upheld_feedback, 3), "Reported mismatch", f"{upheld_feedback} upheld accuracy report(s)")
    if open_feedback:
        add(-2 * min(open_feedback, 3), "Open reports", f"{open_feedback} citizen report(s) awaiting review")
    if quarantined_24h:
        add(-3 * min(quarantined_24h, 4), "Flagged updates", f"{quarantined_24h} anomalous update(s) in 24h")

    score = _clamp(score)
    return TrustVerdict(
        score=int(round(score)),
        band="high" if score >= 80 else "medium" if score >= 55 else "low",
        factors=factors,
    )


def humanise_age(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60} min"
    if seconds < 86400:
        return f"{seconds // 3600} h"
    return f"{seconds // 86400} d"


def compute_quarantine_24h(records: list[CapacityRecord]) -> int:
    cutoff = utcnow()
    n = 0
    for r in records:
        if (cutoff - r.recorded_at).total_seconds() > 86400:
            break
        if r.quarantined:
            n += 1
    return n
