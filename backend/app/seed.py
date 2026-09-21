"""Pilot dataset.

Everything here is synthetic. Facility names are invented (they are deliberately
*not* real Tamil Nadu hospitals, because attaching fabricated capacity numbers to
a real institution's name is not something you should do even in a demo), but the
geography, the district populations, the facility mix and the capacity ratios are
shaped to match a real Coimbatore-region pilot so the numbers exercise the same
paths they will in the field.

Seeding is idempotent: it refuses to run against a database that already has
facilities, so a restart never double-populates the live projection.
"""

from __future__ import annotations

import logging
import math
import random
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .live import CapacityView, live_store
from .models import (
    Ambulance,
    AmbulanceStatus,
    BedHold,
    Bleeding,
    CapacityRecord,
    Connector,
    ConnectorKind,
    District,
    Doctor,
    EdCongestion,
    Feedback,
    Hazard,
    Hospital,
    HospitalType,
    Incident,
    IncidentCategory,
    IncidentStatus,
    HoldStatus,
    IntegrationMode,
    Mechanism,
    Notification,
    NotificationKind,
    ObservationFlag,
    PatientState,
    Urgency,
    User,
    UserRole,
    VerificationStatus,
    utcnow,
)
from .security import hash_password

log = logging.getLogger("medmesh.seed")

RNG = random.Random(20260916)

# --------------------------------------------------------------------------- #
# Reference geography
# --------------------------------------------------------------------------- #

# Districts come from the statewide dataset in app/data/tn_districts.py, which
# carries all 38 of Tamil Nadu with real headquarters coordinates. The six
# original pilot districts keep their original codes and positions, because
# pilot accounts, connectors and incidents reference them -- a reshuffle here
# would silently repoint a hospital administrator at the wrong facility.
from .data.tn_districts import TN_DISTRICTS, TN_FACILITIES  # noqa: E402

DISTRICTS = list(TN_DISTRICTS)

SPECIALTY_POOL = [
    "general_medicine",
    "general_surgery",
    "orthopaedics",
    "cardiology",
    "neurology",
    "neurosurgery",
    "paediatrics",
    "obstetrics",
    "gynaecology",
    "burns",
    "plastic_surgery",
    "nephrology",
    "pulmonology",
    "critical_care",
    "trauma",
    "urology",
    "gastroenterology",
    "oncology",
    "psychiatry",
]

DOCTOR_NAMES = [
    "Anbarasan R",
    "Kalaivani S",
    "Senthil Kumar M",
    "Priya Dharshini V",
    "Muthukumar P",
    "Rajeswari N",
    "Vignesh Balaji K",
    "Fathima Begum A",
    "Ganesan T",
    "Deepa Lakshmi R",
    "Arun Prakash S",
    "Nithya Sree M",
    "Balamurugan V",
    "Saravanan D",
    "Hemalatha K",
    "Karthikeyan J",
    "Meenakshi Sundaram R",
    "Sundar Raj N",
    "Ayesha Siddiqua M",
    "Prabhakaran L",
    "Chitra Devi S",
    "Manikandan A",
    "Revathi G",
    "Suresh Babu K",
    "Lakshmi Narayanan V",
    "Bhuvaneshwari P",
    "Dinesh Kumar S",
    "Nandhini R",
    "Rajasekar M",
    "Vasanthi Devi K",
    "Ilango Adigal S",
    "Shanthi Priya M",
    "Thirumurugan R",
    "Kaavya Shree A",
    "Palanisamy G",
    "Sneha Reddy V",
    "Anitha Kumari R",
    "Balaji Shankar M",
    "Chandrasekar V",
    "Devanathan P",
    "Elango Krishnan S",
    "Fathima Zahra N",
    "Gomathi Sankar V",
    "Hariharan B",
    "Indira Gandhi M",
    "Jayanthi S",
    "Kamala Devi R",
    "Krishnakumar T",
    "Lakshmi Priya K",
    "Mani Ratnam S",
    "Nagaraj S",
    "Oviya Nandhini R",
    "Padmanabhan K",
    "Qadir Mohideen S",
    "Rajan Babu M",
    "Sakthivel N",
    "Thamarai Selvi R",
    "Uma Maheshwari S",
    "Venkatesh Prabhu M",
    "Yamuna Devi K",
    "Zubeida Begum A",
    "Aarthi Ramesh V",
    "Bharanidharan S",
    "Chithra Lakshmi M",
    "Dhanasekar P",
    "Ezhilarasi N",
    "Gopinath S",
    "Hemavathi R",
    "Ilakkiya S",
    "Jagadeesan M",
    "Kalaiselvi P",
    "Loganathan A",
    "Malathi Sundari R",
    "Naveen Prasad S",
    "Omprakash V",
    "Pavithra Devi M",
    "Rathinavel K",
    "Selvaraj M",
    "Thenmozhi R",
    "Udhaya Kumar S",
    "Vetri Selvan P",
    "Yogalakshmi N",
    "Amarnath Reddy K",
    "Bhagyalakshmi S",
    "Cyril Jason A",
    "Divya Bharathi M",
]


SPECIALTY_BY_DEPARTMENT = {
    "Cardiology": ["cardiology"],
    "Cardiothoracic Surgery": ["cardiology", "general_surgery"],
    "Neurology": ["neurology"],
    "Neurosurgery": ["neurosurgery", "trauma"],
    "Orthopaedics": ["orthopaedics", "trauma"],
    "General Medicine": ["general_medicine"],
    "General Surgery": ["general_surgery", "trauma"],
    "Paediatrics": ["paediatrics"],
    "Neonatology": ["paediatrics", "critical_care"],
    "Obstetrics & Gynaecology": ["obstetrics", "gynaecology"],
    "Emergency Medicine": ["critical_care", "trauma"],
    "Critical Care": ["critical_care"],
    "Nephrology": ["nephrology"],
    "Pulmonology": ["pulmonology"],
    "Burns & Plastic Surgery": ["burns", "plastic_surgery"],
    "Gastroenterology": ["gastroenterology"],
    "Urology": ["urology"],
    "Oncology": ["oncology"],
    "Psychiatry": ["psychiatry"],
}

# Which department a facility means when it says it offers a given specialty.
# Derived from SPECIALTY_BY_DEPARTMENT but with the generic department chosen
# where several could claim it: "general surgery" is offered by a General
# Surgery department, not by Cardiothoracic Surgery, and picking the exotic one
# is how a district hospital ends up with a cardiologist on its roster and a
# cardiac call ends up routed to a facility with no cath lab.
PREFERRED_DEPARTMENT: dict[str, str] = {
    "cardiology": "Cardiology",
    "neurology": "Neurology",
    "neurosurgery": "Neurosurgery",
    "orthopaedics": "Orthopaedics",
    "trauma": "Emergency Medicine",
    "general_medicine": "General Medicine",
    "general_surgery": "General Surgery",
    "paediatrics": "Paediatrics",
    "obstetrics": "Obstetrics & Gynaecology",
    "gynaecology": "Obstetrics & Gynaecology",
    "critical_care": "Critical Care",
    "nephrology": "Nephrology",
    "pulmonology": "Pulmonology",
    "burns": "Burns & Plastic Surgery",
    "plastic_surgery": "Burns & Plastic Surgery",
    "gastroenterology": "Gastroenterology",
    "urology": "Urology",
    "oncology": "Oncology",
    "psychiatry": "Psychiatry",
}

# Fallback for any specialty that is not in the table above.
SPECIALTY_TO_DEPARTMENTS: dict[str, list[str]] = {}
for _dept, _specs in SPECIALTY_BY_DEPARTMENT.items():
    for _sp in _specs:
        SPECIALTY_TO_DEPARTMENTS.setdefault(_sp, []).append(_dept)



DESIGNATIONS = ["Consultant", "Senior Consultant", "Associate Professor", "Assistant Professor", "Registrar", "Chief Consultant"]
SHIFTS = ["morning", "afternoon", "night", "on_call"]

# --------------------------------------------------------------------------- #
# Facilities
# --------------------------------------------------------------------------- #
# (short_name, full_name, type, district_code, beds, icu, vents, integration,
#  specialties, capabilities, offset_lat, offset_lng)

FACILITIES = [
    ("KGCH", "Kovai Government General Hospital", "public", "CBE", 1020, 86, 44, "api",
     ["general_medicine", "general_surgery", "orthopaedics", "paediatrics", "obstetrics", "gynaecology", "critical_care", "trauma", "nephrology", "neurology", "burns"],
     {"blood_bank", "trauma_centre", "dialysis", "burn_unit"}, 0.004, 0.006),
    ("SRMC", "Sri Ranga Medical College Hospital", "private", "CBE", 640, 72, 48, "api",
     ["cardiology", "neurology", "neurosurgery", "critical_care", "trauma", "gastroenterology", "urology", "oncology", "burns"],
     {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "burn_unit"}, -0.021, 0.014),
    ("GKSH", "Ganga Kaveri Speciality Hospital", "private", "CBE", 320, 54, 32, "api",
     ["cardiology", "pulmonology", "nephrology", "critical_care", "general_medicine"],
     {"blood_bank", "cath_lab", "dialysis"}, 0.019, -0.026),
    ("ATPU", "Annai Trust Hospital, Peelamedu", "trust", "CBE", 210, 18, 10, "manual",
     ["general_medicine", "general_surgery", "obstetrics", "paediatrics"],
     {"blood_bank"}, 0.028, 0.036),
    ("MMCH", "Thirumoorthy Mission Hospital", "trust", "CBE", 175, 14, 8, "manual",
     ["general_medicine", "general_surgery", "paediatrics", "pulmonology"],
     set(), -0.042, -0.018),
    ("SKKB", "Sanjeevi Children & Maternity Centre", "private", "CBE", 140, 22, 14, "api",
     ["paediatrics", "obstetrics", "gynaecology", "critical_care"],
     {"neonatal_icu", "blood_bank"}, 0.012, 0.022),
    ("BCUH", "Bharathi Critical Care Unit, Saibaba Colony", "private", "CBE", 96, 40, 26, "api",
     ["critical_care", "pulmonology", "general_medicine"],
     {"blood_bank"}, 0.008, -0.012),
    ("TVBC", "Thondamuthur Village Health Centre", "public", "CBE", 30, 2, 1, "manual",
     ["general_medicine"], set(), -0.108, -0.088),
    ("KNBP", "Kinathukadavu Block Hospital", "public", "CBE", 46, 4, 2, "manual",
     ["general_medicine", "obstetrics"], set(), -0.162, -0.121),
    ("SRKP", "Saravanampatti Community Hospital", "public", "CBE", 84, 8, 4, "manual",
     ["general_medicine", "general_surgery", "paediatrics"], {"blood_bank"}, 0.058, 0.048),
    ("NTPS", "Nallamuthu Surgical & Trauma Centre", "private", "CBE", 118, 20, 12, "api",
     ["trauma", "orthopaedics", "general_surgery", "critical_care"],
     {"trauma_centre", "blood_bank"}, -0.014, 0.041),
    ("AKBH", "Annur Government Block Hospital", "public", "CBE", 62, 6, 3, "manual",
     ["general_medicine", "general_surgery"], set(), 0.086, 0.094),

    ("TPGH", "Tiruppur District Headquarters Hospital", "public", "TUP", 480, 38, 20, "api",
     ["general_medicine", "general_surgery", "orthopaedics", "paediatrics", "obstetrics", "trauma"],
     {"blood_bank", "trauma_centre"}, 0.006, -0.004),
    ("KPRN", "Kongu Ponnusamy Referral Hospital", "private", "TUP", 260, 34, 20, "api",
     ["cardiology", "critical_care", "neurology", "general_surgery"],
     {"blood_bank", "cath_lab"}, -0.024, 0.018),
    ("AVIN", "Avinashi Taluk Hospital", "public", "TUP", 90, 8, 4, "manual",
     ["general_medicine", "obstetrics"], set(), 0.038, -0.082),
    ("SIPC", "Sripuram Industrial Care Hospital", "private", "TUP", 150, 24, 16, "manual",
     ["trauma", "orthopaedics", "general_medicine"], {"blood_bank", "trauma_centre"}, 0.012, 0.036),

    ("ERGH", "Erode Government Headquarters Hospital", "public", "ERD", 520, 42, 22, "api",
     ["general_medicine", "general_surgery", "orthopaedics", "paediatrics", "obstetrics", "trauma", "critical_care"],
     {"blood_bank", "trauma_centre", "dialysis"}, 0.003, 0.005),
    ("VKSH", "Vellakoil Sathya Hospital", "private", "ERD", 190, 26, 15, "api",
     ["cardiology", "general_surgery", "critical_care"], {"blood_bank", "cath_lab"}, -0.018, 0.042),
    ("BSMH", "Bhavani Sri Maruthi Hospital", "trust", "ERD", 110, 10, 6, "manual",
     ["general_medicine", "paediatrics", "obstetrics"], set(), 0.026, -0.014),
    ("GOBI", "Gobichettipalayam Taluk Hospital", "public", "ERD", 132, 12, 6, "manual",
     ["general_medicine", "general_surgery", "trauma"], {"blood_bank"}, -0.042, 0.038),

    ("SGMH", "Salem Government Mohan Kumaramangalam Hospital", "public", "SLM", 1150, 94, 52, "api",
     ["general_medicine", "general_surgery", "orthopaedics", "paediatrics", "obstetrics", "critical_care", "trauma", "neurology", "nephrology", "oncology"],
     {"blood_bank", "trauma_centre", "dialysis", "neonatal_icu"}, 0.004, -0.006),
    ("SMVR", "Sri Venkateswara Referral Hospital, Salem", "private", "SLM", 380, 46, 28, "api",
     ["cardiology", "neurology", "neurosurgery", "critical_care", "gastroenterology"],
     {"blood_bank", "cath_lab"}, 0.021, 0.016),
    ("ATTS", "Attur Taluk Hospital", "public", "SLM", 76, 6, 3, "manual",
     ["general_medicine", "obstetrics"], set(), 0.062, 0.148),
    ("MERK", "Mettur Industrial Hospital", "public", "SLM", 64, 5, 2, "manual",
     ["general_medicine", "orthopaedics"], set(), 0.028, -0.128),

    ("CTHM", "Coonoor Taluk Hospital", "public", "NIL", 92, 8, 4, "manual",
     ["general_medicine", "general_surgery", "obstetrics"], {"blood_bank"}, -0.056, 0.038),
    ("BETH", "Bethany Hill Mission Hospital", "trust", "NIL", 60, 6, 3, "manual",
     ["general_medicine", "paediatrics"], set(), -0.038, 0.012),

    ("MGRM", "Madurai Government Rajaji Hospital", "public", "MDU", 1420, 110, 60, "api",
     ["general_medicine", "general_surgery", "orthopaedics", "paediatrics", "obstetrics", "critical_care", "trauma", "cardiology", "neurology", "oncology"],
     {"blood_bank", "trauma_centre", "cath_lab", "dialysis", "neonatal_icu"}, 0.003, 0.004),
    ("VRRM", "Vaigai River Referral Hospital", "private", "MDU", 290, 38, 22, "api",
     ["cardiology", "critical_care", "nephrology", "general_surgery"],
     {"blood_bank", "cath_lab", "dialysis"}, -0.019, 0.022),
    ("USLM", "Usilampatti Block Hospital", "public", "MDU", 88, 7, 3, "manual",
     ["general_medicine", "obstetrics", "trauma"], set(), -0.148, -0.082),
]

# The rest of the state. Appended rather than interleaved so the pilot estate
# stays first and the seeded accounts keep pointing at the same facilities.
FACILITIES = FACILITIES + list(TN_FACILITIES)


BURN_UNIT = {"Kovai Government General Hospital", "Sri Ranga Medical College Hospital"}
CATH_LAB = {"Sri Ranga Medical College Hospital", "Ganga Kaveri Speciality Hospital", "Kongu Ponnusamy Referral Hospital", "Vellakoil Sathya Hospital", "Sri Venkateswara Referral Hospital, Salem", "Madurai Government Rajaji Hospital", "Vaigai River Referral Hospital"}


def slugify(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")[:64]


def _base_profile(hospital_total_beds: int, total_icu: int, kind: str) -> tuple[int, int, int]:
    """Pick a plausible baseline occupancy. Government and large referral
    facilities in the region run hot; small private units keep slack for
    elective work. This is what makes the map look like a real district rather
    than a uniformly half-empty grid."""
    busy = {
        "public": (0.68, 0.88),
        "private": (0.48, 0.74),
        "trust": (0.42, 0.66),
    }[kind]
    occ = RNG.uniform(*busy)
    beds = max(0, int(hospital_total_beds * (1 - occ)))
    icu_occ = min(0.98, occ + RNG.uniform(0.04, 0.16))
    icu = max(0, int(total_icu * (1 - icu_occ)))
    return beds, icu, occ


def seed_all(db: Session, *, with_history: bool = True) -> dict:
    if db.execute(select(func.count()).select_from(Hospital)).scalar_one() > 0:
        return {"seeded": False, "reason": "database already contains facilities"}

    now = utcnow()

    # ---------------------------------------------------------------- districts
    district_by_code: dict[str, District] = {}
    for code, name, name_ta, lat, lng, pop in DISTRICTS:
        d = District(code=code, name=name, name_ta=name_ta, state="Tamil Nadu", lat=lat, lng=lng, population=pop)
        db.add(d)
        district_by_code[code] = d
    db.flush()

    # ---------------------------------------------------------------- hospitals
    hospitals: list[Hospital] = []
    hospital_by_short: dict[str, Hospital] = {}
    # Districts whose principal public facility has already been marked verified.
    _principal_verified: set[str] = set()
    for idx, row in enumerate(FACILITIES):
        (short, name, kind, code, beds, icu, vents, integration, specs, caps, dlat, dlng) = row
        district = district_by_code[code]
        # Jitter facilities around their district centre so the map does not
        # render a perfect ring of pins.
        lat = round(district.lat + dlat + RNG.uniform(-0.004, 0.004), 5)
        lng = round(district.lng + dlng + RNG.uniform(-0.004, 0.004), 5)

        cap_set = set(caps)
        if name in BURN_UNIT:
            cap_set.add("burn_unit")
        if name in CATH_LAB:
            cap_set.add("cath_lab")

        # Verification is assigned by role in the estate, not by position in
        # the list.
        #
        # It used to be `idx % 9 == 7`, which was harmless for a 29-facility
        # pilot and actively wrong for a statewide one: at 152 facilities the
        # modulus lands wherever it lands, and it left one district's only two
        # hospitals unverified -- so the district disappeared from the public
        # directory entirely while looking fine from inside the platform. A rule
        # that can silently erase a whole district is not a fixture, it is a
        # bug waiting for the dataset to change.
        #
        # The rule now: a district's principal public hospital is always
        # verified, because it is the state's actual safety net and every
        # district must be visible and usable. Everything else varies, so the
        # pending-verification queue and the low-trust paths still have material
        # to work with.
        verification = VerificationStatus.VERIFIED
        if kind == "public" and code not in _principal_verified:
            _principal_verified.add(code)
        elif idx % 7 == 5:
            verification = VerificationStatus.PENDING
        elif idx % 11 == 9:
            verification = VerificationStatus.UNVERIFIED

        h = Hospital(
            slug=slugify(name),
            name=name,
            short_name=short,
            type=HospitalType(kind),
            district_id=district.id,
            address=f"{short} Campus, {district.name}",
            lat=lat,
            lng=lng,
            verification=verification,
            integration=IntegrationMode(integration),
            source_system=(
                RNG.choice(["HL7-FHIR R4", "HL7-FHIR R4", "Vendor REST bridge", "In-house HMS adapter"])
                if integration == "api"
                else None
            ),
            contact_phone=f"0422-{RNG.randint(2000000, 2999999)}",
            emergency_phone=f"0422-{RNG.randint(2000000, 2999999)}",
            total_beds=beds,
            total_icu=icu,
            total_ventilators=vents,
            specialties=",".join(sorted(specs)),
            has_blood_bank="blood_bank" in cap_set,
            has_trauma_centre="trauma_centre" in cap_set,
            has_cath_lab="cath_lab" in cap_set,
            has_burn_unit="burn_unit" in cap_set,
            has_dialysis="dialysis" in cap_set,
            has_neonatal_icu="neonatal_icu" in cap_set,
            antivenom_stock=RNG.choice([0, 0, 4, 8, 12, 20]) if "trauma_centre" in cap_set or beds > 100 else RNG.choice([0, 2, 6]),
            expose_doctor_directory=not (kind == "private" and idx % 7 == 3),
            onboarding_completed_at=now - timedelta(days=RNG.randint(40, 400)),
            created_at=now - timedelta(days=RNG.randint(60, 500)),
        )
        db.add(h)
        hospitals.append(h)
        hospital_by_short[short] = h
    db.flush()

    # ---------------------------------------------------------------- capacity
    # 72 hours of half-hourly history plus the last three hours at five-minute
    # resolution, so the analytics trend and the 2-hour sparkline both have
    # honest data to draw.
    records: list[CapacityRecord] = []
    latest_state: dict[int, dict] = {}

    for h in hospitals:
        base_beds, base_icu, occ = _base_profile(h.total_beds, h.total_icu, h.type.value)
        base_vent = max(0, int(h.total_ventilators * (1 - min(0.97, occ + RNG.uniform(0.0, 0.12)))))
        base_wait = int(RNG.uniform(2, 9) * (1.6 if h.type.value == "public" else 1.0))
        blood = RNG.randint(8, 90) if h.has_blood_bank else 0

        stamps: list[tuple[int, int]] = []
        for step in range(144, 0, -1):
            stamps.append((step * 30, 0))
        for step in range(36, 0, -1):
            stamps.append((step * 5, 1))

        beds, icu, vent, wait = base_beds, base_icu, base_vent, base_wait
        for idx, (mins_ago, fine) in enumerate(stamps):
            # Slow diurnal component plus an Ornstein-Uhlenbeck-style pull back
            # toward the facility's baseline. Without that pull the walk is
            # free to wander off to zero and *stay* there -- a clinic that
            # reports no free beds for three days reads as a broken feed, not a
            # busy one.
            phase = math.sin((idx / max(len(stamps), 1)) * math.pi * 2)
            drift = phase * (0.9 if h.type.value == "public" else 0.5)

            def step(current: int, target: int, noise: float, ceiling: int) -> int:
                pull = 0.055 * (target - current)
                return max(0, min(ceiling, int(round(current + pull + RNG.gauss(drift, noise)))))

            beds = step(beds, base_beds, 2.2, h.total_beds)
            icu = step(icu, base_icu, 1.1, h.total_icu)
            vent = step(vent, base_vent, 0.8, h.total_ventilators)
            wait = step(wait, base_wait, 1.6, 60)

            congestion = (
                EdCongestion.CRITICAL if wait >= 18
                else EdCongestion.HIGH if wait >= 11
                else EdCongestion.MODERATE if wait >= 5
                else EdCongestion.LOW
            )
            ts = now - timedelta(minutes=mins_ago)
            records.append(
                CapacityRecord(
                    hospital_id=h.id,
                    beds_available=beds,
                    icu_available=icu,
                    ventilators_available=vent,
                    ed_congestion=congestion,
                    ed_waiting=wait,
                    blood_units=max(0, blood + RNG.randint(-4, 4)),
                    antivenom_vials=h.antivenom_stock,
                    source=h.integration,
                    recorded_at=ts,
                    trust_state="live",
                    anomaly_flags="",
                    quarantined=False,
                )
            )
            latest_state[h.id] = {
                "beds": beds, "icu": icu, "vent": vent, "wait": wait,
                "congestion": congestion, "blood": max(0, blood + RNG.randint(-4, 4)),
                "at": ts,
            }
    db.add_all(records)
    db.flush()

    # ---------------------------------------------------------------- projection
    # Populated here rather than at the end of the function, because the
    # matching engine reads the live projection and the seeded in-flight case
    # below needs a real shortlist to commit against. An empty projection makes
    # every candidate ineligible and the dispatch silently no-ops.
    for h in hospitals:
        state = latest_state[h.id]
        live_store.put(
            CapacityView(
                hospital_id=h.id,
                beds_available=state["beds"],
                total_beds=h.total_beds,
                icu_available=state["icu"],
                total_icu=h.total_icu,
                ventilators_available=state["vent"],
                total_ventilators=h.total_ventilators,
                ed_congestion=state["congestion"].value,
                ed_waiting=state["wait"],
                blood_units=state["blood"],
                antivenom_vials=h.antivenom_stock,
                source=h.integration.value,
                recorded_at=state["at"],
                trust_state="live",
            )
        )

    # ---------------------------------------------------------------- doctors
    names = DOCTOR_NAMES[:]
    RNG.shuffle(names)
    name_idx = 0
    doctor_rows: list[Doctor] = []
    for h in hospitals:
        # The roster is derived from the services this facility advertises, so
        # "lists cardiology" and "employs a cardiologist" are correlated but not
        # identical -- which is the real-world state the matching engine has to
        # reason about. One facility in four is left deliberately short-staffed
        # so the "department listed, nobody on roster" path is exercised rather
        # than assumed away.
        declared = [sp.strip() for sp in (h.specialties or "").split(",") if sp.strip()]
        departments: list[str] = []
        for sp in declared:
            dept = PREFERRED_DEPARTMENT.get(sp) or (SPECIALTY_TO_DEPARTMENTS.get(sp) or [None])[0]
            if dept and dept not in departments:
                departments.append(dept)

        if not departments:
            departments = ["General Medicine"]

        short_staffed = len(departments) > 2 and RNG.random() < 0.25
        if short_staffed:
            # Drop the service the facility is least likely to have covered
            # overnight, and only ever one of them.
            departments = departments[1:] if RNG.random() < 0.5 else departments[:-1]

        # Big facilities cover more of what they advertise; small ones run a
        # skeleton roster.
        cap = 6 if h.total_beds > 400 else 4 if h.total_beds > 120 else 2
        if len(departments) > cap:
            departments = departments[:cap]

        for dept in departments:
            specialty = RNG.choice(SPECIALTY_BY_DEPARTMENT[dept])
            # Roster size: a department with a single name has no night cover,
            # so the larger services get a second and third.
            slots = 1 if h.total_beds < 120 else RNG.choice([1, 2, 2, 3])
            for slot in range(slots):
                shift = RNG.choice(SHIFTS)
                on_duty = RNG.random() < (0.42 if shift == "night" else 0.62)
                window = {"morning": 6, "afternoon": 6, "night": 8, "on_call": 12}[shift]
                duty_end = now + timedelta(minutes=RNG.randint(20, window * 60)) if on_duty else None
                doctor_rows.append(
                    Doctor(
                        hospital_id=h.id,
                        full_name=names[name_idx % len(names)],
                        registration_no=f"TNMC-{RNG.randint(40000, 99999)}",
                        specialty=specialty,
                        department=dept,
                        designation=RNG.choice(DESIGNATIONS),
                        on_duty=on_duty,
                        duty_start=now - timedelta(hours=RNG.randint(1, 6)) if on_duty else None,
                        duty_end=duty_end,
                        shift=shift,
                        accepts_emergency=RNG.random() < 0.82,
                        languages=RNG.choice(
                            ["Tamil, English", "Tamil, English, Hindi", "Tamil", "Tamil, Malayalam"]
                        ),
                        last_toggled_at=now - timedelta(minutes=RNG.randint(5, 300)) if on_duty else None,
                    )
                )
                name_idx += 1
    db.add_all(doctor_rows)
    db.flush()

    # ---------------------------------------------------------------- fleet
    #
    # Statewide fleet, sized to the districts rather than to the demo. Every
    # district gets at least one 108 unit, because a district with no unit is a
    # district where the dispatcher console shows an empty fleet and the
    # ambulance-assignment path can never be exercised for it. Larger districts
    # get more, and the capability mix follows the estate: a NICU unit is only
    # based where there is a facility with a neonatal ICU to receive it, since a
    # neonatal transport based two hours from the nearest incubator is a
    # capability on paper only.
    fleet: list[Ambulance] = []
    nicu_districts = {
        d
        for (short, _n, _k, d, _b, _i, _v, _int, _sp, caps, _a, _b2) in FACILITIES
        if "neonatal_icu" in caps
    }
    for code, name, _ta, lat, lng, population in DISTRICTS:
        d = district_by_code[code]
        # Roughly one unit per 1.4 million residents, minimum one.
        units = max(1, round(population / 1_400_000))
        for n in range(units):
            if code in nicu_districts and n == 0:
                cap = "nicu"
            elif population > 2_500_000 or n == 0:
                cap = "als"
            else:
                cap = RNG.choices(["bls", "als"], weights=[7, 3])[0]
            fleet.append(
                Ambulance(
                    call_sign=f"108-TN{code}-{RNG.randint(1000, 9999)}",
                    registration=f"TN {RNG.randint(10, 99)} {RNG.choice('ABCDEFGHJK')}{RNG.choice('ABCDEFGHJK')} {RNG.randint(1000, 9999)}",
                    operator_type="108",
                    operator_name="GVK EMRI 108",
                    base_district_id=d.id,
                    status=AmbulanceStatus.AVAILABLE if (len(fleet) % 3) else AmbulanceStatus.EN_ROUTE,
                    lat=round(lat + RNG.uniform(-0.06, 0.06), 5),
                    lng=round(lng + RNG.uniform(-0.06, 0.06), 5),
                    capabilities=cap,
                )
            )

    # Private operators sit in the same pool, per §6.10 -- concentrated in the
    # districts that actually have a private ambulance market.
    for code in ("CBE", "CBE", "CHN", "CHN", "MDU", "TRL", "SLM", "TUP", "TRY", "TNV", "ERD", "CGP"):
        d = district_by_code[code]
        fleet.append(
            Ambulance(
                call_sign=f"KAIRASI-{code}-{RNG.randint(100, 999)}",
                registration=f"TN {RNG.randint(10, 99)} {RNG.choice('ABCDEFGHJK')}{RNG.choice('ABCDEFGHJK')} {RNG.randint(1000, 9999)}",
                operator_type="private",
                operator_name=RNG.choice(
                    [
                        "Kovai LifeLine Ambulance Services",
                        "MedRide Tamil Nadu",
                        "Kongu Emergency Transport",
                        "Chennai Critical Care Transport",
                        "Pandian Ambulance Network",
                    ]
                ),
                base_district_id=d.id,
                status=AmbulanceStatus.AVAILABLE,
                lat=round(d.lat + RNG.uniform(-0.08, 0.08), 5),
                lng=round(d.lng + RNG.uniform(-0.08, 0.08), 5),
                capabilities=RNG.choice(["bls", "als"]),
            )
        )
    db.add_all(fleet)
    db.flush()

    # ---------------------------------------------------------------- accounts
    cbe = district_by_code["CBE"]
    anchor = hospital_by_short["SRMC"]

    accounts = [
        dict(email="admin@medmesh.in", full_name="Platform Operations", role=UserRole.PLATFORM_ADMIN, pw="MedMesh@2026"),
        dict(email="dispatch@medmesh.in", full_name="R. Karthikeyan", role=UserRole.DISPATCHER, district_id=cbe.id, pw="Dispatch@108"),
        dict(email="gov@medmesh.in", full_name="Dr. S. Rajalakshmi", role=UserRole.GOV_OFFICIAL, district_id=cbe.id, amr_scope="district", pw="District@2026"),
        dict(email="admin@kgch.medmesh.in", full_name="Kovai Govt. General — Duty Office", role=UserRole.HOSPITAL_ADMIN, hospital_id=hospital_by_short["KGCH"].id, amr_scope="facility", pw="Hospital@2026"),
        dict(email="admin@srmc.medmesh.in", full_name="Sri Ranga — Bed Control Desk", role=UserRole.HOSPITAL_ADMIN, hospital_id=anchor.id, amr_scope="facility", pw="Hospital@2026"),
    ]
    for acc in accounts:
        pw = acc.pop("pw")
        db.add(User(password_hash=hash_password(pw), **acc))
    db.flush()

    crew_user = User(
        email="crew@medmesh.in",
        full_name="M. Selvaraj",
        role=UserRole.DRIVER,
        district_id=cbe.id,
        password_hash=hash_password("Crew@108"),
        amr_scope="facility",
    )
    db.add(crew_user)
    db.flush()
    fleet[0].driver_id = crew_user.id

    # ---------------------------------------------------------------- sample incidents
    incidents = []
    samples = [
        (IncidentCategory.ROAD_ACCIDENT, "Avinashi Road, near Hope College", Urgency.P1, True, False, True, "TN-1609-A7K", "CBE", 1, 42),
        (IncidentCategory.CARDIAC, "Sungam bypass, Saibaba Colony junction", Urgency.P1, True, True, False, "TN-1609-B4M", "CBE", 3, 18),
        (IncidentCategory.SNAKEBITE, "Thondamuthur village, near temple tank", Urgency.P1, True, False, False, "TN-1609-C9R", "CBE", 5, 7),
        (IncidentCategory.OBSTETRIC, "Peelamedu, near PSG junction", Urgency.P1, False, False, True, "TN-1609-D2T", "CBE", 8, 3),
    ]
    # Scene assessment for each seeded call. Written out in full rather than
    # randomised, so the pilot dataset contains one instance of each interesting
    # path: a high-energy mechanism that derives an ICU requirement, a cardiac
    # presentation that derives a cardiology requirement, and a severe bleed that
    # derives a blood requirement it was not explicitly given.
    scene_for = {
        IncidentCategory.ROAD_ACCIDENT: dict(
            patient_state=PatientState.DROWSY,
            mechanism=Mechanism.TWO_WHEELER,
            bleeding=Bleeding.MINOR,
            hazard=Hazard.TRAFFIC_ACTIVE,
            observations=[ObservationFlag.SUSPECTED_FRACTURE, ObservationFlag.LIMB_DEFORMITY],
        ),
        IncidentCategory.CARDIAC: dict(
            patient_state=PatientState.ALERT,
            mechanism=Mechanism.NONE,
            bleeding=Bleeding.NONE,
            hazard=Hazard.NONE,
            observations=[ObservationFlag.CHEST_PAIN, ObservationFlag.BREATHLESSNESS],
        ),
        IncidentCategory.SNAKEBITE: dict(
            patient_state=PatientState.ALERT,
            mechanism=Mechanism.OTHER,
            bleeding=Bleeding.NONE,
            hazard=Hazard.NONE,
            observations=[ObservationFlag.SNAKEBITE_SWELLING],
        ),
        IncidentCategory.OBSTETRIC: dict(
            patient_state=PatientState.ALERT,
            mechanism=Mechanism.NONE,
            bleeding=Bleeding.SEVERE,
            hazard=Hazard.NONE,
            observations=[ObservationFlag.OBSTETRIC_LABOUR, ObservationFlag.POSTPARTUM_BLEEDING],
        ),
    }

    for cat, landmark, urg, icu, vent, blood, ref, code, mins_ago, _ in samples:
        d = district_by_code[code]
        base = d.lat + RNG.uniform(-0.05, 0.05)
        scene = scene_for.get(cat, {})
        incidents.append(
            Incident(
                reference=ref,
                category=cat,
                urgency=urg,
                lat=round(base, 5),
                lng=round(d.lng + RNG.uniform(-0.05, 0.05), 5),
                landmark=landmark,
                district_id=d.id,
                patient_state=scene.get("patient_state", PatientState.UNKNOWN),
                mechanism=scene.get("mechanism", Mechanism.NONE),
                bleeding=scene.get("bleeding", Bleeding.NONE),
                hazard=scene.get("hazard", Hazard.NONE),
                casualty_count=scene.get("casualty_count", 1),
                trapped=scene.get("trapped", False),
                bystander_cpr=scene.get("bystander_cpr", False),
                observations=",".join(o.value for o in scene.get("observations", [])),
                requires_icu=icu,
                requires_ventilator=vent,
                requires_blood=blood,
                status=IncidentStatus.OPEN,
                created_by=1,
                created_at=now - timedelta(minutes=mins_ago),
            )
        )
    db.add_all(incidents)
    db.flush()

    # ------------------------------------------------- dispatched case in flight
    # A pilot dataset where nothing is in progress makes the crew app, the
    # console's committed state and the hospital's inbound panel all demonstrate
    # their empty state instead of their actual purpose. So one case is seeded
    # mid-response: matched, committed, a bed held, ambulance en route.
    from .routers.dispatch import build_shortlist  # imported here to avoid a cycle

    cardiac = next((i for i in incidents if i.category is IncidentCategory.CARDIAC), incidents[0])
    shortlist = build_shortlist(db, incident=cardiac, limit=6)
    best = next((c for c in shortlist if c["eligible"]), None)

    if best is not None:
        crew_unit = fleet[0]
        dispatched_at = now - timedelta(seconds=45)
        cardiac.assigned_hospital_id = best["hospital_id"]
        cardiac.assigned_ambulance_id = crew_unit.id
        cardiac.status = IncidentStatus.DISPATCHED
        cardiac.dispatched_at = dispatched_at
        # created_at must move with dispatched_at, or the simulator's lifecycle
        # loop sees an 18-minute-old incident and advances it straight past
        # 'en route' to 'handed over' on its first tick.
        cardiac.created_at = dispatched_at
        db.add(
            BedHold(
                hospital_id=best["hospital_id"],
                incident_id=cardiac.id,
                resource="icu",
                status=HoldStatus.ACTIVE,
                created_by=1,
                created_at=dispatched_at,
                expires_at=now + timedelta(minutes=11),
            )
        )
        # Park the crew a little way from the scene so the console's fleet layer
        # and the ETA countdown both have a believable starting position.
        scene_district = district_by_code["CBE"]
        crew_unit.lat = round(scene_district.lat - 0.031, 5)
        crew_unit.lng = round(scene_district.lng - 0.024, 5)
        crew_unit.status = AmbulanceStatus.EN_ROUTE
        db.flush()

    # ---------------------------------------------------------------- connectors
    # A pilot where every facility is badged "manual" cannot demonstrate the
    # integration story at all: the connector page, the health states and the
    # ingest path all render their empty state. So the API-integrated facilities
    # get real connectors, including one aged credential that is due a rotate,
    # one that has gone quiet, and one whose last push failed.
    from .services import connectors as connector_svc  # local import: avoids a cycle

    integrations = [
        # short_name, kind, source_system, hours_since_seen, last_status, error
        ("SRMC", ConnectorKind.FHIR_R4, "Cerner Millennium", 0.05, 202, None),
        ("MMCH", ConnectorKind.FHIR_R4, "Epic Caboodle", 0.2, 202, None),
        ("GKSH", ConnectorKind.CSV_SFTP, "TrakCare nightly drop", 7.5, 202, None),
        ("ATPU", ConnectorKind.VENDOR_REST, "Insta HMS", 0.4, 502, "upstream timed out after 10s"),
    ]
    seeded_keys: dict[str, str] = {}
    for index, (short, kind, system, hours_ago, status, error) in enumerate(integrations):
        hospital = hospital_by_short.get(short)
        if hospital is None:
            continue
        hospital.integration = IntegrationMode.API
        hospital.source_system = system
        connector = Connector(
            hospital_id=hospital.id,
            kind=kind,
            source_system=system,
            active=True,
            created_at=now - timedelta(days=40 + index * 11),
            last_seen_at=now - timedelta(hours=hours_ago),
            last_status_code=status,
            last_error=error,
            accepted_24h=180 + index * 46,
            rejected_24h=0 if error is None else 3,
            rotated_at=now - timedelta(days=200) if index == 0 else now - timedelta(days=12),
        )
        db.add(connector)
        db.flush()
        key = connector_svc.issue_key(db, connector)
        # issue_key stamps rotated_at with "now"; the story above is what the
        # key-age column is meant to show, so set it after minting.
        connector.rotated_at = now - timedelta(days=200) if index == 0 else now - timedelta(days=12)
        seeded_keys[short] = key
        log.info("connector key for %s: %s", short, key)

    # ---------------------------------------------------------------- notifications
    # The ward inbox is only meaningful with traffic in it. These are the three
    # kinds the platform actually generates, so the inbox, the severity colours
    # and the read/ack behaviour are all exercised by the seed.
    srmc = hospital_by_short["SRMC"]
    kgch = hospital_by_short["KGCH"]
    db.add_all(
        [
            Notification(
                hospital_id=srmc.id,
                kind=NotificationKind.INBOUND_PATIENT,
                title="Inbound P1 cardiac — ETA 11 min",
                body=(
                    "108-TNCBE-6723 en route. Hold ICU-03; prepare cath lab "
                    "and receive crew at trauma bay."
                ),
                severity="critical",
                incident_id=cardiac.id,
                created_at=now - timedelta(seconds=45),
            ),
            Notification(
                hospital_id=kgch.id,
                kind=NotificationKind.STALENESS_REMINDER,
                title="Bed count is 3 h 40 m old",
                body=(
                    "Dispatchers route on this number. Confirm or update the "
                    "keypad figures for beds and ICU."
                ),
                severity="warning",
                created_at=now - timedelta(minutes=52),
            ),
            Notification(
                hospital_id=srmc.id,
                kind=NotificationKind.SUBMISSION_QUARANTINED,
                title="Push rejected by the trust engine",
                body=(
                    "A connector submission claimed 326 beds and 19 ICU in one update, "
                    "against 118 and 4 ninety minutes earlier. It was quarantined and "
                    "not published. Confirm with the sending system, then re-send."
                ),
                severity="warning",
                payload='{"beds_available": 326, "icu_available": 19}',
                created_at=now - timedelta(hours=26),
                read_at=now - timedelta(hours=25),
                acknowledged_by=1,
            ),
        ]
    )

    # ---------------------------------------------------------------- feedback
    db.add_all(
        [
            Feedback(
                hospital_id=hospital_by_short["ATPU"].id,
                submitted_by=None,
                reporter_role="citizen",
                kind="beds_unavailable",
                comment="Directory said 6 beds free; casualty desk said none and sent us to KMCH.",
                created_at=now - timedelta(hours=9),
            ),
            Feedback(
                hospital_id=hospital_by_short["GKSH"].id,
                submitted_by=None,
                reporter_role="dispatcher",
                kind="wrong_hours",
                comment="Emergency line rang out twice at 02:40 during a cardiac call.",
                created_at=now - timedelta(hours=31),
            ),
        ]
    )

    db.commit()

    if seeded_keys:
        # Printed, not stored. A one-time secret that is written to a file or a
        # row in the clear is not a one-time secret; the pilot needs to see it
        # exactly once, at setup, and can rotate from the connector page after.
        log.warning(
            "seeded connector keys (dev only, rotate before any real use): %s",
            ", ".join(f"{short}={key}" for short, key in seeded_keys.items()),
        )

    return {
        "seeded": True,
        "districts": len(district_by_code),
        "hospitals": len(hospitals),
        "doctors": len(doctor_rows),
        "capacity_records": len(records),
        "ambulances": len(fleet),
        "incidents": len(incidents),
        "connectors": len(seeded_keys),
        "connector_keys": seeded_keys,
    }
