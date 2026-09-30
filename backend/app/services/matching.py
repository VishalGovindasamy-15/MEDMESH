"""Matching & routing engine (§6.4).

Ranks candidate facilities for an incident. The important design decision is that
this is a *scoring* function with an audit trail, not a filter-and-sort. Every
candidate that was considered -- including the ones rejected -- comes back with a
machine-generated reason, and the whole shortlist is snapshotted onto the
incident at dispatch time. When a family asks in a review why the ambulance went
to Hospital A instead of the nearer Hospital B, that question has a stored,
specific answer.

Scoring shape:

    score = 100 * (
        0.34 * capability_fit      # does it have the thing this patient needs
      + 0.26 * proximity           # decayed ETA, not raw distance
      + 0.16 * capacity_headroom   # slack, not just presence of a bed
      + 0.12 * trust               # freshness + provenance + verification
      + 0.12 * load_balance        # push away from facilities already saturating
    )
      - hard penalties               # ED critical, zero effective capacity, ...

Capability is deliberately the heaviest term. Routing a burns patient to a
facility 4 minutes closer that has no burns unit is not a good outcome, and the
weights should not pretend otherwise.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime

from ..models import CapacityRecord, Doctor, EdCongestion, Hospital, Incident, IncidentCategory, SurgeEvent, Urgency
from .geo import Leg, estimate_leg
from .trust import FreshnessBand, freshness, humanise_age

# Which facility capabilities a given incident category actually depends on.
# First match wins; "satisfiers" are OR-ed, "required" are AND-ed.
CATEGORY_REQUIREMENTS: dict[IncidentCategory, dict[str, list[str]]] = {
    IncidentCategory.ROAD_ACCIDENT: {"satisfiers": ["trauma", "ortho", "general_surgery"], "flags": ["has_trauma_centre"]},
    IncidentCategory.TRAUMA_FALL: {"satisfiers": ["trauma", "ortho"], "flags": ["has_trauma_centre"]},
    IncidentCategory.CARDIAC: {"satisfiers": ["cardiology"], "flags": ["has_cath_lab"]},
    IncidentCategory.STROKE: {"satisfiers": ["neurology"], "flags": []},
    IncidentCategory.OBSTETRIC: {"satisfiers": ["obstetrics", "gynaecology"], "flags": []},
    IncidentCategory.PAEDIATRIC: {"satisfiers": ["paediatrics"], "flags": ["has_neonatal_icu"]},
    IncidentCategory.BURNS: {"satisfiers": ["burns", "plastic_surgery"], "flags": ["has_burn_unit"]},
    IncidentCategory.SNAKEBITE: {"satisfiers": ["general_medicine", "critical_care"], "flags": []},
    IncidentCategory.POISONING: {"satisfiers": ["general_medicine", "critical_care"], "flags": []},
    IncidentCategory.RESPIRATORY: {"satisfiers": ["pulmonology", "general_medicine"], "flags": []},
    IncidentCategory.DIALYSIS: {"satisfiers": ["nephrology"], "flags": ["has_dialysis"]},
    IncidentCategory.OTHER: {"satisfiers": [], "flags": []},
}

# Ambulance capability required by incident category, in descending order of
# preference. An ALS unit can run a cardiac call a BLS unit cannot, so this is a
# requirement list rather than a single value -- the first entry the fleet can
# satisfy is the one used, and the choice is reported back to the dispatcher.
#
# Keyed by (category, urgency) first, then by category alone, so a P1 cardiac
# call demands advanced life support while a P3 cardiac transfer does not.
AMBULANCE_REQUIREMENTS: dict[tuple[IncidentCategory, Urgency], list[str]] = {
    (IncidentCategory.CARDIAC, Urgency.P1): ["als", "bls"],
    (IncidentCategory.CARDIAC, Urgency.P2): ["als", "bls"],
    (IncidentCategory.STROKE, Urgency.P1): ["als", "bls"],
    (IncidentCategory.RESPIRATORY, Urgency.P1): ["als", "bls"],
    (IncidentCategory.POISONING, Urgency.P1): ["als", "bls"],
    (IncidentCategory.SNAKEBITE, Urgency.P1): ["als", "bls"],
    # A sick neonate needs a transport incubator; a paediatric call does not.
    (IncidentCategory.PAEDIATRIC, Urgency.P1): ["nicu", "als", "bls"],
}

AMBULANCE_REQUIREMENTS_BY_CATEGORY: dict[IncidentCategory, list[str]] = {
    IncidentCategory.CARDIAC: ["als", "bls"],
    IncidentCategory.STROKE: ["als", "bls"],
    IncidentCategory.OBSTETRIC: ["als", "bls"],
    IncidentCategory.PAEDIATRIC: ["als", "bls"],
    IncidentCategory.BURNS: ["als", "bls"],
    IncidentCategory.SNAKEBITE: ["als", "bls"],
    IncidentCategory.POISONING: ["als", "bls"],
    IncidentCategory.RESPIRATORY: ["als", "bls"],
    IncidentCategory.ROAD_ACCIDENT: ["als", "bls"],
    IncidentCategory.TRAUMA_FALL: ["als", "bls"],
    IncidentCategory.DIALYSIS: ["bls"],
}

AMBULANCE_CAPABILITY_LABELS = {
    "als": "Advanced life support",
    "bls": "Basic life support",
    "nicu": "Neonatal transport incubator",
    "mortuary": "Mortuary transport",
}

# Readable form of the fleet status enum. The dispatcher console and the
# validation messages both need it, and "ON_TRIP" leaking into a sentence a
# control-room operator reads is the kind of detail that makes software feel
# unfinished.
AMBULANCE_STATUS_LABELS = {
    "available": "Available",
    "assigned": "Assigned",
    "en_route": "En route to scene",
    "at_scene": "At scene",
    "transporting": "Transporting patient",
    "dispatched": "Dispatched",
    "on_trip": "On trip",
    "returning": "Returning",
    "out_of_service": "Out of service",
}


def required_ambulance_capabilities(incident: Incident) -> list[str]:
    """Capability preference order for this incident, best first.

    Most specific match wins: a P1 paediatric call wants the neonatal unit,
    a P2 cardiac transfer does not need one, and anything unmatched falls back
    to basic life support rather than to no requirement.
    """
    by_pair = AMBULANCE_REQUIREMENTS.get((incident.category, incident.urgency))
    if by_pair:
        return by_pair
    by_cat = AMBULANCE_REQUIREMENTS_BY_CATEGORY.get(incident.category)
    if by_cat:
        return by_cat
    return ["bls"]


ED_PENALTY = {
    EdCongestion.LOW: 0.0,
    EdCongestion.MODERATE: 3.0,
    EdCongestion.HIGH: 11.0,
    EdCongestion.CRITICAL: 24.0,
}


@dataclass(slots=True)
class Candidate:
    hospital_id: int
    name: str
    short_name: str
    type: str
    district_id: int
    address: str
    lat: float
    lng: float
    phone: str
    eligible: bool
    score: float
    leg: Leg
    in_range: bool = True
    break_down: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    capacity: dict | None = None
    freshness: dict | None = None
    trust: dict | None = None
    directs: dict | None = None
    specialist_score: float = 0.0
    specialist_note: str | None = None
    on_duty_specialists: list[str] = field(default_factory=list)

    def to_wire(self) -> dict:
        return {
            "hospital_id": self.hospital_id,
            "name": self.name,
            "short_name": self.short_name,
            "type": self.type,
            "district_id": self.district_id,
            "address": self.address,
            "lat": self.lat,
            "lng": self.lng,
            "phone": self.phone,
            "eligible": self.eligible,
            "in_range": self.in_range,
            "score": round(self.score, 1),
            "breakdown": {k: round(v, 1) for k, v in self.break_down.items()},
            "reasons": self.reasons,
            "warnings": self.warnings,
            "blockers": self.blockers,
            "distance_km": self.leg.road_km,
            "eta_minutes": self.leg.eta_minutes,
            # Provenance travels with the number. A dispatcher comparing two
            # facilities needs to know whether both ETAs came off the road
            # network, or one did and the other is geometry.
            "distance_provider": self.leg.provider,
            "distance_is_road": self.leg.provider != "estimate",
            "traffic_aware": self.leg.traffic_aware,
            "straight_km": self.leg.straight_km,
            "distance_label": self.leg.label,
            "capacity": self.capacity,
            "freshness": self.freshness,
            "trust": self.trust,
            "directs": self.directs,
            "specialist_score": round(self.specialist_score, 2),
            "specialist_note": self.specialist_note,
            "on_duty_specialists": self.on_duty_specialists,
        }


def _specialties(hospital: Hospital) -> set[str]:
    return {s.strip() for s in (hospital.specialties or "").split(",") if s.strip()}


def _decay(x: float, half_life: float) -> float:
    """Exponential decay in [0, 1].

    Half-life is expressed in ETA minutes, not kilometres, because minutes are
    what the decision is actually made in. Set at 32 minutes: a facility 10
    minutes away scores ~0.80, one 40 minutes away ~0.42, one 90 minutes away
    ~0.14. That is a real gradient across the range a dispatcher cares about,
    and it does not flatten to zero -- an earlier 11-minute half-life made
    everything beyond ~40 minutes score identically at ~0, which let a hospital
    four hours away outrank one six kilometres away on capability alone.
    """
    if x < 0:
        return 1.0
    return 0.5 ** (x / half_life)


# Practical catchment by priority. Not a hard filter on its own -- see the
# `in_range` handling in `rank_candidates`, which only excludes distant
# facilities when something closer can actually take the patient.
CATCHMENT_MINUTES = {"P1": 75.0, "P2": 120.0, "P3": 180.0}


def _specialist_signal(
    *,
    satisfiers: list[str],
    on_duty: list[Doctor],
    roster: list[Doctor],
) -> tuple[float, str | None]:
    """Step 2 and 3 of the matching chain: is the right person actually at work?

    Returns a score in [0, 1] and a sentence for the operator. The tiers are
    deliberately coarse -- "a cardiologist is on duty and takes emergencies",
    "the department exists but nobody is on the roster tonight", "the hospital
    has the department and there is a cardiologist but they are off shift",
    and "no such doctor on this roster at all".
    """
    if not satisfiers:
        return 0.6, None

    wanted = set(satisfiers)

    def matches(d: Doctor) -> bool:
        return d.specialty in wanted or d.department.lower().replace(" ", "_") in wanted

    on_duty_matches = [d for d in on_duty if matches(d)]
    emergency_ready = [d for d in on_duty_matches if d.accepts_emergency]

    if emergency_ready:
        d = sorted(emergency_ready, key=lambda x: x.full_name)[0]
        return 1.0, f"{d.full_name} on duty ({d.specialty.replace('_', ' ')})"

    if on_duty_matches:
        d = on_duty_matches[0]
        return 0.55, f"{d.full_name} on duty but not taking emergency cases"

    roster_matches = [d for d in roster if matches(d)]
    if roster_matches:
        d = sorted(roster_matches, key=lambda x: x.full_name)[0]
        return 0.3, (
            f"{d.specialty.replace('_', ' ')} on roster but nobody on duty "
            f"({d.shift} shift pattern)"
        )

    return 0.12, f"No {'/'.join(s.replace('_', ' ') for s in satisfiers[:2])} doctor on this roster"


def score_candidate(
    *,
    hospital: Hospital,
    capacity_row: CapacityRecord | None,
    cap_view,
    incident: Incident,
    origin_lat: float,
    origin_lng: float,
    trust: dict | None,
    surge_active: bool = False,
    facility_load: float = 0.0,
    relaxed_freshness: bool = False,
    on_duty_doctors: list[Doctor] | None = None,
    roster_doctors: list[Doctor] | None = None,
    leg: Leg | None = None,
) -> Candidate:
    # The leg arrives resolved. Ranking is scored on *road* ETA -- see
    # services/routing.py for why that ordering matters -- and the geometric
    # estimate is only the fallback when no road leg could be obtained. The
    # parameter is optional so the function stays callable in isolation, which
    # is what the unit tests and the scoring notebook do.
    if leg is None:
        leg = estimate_leg(origin_lat, origin_lng, hospital.lat, hospital.lng)
    specs = _specialties(hospital)
    req = CATEGORY_REQUIREMENTS.get(incident.category, {"satisfiers": [], "flags": []})

    band: FreshnessBand = freshness(
        capacity_row.recorded_at if capacity_row else None, relaxed=relaxed_freshness
    )

    reasons: list[str] = []
    warnings: list[str] = []
    blockers: list[str] = []

    # ---------------------------------------------------------------- capability
    #
    # The chain, in the order a clinician would actually ask it:
    #
    #   1. does this hospital list the service the incident needs?
    #   2. is a doctor in that specialty on duty *right now*?
    #   3. does that doctor accept emergency cases?
    #   4. is there a bed / ICU / ventilator free?        (below)
    #   5. how much do we trust the numbers?              (below)
    #   6. how far away is it?                            (below)
    #
    # Steps 1-3 are scored separately and a facility that stalls at step 2 is
    # never allowed to outrank one that clears it, no matter how close it is.
    # Capability is a department existing; specialist is a person being at work.
    # Those are different facts and they used to be collapsed into one.
    satisfiers = req.get("satisfiers", [])
    cap_score = 0.0
    if not satisfiers:
        cap_score = 0.85
    elif specs & set(satisfiers):
        cap_score = 1.0
        hit = sorted(specs & set(satisfiers))[0].replace("_", " ")
        reasons.append(f"On-site {hit}")
    else:
        cap_score = 0.18
        warnings.append(f"No {'/'.join(s.replace('_', ' ') for s in satisfiers[:2])} service listed")

    specialist_score, specialist_note = _specialist_signal(
        satisfiers=satisfiers,
        on_duty=on_duty_doctors,
        roster=roster_doctors,
    )
    if specialist_note:
        (reasons if specialist_score >= 0.7 else warnings).append(specialist_note)

    flags = req.get("flags", [])
    for flag in flags:
        if getattr(hospital, flag, False):
            cap_score = min(1.0, cap_score + 0.06)
            reasons.append(flag.replace("has_", "").replace("_", " ").title())

    # ---------------------------------------------------------------- resources
    eff_beds = cap_view.beds_effective if cap_view else 0
    eff_icu = cap_view.icu_effective if cap_view else 0
    eff_vent = cap_view.vent_effective if cap_view else 0

    if incident.requires_icu:
        if eff_icu <= 0:
            blockers.append("ICU required, none free")
        else:
            reasons.append(f"{eff_icu} ICU free")
    if incident.requires_ventilator:
        if eff_vent <= 0:
            blockers.append("Ventilator required, none free")
        else:
            reasons.append(f"{eff_vent} ventilators free")
    if not incident.requires_icu and not incident.requires_ventilator:
        if eff_beds <= 0:
            blockers.append("No general beds reported free")
        else:
            reasons.append(f"{eff_beds} beds free")

    if incident.requires_blood:
        if not hospital.has_blood_bank:
            blockers.append("Blood required, no blood bank on site")
        elif cap_view and cap_view.blood_units < 2:
            warnings.append(f"Blood bank low ({cap_view.blood_units} units)")
        else:
            reasons.append("Blood bank stocked")

    if incident.category is IncidentCategory.SNAKEBITE:
        vials = cap_view.antivenom_vials if cap_view else 0
        if vials <= 0:
            warnings.append("No antivenom vials reported")
        else:
            reasons.append(f"{vials} antivenom vials")

    # --------------------------------------------------------------- headroom
    total = max(hospital.total_beds, 1)
    headroom = min(1.0, eff_beds / max(total * 0.18, 3))

    # ------------------------------------------------------------------ trust
    trust_score = (trust or {}).get("score", 55) / 100.0
    if band.state in ("stale", "cold"):
        warnings.append(f"Last report {humanise_age(band.age_seconds)} ago")
    if (trust or {}).get("band") == "low":
        warnings.append("Low trust score — verify before committing")

    # ------------------------------------------------------------------ load
    load_penalty = max(0.0, facility_load - 0.6)

    ed_pen = ED_PENALTY.get(capacity_row.ed_congestion, 6.0) if capacity_row else 8.0
    if capacity_row and capacity_row.ed_congestion in (EdCongestion.HIGH, EdCongestion.CRITICAL):
        warnings.append(f"ED congestion {capacity_row.ed_congestion.value}")
    if capacity_row and capacity_row.ed_waiting >= 12:
        warnings.append(f"{capacity_row.ed_waiting} waiting in ED")

    # Decay on *road* ETA. Half-life 32 min: a facility twice as far away in
    # time contributes roughly half as much proximity, and the curve is flat
    # enough near zero that two facilities ten minutes apart are treated as
    # genuinely close rather than as a photo finish. Road time is the right
    # input here because it is the only one that reflects the trip.
    proximity = _decay(leg.eta_minutes, half_life=32.0)

    # Weights re-cut when the specialist term was introduced. Capability gave
    # back the 0.06 the specialist term takes, because "the hospital lists a
    # cardiology department" and "a cardiologist is on duty" are two halves of
    # one question and 0.40 combined is the weight the pair deserves.
    score = 100.0 * (
        0.28 * cap_score
        + 0.12 * specialist_score
        + 0.24 * proximity
        + 0.14 * headroom
        + 0.11 * trust_score
        + 0.11 * (1.0 - min(1.0, load_penalty))
    )
    score -= ed_pen
    if surge_active and hospital.has_trauma_centre:
        score += 5.0

    eligible = not blockers

    breakdown = {
        "capability": 28 * cap_score,
        "specialist_on_duty": 12 * specialist_score,
        "proximity": 24 * proximity,
        "headroom": 14 * headroom,
        "trust": 11 * trust_score,
        "load_balance": 11 * (1.0 - min(1.0, load_penalty)),
        "ed_penalty": -ed_pen,
    }

    catchment = CATCHMENT_MINUTES.get(incident.urgency.value, 120.0)
    in_range = leg.eta_minutes <= catchment
    if not in_range:
        warnings.append(
            f"{leg.eta_minutes} min away — outside the {incident.urgency.value} catchment"
        )

    return Candidate(
        hospital_id=hospital.id,
        name=hospital.name,
        short_name=hospital.short_name,
        type=hospital.type.value,
        district_id=hospital.district_id,
        address=hospital.address,
        lat=hospital.lat,
        lng=hospital.lng,
        phone=hospital.emergency_phone or hospital.contact_phone,
        eligible=eligible,
        score=score,
        leg=leg,
        in_range=in_range,
        break_down=breakdown,
        reasons=reasons,
        warnings=warnings,
        blockers=blockers,
        capacity=cap_view.to_wire() if cap_view else None,
        freshness={"state": band.state, "label": band.label, "age_seconds": band.age_seconds},
        trust=trust,
        specialist_score=specialist_score,
        specialist_note=specialist_note,
        on_duty_specialists=[
            f"{d.full_name} · {d.specialty.replace('_', ' ')}"
            + ("" if d.accepts_emergency else " (not emergency)")
            for d in on_duty_doctors
            if d.specialty in set(satisfiers) or d.department.lower().replace(" ", "_") in set(satisfiers)
        ][:4],
    )


def rank_candidates(
    hospitals: list[Hospital],
    *,
    incident: Incident,
    latest: dict[int, CapacityRecord],
    views: dict[int, object],
    trust_scores: dict[int, dict],
    origin_lat: float,
    origin_lng: float,
    surge: SurgeEvent | None = None,
    doctors_by_hospital: dict[int, list[Doctor]] | None = None,
    legs: dict[int, Leg] | None = None,
) -> list[Candidate]:
    """Rank facilities for an incident.

    `doctors_by_hospital` is the facility's whole doctor roster. It is split
    here into the on-duty subset and the full roster so the specialist step of
    the chain can tell "nobody is on shift tonight" apart from "this hospital
    does not employ one at all" -- which are very different things to tell a
    dispatcher at 3am.
    """
    doctors_by_hospital = doctors_by_hospital or {}
    legs = legs or {}
    out: list[Candidate] = []
    for h in hospitals:
        row = latest.get(h.id)
        roster = doctors_by_hospital.get(h.id, [])
        on_duty = [d for d in roster if d.on_duty]
        # Facility load = occupancy ratio; a hospital at 95% beds full is a bad
        # destination even if the reported number of free beds is technically > 0.
        load = 0.0
        if row:
            load = 1.0 - (row.beds_available / max(h.total_beds, 1))
        out.append(
            score_candidate(
                hospital=h,
                capacity_row=row,
                cap_view=views.get(h.id),
                incident=incident,
                origin_lat=origin_lat,
                origin_lng=origin_lng,
                trust=trust_scores.get(h.id),
                surge_active=bool(surge),
                facility_load=max(0.0, min(1.0, load)),
                relaxed_freshness=bool(surge),
                on_duty_doctors=on_duty,
                roster_doctors=roster,
                leg=legs.get(h.id),
            )
        )
    # Reachability rule.
    #
    # A facility four hours away that happens to have a trauma centre must not
    # outrank one twelve minutes away, but it also must not be hidden when it is
    # the only option left. So: if any eligible candidate is inside the
    # priority's catchment, everything outside it is excluded with an explicit
    # reason. If nothing is in range, the distant candidates stay eligible and
    # carry a warning, and the shortlist is presented as a genuine last resort
    # rather than as a normal choice.
    reachable = [c for c in out if c.eligible and c.in_range]
    if reachable:
        for c in out:
            if c.eligible and not c.in_range:
                c.eligible = False
                c.blockers.append(
                    f"Outside {incident.urgency.value} catchment — {c.leg.eta_minutes} min away, "
                    f"and a facility inside the catchment can accept this patient"
                )

    # Specialist tier.
    #
    # Same shape as the catchment rule above, for the same reason. If any
    # eligible facility has the right specialist on duty and taking emergency
    # cases, then a facility whose department is empty is not a real alternative
    # -- the crew would arrive to find nobody who can treat the patient. Such
    # facilities stay on the list, clearly demoted, because an empty cardiology
    # department is still better than a four-hour drive when nothing else is
    # open. If no facility clears the bar, the tier collapses and every
    # candidate carries its own warning.
    specialist_available = [
        c for c in out if c.eligible and c.in_range and c.specialist_score >= 0.7
    ]
    if specialist_available:
        for c in out:
            if c.eligible and c.specialist_score < 0.7:
                c.warnings.append(
                    "Ranks below facilities with a specialist on duty — "
                    f"{c.specialist_note or 'no matching specialist on duty'}"
                )

    out.sort(
        key=lambda c: (
            c.eligible,
            c.in_range,
            c.specialist_score >= 0.7,
            c.score,
        ),
        reverse=True,
    )
    return out


def snapshot(candidates: list[Candidate], *, top: int = 12) -> str:
    return json.dumps(
        {
            "generated_for": "dispatch",
            "top": [c.to_wire() for c in candidates[:top]],
            "excluded": [c.to_wire() for c in candidates if not c.eligible][:top],
        },
        separators=(",", ":"),
    )


def traffic_note(leg: Leg, now: datetime | None = None) -> str:
    """A one-line operational note shown under the ETA. Real version reads the
    Distance Matrix `duration_in_traffic`; this approximates the same shape."""
    hour = (now or datetime.now()).hour
    if 8 <= hour <= 11 or 17 <= hour <= 20:
        return f"Heavy traffic on corridor — {leg.label} (live estimate)"
    if 22 <= hour or hour <= 5:
        return f"Light traffic — {leg.label}"
    return f"Moderate traffic — {leg.label}"

# --------------------------------------------------------------------------- #
# Ambulance escalation ladder (§25)
# --------------------------------------------------------------------------- #

# How far a unit may be drawn from, in order. The platform previously searched
# the entire state fleet for any available unit, which is not wrong for an
# emergency service but is not a policy either: it has no concept of asking
# locally first, and it hides the moment when an incident is being covered by a
# unit that normally belongs to somebody else's district.
#
# Three tiers, in the order a control room actually escalates:
#
#   local       -- the incident's own district. The normal answer.
#   neighbour   -- districts that share a border with it. Mutual aid between
#                  neighbours is routine and usually faster than waiting for a
#                  local unit to clear a previous job.
#   statewide   -- everything else. Escalation, and it is labelled as such so
#                  the dispatcher can see they are reaching.
ESCALATION_TIERS = ("local", "neighbouring", "statewide")

ESCALATION_LABELS = {
    "local": "Local — incident district",
    "neighbouring": "Mutual aid — neighbouring district",
    "statewide": "Statewide escalation",
}

# Districts that share a border, by code. Hand-built because Tamil Nadu's
# district boundaries are a known, stable, finite adjacency -- deriving them from
# a geospatial library at runtime would add a dependency and a projection to get
# the same answer. A neighbour is a district whose headquarters lies within
# roughly 95 km, which is close to how the state's district pairs actually fall:
# it captures Coimbatore-Erode and Madurai-Dindigul, and excludes
# Coimbatore-Chennai at 420 km.
NEIGHBOUR_RADIUS_KM = 95.0


def _centroids(hospitals_by_district_centroid: dict[int, tuple[float, float]], home: int):
    from .geo import haversine_km

    home_point = hospitals_by_district_centroid.get(home)
    if home_point is None:
        return set()
    out = set()
    for district_id, point in hospitals_by_district_centroid.items():
        if district_id == home:
            continue
        if haversine_km(home_point[0], home_point[1], point[0], point[1]) <= NEIGHBOUR_RADIUS_KM:
            out.add(district_id)
    return out


def escalation_tiers(db, *, home_district_id: int | None) -> dict:
    """The ladder, as district id sets, for a given home district.

    Returned with both ids and names because it is rendered: the console shows
    "Coimbatore + 3 neighbouring districts" as the scope of a search, and a
    dispatcher who cannot see that a search crossed a border cannot judge whether
    the answer is reasonable.
    """
    from sqlalchemy import select as _select

    from ..models import District

    districts = list(db.execute(_select(District)).scalars().all())
    centroids = {d.id: (d.lat, d.lng) for d in districts}
    names = {d.id: d.name for d in districts}

    if home_district_id is None:
        everything = set(centroids)
        return {
            "local": {"district_ids": sorted(everything), "names": sorted(names.values()), "label": "Statewide control"},
            "neighbouring": {"district_ids": [], "names": [], "label": "Not applicable without a home district"},
            "statewide": {"district_ids": sorted(everything), "names": sorted(names.values()), "label": "All districts"},
        }

    neighbours = _centroids(centroids, home_district_id)
    local = {home_district_id}
    return {
        "local": {
            "district_ids": sorted(local),
            "names": [names.get(home_district_id, "")],
            "label": names.get(home_district_id, ""),
        },
        "neighbouring": {
            "district_ids": sorted(neighbours),
            "names": sorted(names.get(d, "") for d in neighbours),
            "label": f"{len(neighbours)} neighbouring district(s)",
        },
        "statewide": {
            "district_ids": sorted(set(centroids) - local - neighbours),
            "names": sorted(names.get(d, "") for d in (set(centroids) - local - neighbours)),
            "label": "Rest of Tamil Nadu",
        },
    }


def escalation_of(base_district_id: int | None, tiers: dict | None) -> str:
    """Which tier a vehicle belongs to, for labelling a candidate."""
    if tiers is None or base_district_id is None:
        return "local"
    if base_district_id in tiers["local"]["district_ids"]:
        return "local"
    if base_district_id in tiers["neighbouring"]["district_ids"]:
        return "neighbouring"
    return "statewide"
