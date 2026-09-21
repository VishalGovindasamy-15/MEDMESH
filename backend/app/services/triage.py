"""Turn a scene assessment into what the dispatch actually needs.

The incident intake collects structured observations (see `PatientState`,
`Mechanism`, `Bleeding`, `Hazard`, `ObservationFlag` in models.py). This module
is the only place that interprets them, so the mapping from "what the caller
said" to "what the response requires" lives in one readable table instead of
being scattered across the console, the matching engine and the prep alert.

Two rules govern everything here:

1.  **Derivation never overrides an explicit instruction.** An operator who
    states the patient needs a ventilator gets a ventilator requirement, even if
    the observations suggest otherwise — they may know something the form does
    not capture.
2.  **Derivation only ever raises requirements, never invents capability.**
    Nothing here selects a hospital; it states the requirement and the matching
    engine satisfies it or reports that it cannot.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import Bleeding, Hazard, IncidentCategory, Mechanism, ObservationFlag, PatientState


@dataclass(slots=True)
class DerivedNeeds:
    requires_icu: bool = False
    requires_ventilator: bool = False
    requires_blood: bool = False
    specialty: str | None = None
    # Rationale strings surface in the console so the operator can see *why* the
    # engine is demanding something, and disagree with it if they want to.
    rationale: list[str] = field(default_factory=list)
    # Warnings that belong to the crew and the receiving facility rather than to
    # the matching engine — a chemical hazard does not change which hospital is
    # right, it changes what the crew walks into.
    scene_advisories: list[str] = field(default_factory=list)


# Observations that imply a specific specialty regardless of category.
OBSERVATION_SPECIALTY: dict[ObservationFlag, str] = {
    ObservationFlag.PARALYSIS_ONE_SIDE: "neurology",
    ObservationFlag.SLURRED_SPEECH: "neurology",
    ObservationFlag.SEVERE_HEADACHE: "neurology",
    ObservationFlag.CHEST_PAIN: "cardiology",
    ObservationFlag.BREATHLESSNESS: "pulmonology",
    ObservationFlag.BURNS_SURFACE: "burns",
    ObservationFlag.INHALATION_SMOKE: "burns",
    ObservationFlag.POSTPARTUM_BLEEDING: "obstetrics",
    ObservationFlag.OBSTETRIC_LABOUR: "obstetrics",
    ObservationFlag.DIALYSIS_MISSED: "nephrology",
    ObservationFlag.POISON_INGESTED: "critical_care",
    ObservationFlag.SNAKEBITE_SWELLING: "critical_care",
}

# Observations that mean the patient cannot protect their own airway, so the
# receiving facility needs critical care capacity whatever the category says.
AIRWAY_OBSERVATIONS = {
    ObservationFlag.INHALATION_SMOKE,
    ObservationFlag.SEIZURE,
}

HAZARD_ADVISORIES: dict[Hazard, str] = {
    Hazard.TRAFFIC_ACTIVE: "Live traffic at scene — approach with the road closed where possible",
    Hazard.FIRE: "Fire at scene — notify the receiving facility of possible airway burns",
    Hazard.CHEMICAL: "Chemical exposure — decontamination required before the patient enters the ED",
    Hazard.ELECTRICAL: "Electrical hazard — confirm the supply is isolated before approach",
    Hazard.CONFINED_SPACE: "Confined space — extrication may delay scene time",
}


def derive(
    *,
    category: IncidentCategory,
    patient_state: PatientState,
    mechanism: Mechanism,
    bleeding: Bleeding,
    hazard: Hazard,
    observations: list[ObservationFlag],
    trapped: bool,
    bystander_cpr: bool,
    casualty_count: int,
) -> DerivedNeeds:
    """Compute the resource requirement implied by the scene assessment."""
    needs = DerivedNeeds()
    obs = set(observations)

    # --- airway and breathing ------------------------------------------------
    if patient_state is PatientState.UNCONSCIOUS_NOT_BREATHING:
        needs.requires_icu = True
        needs.requires_ventilator = True
        needs.specialty = needs.specialty or "critical_care"
        needs.rationale.append("Not breathing at scene — ventilation and critical care required")
        if bystander_cpr:
            needs.rationale.append("Bystander CPR in progress — continue en route")

    elif patient_state is PatientState.UNCONSCIOUS_BREATHING:
        needs.requires_icu = True
        needs.rationale.append("Unconscious but breathing — monitored bed required")

    elif patient_state is PatientState.DROWSY:
        needs.rationale.append("Reduced consciousness — reassess en route")

    if obs & AIRWAY_OBSERVATIONS:
        needs.requires_icu = True
        needs.specialty = needs.specialty or "critical_care"
        needs.rationale.append("Airway at risk from the reported presentation")

    # --- haemorrhage ---------------------------------------------------------
    if bleeding is Bleeding.SEVERE:
        needs.requires_blood = True
        needs.requires_icu = True
        needs.specialty = needs.specialty or "critical_care"
        needs.rationale.append("Major haemorrhage — blood bank and critical care required")

    # --- mechanism -----------------------------------------------------------
    if mechanism in (Mechanism.HEAVY_VEHICLE, Mechanism.FALL_HEIGHT):
        needs.requires_icu = True
        needs.specialty = needs.specialty or "trauma"
        needs.rationale.append("High-energy mechanism — trauma team required")
    elif mechanism in (Mechanism.TWO_WHEELER, Mechanism.CAR, Mechanism.PEDESTRIAN):
        needs.specialty = needs.specialty or "trauma"

    if trapped:
        needs.scene_advisories.append("Patient trapped — extrication may extend scene time")

    # --- presentation --------------------------------------------------------
    for flag in observations:
        mapped = OBSERVATION_SPECIALTY.get(flag)
        if mapped and needs.specialty is None:
            needs.specialty = mapped
            needs.rationale.append(
                f"{flag.value.replace('_', ' ').title()} reported — routing to {mapped.replace('_', ' ')}"
            )
        elif mapped:
            needs.rationale.append(f"{flag.value.replace('_', ' ').title()} also reported")

    # --- category defaults ---------------------------------------------------
    # Fill in only where the observations have not already said something more
    # specific, so a cardiac call with no observations still routes correctly.
    if needs.specialty is None:
        needs.specialty = {
            IncidentCategory.CARDIAC: "cardiology",
            IncidentCategory.STROKE: "neurology",
            IncidentCategory.BURNS: "burns",
            IncidentCategory.OBSTETRIC: "obstetrics",
            IncidentCategory.PAEDIATRIC: "paediatrics",
            IncidentCategory.DIALYSIS: "nephrology",
            IncidentCategory.RESPIRATORY: "pulmonology",
        }.get(category)

    if category is IncidentCategory.SNAKEBITE and bleeding is not Bleeding.NONE:
        needs.rationale.append("Snakebite with bleeding — antivenom and coagulation support")

    # --- scene hazards -------------------------------------------------------
    advisory = HAZARD_ADVISORIES.get(hazard)
    if advisory:
        needs.scene_advisories.append(advisory)

    # --- multiple casualties -------------------------------------------------
    if casualty_count > 1:
        needs.rationale.append(
            f"{casualty_count} casualties at scene — the receiving facility will need "
            "additional capacity and this is not a single-patient dispatch"
        )

    return needs
