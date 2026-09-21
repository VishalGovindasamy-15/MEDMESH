"""Tamil Nadu coverage: all 38 districts, and the wider facility estate.

What is real and what is not
----------------------------

This matters more than the data itself, because a pilot dataset that blurs the
line between measured and invented is worse than no dataset.

**Real.** The 38 district names, their Tamil names, their headquarters
coordinates (to about four decimal places, enough to place a pin on the right
town) and their populations are published Census 2011 figures. Tamil Nadu has had
38 districts since 2019, when Kallakurichi, Ranipet, Tirupathur, Tenkasi and
Chengalpattu were carved out of Viluppuram, Vellore, Vellore, Tirunelveli and
Kanchipuram respectively -- a fact worth encoding correctly, because a capacity
exchange that cannot find Chengalpattu is not usable in the state it is built for.

**Not real.** Every facility is synthetic. Bed counts, ICU counts, ventilator
counts, capabilities and rosters are plausible pilot values, not returns from any
hospital. Facility names follow the conventions that Tamil Nadu actually uses --
"Government Medical College Hospital, <district>" for the public teaching
hospitals, "District Headquarters Hospital" for the district hospital,
"<river or town> <speciality> Hospital" for the private sector -- so the shape of
the estate is right even though the estate is invented.

The distinction is the point. Coordinates and district identity have to be true
for the platform to plan against real geography -- and now that the matching
engine scores on road distance, a district in the wrong place produces a
confidently wrong ranking. Capacity has to be *labelled* synthetic, because
nobody has published it and pretending otherwise is how a demo becomes a lie.

Coverage shape
--------------

Every district gets at least four facilities, and the mix is deliberately not
uniform: every district has public provision (the district hospital and a
taluk/block hospital), most have a private multi-speciality, and the largest have
a teaching hospital with the tertiary capabilities -- cath lab, trauma centre,
neonatal ICU -- that a 108 call actually needs. A uniform grid of identical
hospitals would make the matching engine's job trivially easy and therefore
prove nothing about it.

The estate is weighted the way Tamil Nadu is: the western belt (Coimbatore,
Tiruppur, Erode, Salem) and the Chennai metropolitan districts carry far more
capacity than the sparsely populated interior (Perambalur, Ariyalur, Nilgiris).
"""

from __future__ import annotations

# --------------------------------------------------------------------------- #
# Districts — real names, real headquarters, real populations (Census 2011)
# --------------------------------------------------------------------------- #

# (code, name, Tamil name, headquarters lat, headquarters lng, population 2011)
TN_DISTRICTS: list[tuple[str, str, str, float, float, int]] = [
    # -- Kongu Nadu (west) ---------------------------------------------------
    ("CBE", "Coimbatore", "கோயம்புத்தூர்", 11.0168, 76.9558, 3_458_045),
    ("TUP", "Tiruppur", "திருப்பூர்", 11.1085, 77.3411, 2_479_052),
    ("ERD", "Erode", "ஈரோடு", 11.3410, 77.7172, 2_251_744),
    ("SLM", "Salem", "சேலம்", 11.6643, 78.1460, 3_482_056),
    ("NIL", "Nilgiris", "நீலகிரி", 11.4102, 76.6950, 735_394),
    ("NAM", "Namakkal", "நாமக்கல்", 11.2189, 78.1677, 1_726_601),
    ("KRR", "Karur", "கரூர்", 10.9601, 78.0766, 1_064_493),
    ("DGL", "Dindigul", "திண்டுக்கல்", 10.3673, 77.9803, 2_159_775),
    # -- Chennai metropolitan ------------------------------------------------
    ("CHN", "Chennai", "சென்னை", 13.0827, 80.2707, 4_646_732),
    ("TRL", "Tiruvallur", "திருவள்ளூர்", 13.1231, 79.9110, 3_728_104),
    ("CGP", "Chengalpattu", "செங்கல்பட்டு", 12.6819, 79.9888, 2_556_423),
    ("KPM", "Kanchipuram", "காஞ்சிபுரம்", 12.8342, 79.7036, 1_166_401),
    ("RPT", "Ranipet", "இராணிப்பேட்டை", 12.9249, 79.3300, 1_210_277),
    # -- Northern districts --------------------------------------------------
    ("VEL", "Vellore", "வேலூர்", 12.9165, 79.1325, 1_614_242),
    ("TPT", "Tirupathur", "திருப்பத்தூர்", 12.4954, 78.5678, 1_111_812),
    ("TNM", "Tiruvannamalai", "திருவண்ணாமலை", 12.2253, 79.0747, 2_464_875),
    ("VPM", "Viluppuram", "விழுப்புரம்", 11.9401, 79.4861, 2_093_003),
    ("KLK", "Kallakurichi", "கள்ளக்குறிச்சி", 11.7384, 78.9606, 1_370_281),
    ("DHP", "Dharmapuri", "தர்மபுரி", 12.1211, 78.1583, 1_506_843),
    ("KGI", "Krishnagiri", "கிருஷ்ணகிரி", 12.5186, 78.2137, 1_879_809),
    # -- Cauvery delta -------------------------------------------------------
    ("TJN", "Thanjavur", "தஞ்சாவூர்", 10.7870, 79.1378, 2_405_890),
    ("TVR", "Tiruvarur", "திருவாரூர்", 10.7724, 79.6368, 1_264_277),
    ("NGP", "Nagapattinam", "நாகப்பட்டினம்", 10.7660, 79.8420, 1_616_450),
    ("MYD", "Mayiladuthurai", "மயிலாடுதுறை", 11.1018, 79.6529, 918_356),
    ("CDL", "Cuddalore", "கடலூர்", 11.7480, 79.7714, 2_605_914),
    ("ARL", "Ariyalur", "அரியலூர்", 11.1401, 79.0786, 754_894),
    ("PBL", "Perambalur", "பெரம்பலூர்", 11.2342, 78.8800, 565_223),
    # -- Central -------------------------------------------------------------
    ("TRY", "Tiruchirappalli", "திருச்சிராப்பள்ளி", 10.7905, 78.7047, 2_722_290),
    ("PDK", "Pudukkottai", "புதுக்கோட்டை", 10.3833, 78.8001, 1_618_345),
    # -- Southern ------------------------------------------------------------
    ("MDU", "Madurai", "மதுரை", 9.9252, 78.1198, 3_038_252),
    ("TEN", "Tenkasi", "தென்காசி", 8.9600, 77.3152, 1_407_627),
    ("TNV", "Tirunelveli", "திருநெல்வேலி", 8.7139, 77.7567, 3_077_233),
    ("THO", "Thoothukudi", "தூத்துக்குடி", 8.7642, 78.1348, 1_750_176),
    ("VNR", "Virudhunagar", "விருதுநகர்", 9.5680, 77.9624, 1_942_288),
    ("RMD", "Ramanathapuram", "இராமநாதபுரம்", 9.3639, 78.8395, 1_353_445),
    ("SVG", "Sivaganga", "சிவகங்கை", 9.8433, 78.4809, 1_339_101),
    ("THE", "Theni", "தேனி", 10.0104, 77.4768, 1_245_899),
    ("KKM", "Kanyakumari", "கன்னியாகுமரி", 8.1833, 77.4119, 1_870_374),
]

# Specialty keys must match SPECIALTY_POOL in seed.py -- the directory filters and
# the doctor roster both read from that vocabulary, and a near-miss ("cardiothoracic"
# for "critical_care") silently produces a hospital with no matching speciality.
_GEN = ["general_medicine", "general_surgery", "orthopaedics", "paediatrics", "obstetrics", "gynaecology"]
_MED = _GEN + ["critical_care", "pulmonology", "gastroenterology"]
_TER = _MED + ["cardiology", "neurology", "nephrology", "urology", "trauma"]
_FULL = _TER + ["neurosurgery", "oncology", "burns", "plastic_surgery", "psychiatry"]

# (short, name, kind, district, beds, icu, vents, integration, specialties, capabilities,
#  lat offset, lng offset)  -- offsets are degrees from the district headquarters
TN_FACILITIES: list[tuple] = [
    # ---------------------------------------------------------------- Namakkal
    ("NMKH", "Namakkal Government Medical College Hospital", "public", "NAM", 720, 62, 34, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.005, -0.007),
    ("RSPH", "Rasipuram Government Hospital", "public", "NAM", 180, 14, 6, "manual",
     _GEN + ["critical_care"], {"blood_bank"}, 0.262, 0.091),
    ("SKCH", "Sakthi Medical Centre, Namakkal", "private", "NAM", 150, 20, 12, "api",
     _MED + ["cardiology"], {"blood_bank", "cath_lab"}, -0.018, 0.013),
    ("VLRH", "Vallalar Orthopaedic & Trauma Hospital", "trust", "NAM", 88, 10, 5, "manual",
     ["orthopaedics", "general_surgery", "trauma"], {"trauma_centre"}, 0.021, 0.028),

    # ---------------------------------------------------------------- Nilgiris
    ("OTYG", "Ooty Government Medical College Hospital", "public", "NIL", 460, 38, 20, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.006, 0.005),
    ("GDLA", "Gudalur Government Hospital", "public", "NIL", 130, 11, 5, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.128, 0.028),
    ("KTGR", "Kotagiri Taluk Hospital", "public", "NIL", 84, 7, 3, "manual",
     _GEN, set(), 0.014, 0.204),

    # -------------------------------------------------------------------- Karur
    ("KRGH", "Karur Government Headquarters Hospital", "public", "KRR", 480, 36, 18, "api",
     _MED + ["trauma"], {"blood_bank", "trauma_centre"}, 0.003, 0.005),
    ("AMRH", "Amaravathi Mission Hospital, Karur", "trust", "KRR", 165, 18, 10, "api",
     _MED + ["nephrology"], {"blood_bank", "dialysis"}, -0.015, -0.011),
    ("KNCH", "Kongu Nursing Home & Critical Care", "private", "KRR", 96, 22, 14, "api",
     ["critical_care", "general_medicine", "pulmonology", "cardiology"], {"blood_bank"}, 0.014, 0.019),
    ("KULB", "Kulithalai Block Hospital", "public", "KRR", 64, 6, 3, "manual",
     _GEN, set(), -0.168, 0.104),

    # ---------------------------------------------------------------- Dindigul
    ("DDGH", "Dindigul Government Medical College Hospital", "public", "DGL", 760, 64, 36, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.006),
    ("PLNI", "Palani Government Hospital", "public", "DGL", 220, 18, 9, "api",
     _GEN + ["orthopaedics", "trauma"], {"blood_bank"}, -0.348, -0.161),
    ("CBTH", "Cumbum Valley Speciality Hospital", "private", "DGL", 190, 24, 14, "api",
     _MED + ["cardiology", "urology"], {"blood_bank", "cath_lab"}, -0.198, -0.253),
    ("KDKH", "Kodaikanal Hill Hospital", "trust", "DGL", 62, 6, 3, "manual",
     ["general_medicine", "paediatrics", "obstetrics"], set(), 0.037, -0.537),

    # ----------------------------------------------------------------- Chennai
    ("MCMH", "Madras Metropolitan Medical College Hospital", "public", "CHN", 1620, 168, 104, "api",
     _FULL + ["paediatrics", "critical_care"], 
     {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "burn_unit", "dialysis"}, 0.006, 0.005),
    ("SPGH", "Stanley Port Government Hospital", "public", "CHN", 1180, 122, 76, "api",
     _FULL, {"blood_bank", "trauma_centre", "cath_lab", "burn_unit"}, -0.043, 0.031),
    ("ROYH", "Royapettah Speciality Hospital", "private", "CHN", 340, 58, 38, "api",
     _FULL + ["cardiology"], {"blood_bank", "cath_lab", "neonatal_icu"}, 0.011, -0.008),
    ("ADYR", "Adyar Coastal Multispeciality", "private", "CHN", 260, 44, 26, "api",
     _TER + ["oncology"], {"blood_bank", "cath_lab"}, -0.142, 0.041),
    ("PMBR", "Perambur Railway Hospital", "trust", "CHN", 180, 22, 12, "manual",
     _MED + ["orthopaedics"], {"blood_bank"}, 0.108, -0.036),
    ("TNDC", "Thiruvanmiyur Community Health Centre", "public", "CHN", 72, 8, 4, "manual",
     _GEN, set(), -0.196, 0.018),

    # --------------------------------------------------------------- Tiruvallur
    ("TVGH", "Tiruvallur Government Medical College Hospital", "public", "TRL", 880, 74, 44, "api",
     _TER, {"blood_bank", "trauma_centre", "cath_lab", "dialysis"}, 0.004, -0.006),
    ("AVDH", "Avadi Cantonment Hospital", "public", "TRL", 320, 28, 16, "api",
     _MED + ["orthopaedics", "trauma"], {"blood_bank", "trauma_centre"}, 0.162, -0.155),
    ("PONH", "Ponneri Industrial Belt Hospital", "private", "TRL", 140, 18, 10, "manual",
     _MED, {"blood_bank"}, 0.128, 0.264),
    ("TIRV", "Tiruttani Taluk Hospital", "public", "TRL", 96, 8, 4, "manual",
     _GEN, set(), -0.083, -0.317),

    # ------------------------------------------------------------- Chengalpattu
    ("CGGH", "Chengalpattu Government Medical College Hospital", "public", "CGP", 980, 88, 52, "api",
     _FULL, {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "dialysis"}, 0.005, 0.007),
    ("TAMB", "Tambaram Referral Hospital", "public", "CGP", 420, 40, 22, "api",
     _MED + ["cardiology", "orthopaedics"], {"blood_bank", "cath_lab"}, 0.118, -0.098),
    ("MHLG", "Mahindra World City Medical Centre", "private", "CGP", 210, 26, 15, "api",
     _MED + ["nephrology"], {"blood_bank", "dialysis"}, 0.072, -0.190),
    ("MADC", "Madurantakam Block Hospital", "public", "CGP", 84, 7, 3, "manual",
     _GEN, set(), -0.138, -0.087),

    # -------------------------------------------------------------- Kanchipuram
    ("KMGH", "Kanchipuram Government Hospital", "public", "KPM", 560, 44, 24, "api",
     _MED + ["cardiology", "trauma"], {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.005),
    ("SRIP", "Sriperumbudur Corridor Hospital", "private", "KPM", 200, 24, 14, "api",
     _MED + ["orthopaedics"], {"blood_bank"}, 0.108, 0.039),
    ("WALJ", "Walajabad Taluk Hospital", "public", "KPM", 78, 6, 3, "manual",
     _GEN, set(), -0.122, -0.031),

    # ------------------------------------------------------------------ Ranipet
    ("RNGH", "Ranipet Government Medical College Hospital", "public", "RPT", 700, 58, 32, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.006, -0.005),
    ("ARCT", "Arcot Government Hospital", "public", "RPT", 190, 16, 8, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.132, -0.028),
    ("BHLR", "Bharathi Leather Belt Hospital, Ranipet", "trust", "RPT", 120, 12, 6, "manual",
     _MED, set(), 0.024, 0.019),

    # ------------------------------------------------------------------ Vellore
    ("VLRM", "Vellore Medical College Hospital", "public", "VEL", 940, 82, 48, "api",
     _FULL, {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "dialysis"}, 0.005, 0.004),
    ("BRNH", "Bagayam Rural Mission Hospital", "trust", "VEL", 260, 30, 18, "api",
     _MED + ["nephrology", "trauma"], {"blood_bank", "dialysis"}, -0.038, -0.021),
    ("KATP", "Katpadi Junction Hospital", "private", "VEL", 150, 20, 12, "api",
     _MED + ["orthopaedics"], {"blood_bank"}, 0.028, 0.031),
    ("ARAK", "Arakkonam Government Hospital", "public", "VEL", 210, 18, 9, "manual",
     _GEN + ["trauma"], {"blood_bank"}, 0.202, 0.183),

    # --------------------------------------------------------------- Tirupathur
    ("TPTH", "Tirupathur Government Medical College Hospital", "public", "TPT", 640, 52, 28, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.006),
    ("VANI", "Vaniyambadi Government Hospital", "public", "TPT", 190, 15, 7, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.136, 0.108),
    ("AMBR", "Ambur Leather City Hospital", "private", "TPT", 130, 14, 8, "manual",
     _MED, {"blood_bank"}, -0.108, 0.141),

    # ------------------------------------------------------------ Tiruvannamalai
    ("TVMG", "Tiruvannamalai Government Medical College Hospital", "public", "TNM", 820, 68, 38, "api",
     _TER, {"blood_bank", "trauma_centre", "cath_lab", "dialysis"}, 0.005, -0.005),
    ("ARUN", "Arunachala Temple Town Hospital", "trust", "TNM", 170, 16, 9, "api",
     _MED + ["orthopaedics"], {"blood_bank"}, 0.011, 0.013),
    ("CHET", "Chengam Block Hospital", "public", "TNM", 88, 7, 3, "manual",
     _GEN, set(), 0.072, -0.212),

    # --------------------------------------------------------------- Viluppuram
    ("VPMG", "Viluppuram Government Medical College Hospital", "public", "VPM", 860, 72, 42, "api",
     _TER, {"blood_bank", "trauma_centre", "cath_lab", "dialysis"}, 0.004, 0.005),
    ("TIND", "Tindivanam Government Hospital", "public", "VPM", 200, 16, 8, "manual",
     _GEN + ["orthopaedics", "trauma"], {"blood_bank"}, 0.028, 0.216),
    ("GING", "Gingee Rural Hospital", "public", "VPM", 92, 8, 4, "manual",
     _GEN, set(), -0.113, -0.104),
    ("VIKR", "Vikravandi Highway Trauma Centre", "private", "VPM", 140, 20, 12, "api",
     ["trauma", "orthopaedics", "critical_care", "general_surgery"], {"trauma_centre", "blood_bank"}, 0.079, 0.071),

    # ------------------------------------------------------------- Kallakurichi
    ("KKRG", "Kallakurichi Government Medical College Hospital", "public", "KLK", 620, 50, 26, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.005, 0.004),
    ("SNKR", "Sankarapuram Block Hospital", "public", "KLK", 96, 8, 4, "manual",
     _GEN, set(), -0.098, -0.214),
    ("ULND", "Ulundurpet Highway Hospital", "private", "KLK", 124, 14, 8, "manual",
     _MED, {"blood_bank"}, 0.061, 0.152),

    # --------------------------------------------------------------- Dharmapuri
    ("DHMG", "Dharmapuri Government Medical College Hospital", "public", "DHP", 720, 56, 30, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, -0.006),
    ("HRRR", "Hogenakkal Falls Emergency Hospital", "public", "DHP", 88, 8, 4, "manual",
     _GEN + ["trauma"], set(), -0.161, -0.284),
    ("PLCT", "Palacode Taluk Hospital", "public", "DHP", 76, 6, 3, "manual",
     _GEN, set(), 0.098, 0.089),
    ("DHPR", "Dharmapuri Speciality Centre", "private", "DHP", 130, 16, 9, "api",
     _MED + ["cardiology"], {"blood_bank"}, -0.021, 0.024),

    # --------------------------------------------------------------- Krishnagiri
    ("KRMG", "Krishnagiri Government Medical College Hospital", "public", "KGI", 780, 62, 34, "api",
     _TER, {"blood_bank", "trauma_centre", "cath_lab", "dialysis"}, 0.005, 0.005),
    ("HOSR", "Hosur Industrial Hospital", "private", "KGI", 240, 32, 20, "api",
     _TER + ["orthopaedics"], {"blood_bank", "trauma_centre", "cath_lab"}, -0.190, -0.108),
    ("BRGP", "Bargur Hill Hospital", "public", "KGI", 84, 7, 3, "manual",
     _GEN, set(), 0.098, 0.152),
    ("DENK", "Denkanikottai Taluk Hospital", "public", "KGI", 72, 6, 3, "manual",
     _GEN, set(), -0.278, -0.101),

    # ----------------------------------------------------------------- Thanjavur
    ("TJMG", "Thanjavur Government Medical College Hospital", "public", "TJN", 980, 80, 46, "api",
     _FULL, {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "dialysis"}, 0.005, 0.006),
    ("KUMB", "Kumbakonam Government Hospital", "public", "TJN", 260, 22, 11, "api",
     _MED + ["trauma"], {"blood_bank"}, 0.096, 0.197),
    ("DHRC", "Dharasuram Cardiac Centre", "private", "TJN", 180, 34, 22, "api",
     ["cardiology", "critical_care", "general_medicine", "pulmonology"], {"blood_bank", "cath_lab"}, 0.061, 0.152),
    ("PTTK", "Pattukkottai Taluk Hospital", "public", "TJN", 110, 9, 4, "manual",
     _GEN, set(), -0.188, 0.131),

    # ------------------------------------------------------------------ Tiruvarur
    ("TVRG", "Tiruvarur Government Medical College Hospital", "public", "TVR", 640, 52, 28, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.005, -0.004),
    ("MNNR", "Mannargudi Government Hospital", "public", "TVR", 150, 12, 6, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.188, 0.079),
    ("NNTM", "Nannilam Rural Hospital", "public", "TVR", 68, 5, 2, "manual",
     _GEN, set(), 0.021, 0.138),

    # -------------------------------------------------------------- Nagapattinam
    ("NGMG", "Nagapattinam Government Medical College Hospital", "public", "NGP", 680, 54, 30, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.005),
    ("VELN", "Velankanni Coastal Hospital", "trust", "NGP", 120, 12, 6, "manual",
     _GEN + ["orthopaedics", "trauma"], {"blood_bank"}, -0.161, 0.077),
    ("SIRK", "Sirkazhi Coastal Block Hospital", "public", "NGP", 78, 6, 3, "manual",
     _GEN, set(), 0.098, -0.061),
    ("MAYR", "Mayiladuthurai Referral Hospital", "public", "MYD", 280, 24, 12, "api",
     _MED + ["cardiology"], {"blood_bank"}, 0.004, 0.005),
    ("SRKT", "Sirkazhi Taluk Hospital", "public", "MYD", 86, 7, 3, "manual",
     _GEN, set(), 0.063, 0.116),
    ("KUTH", "Kuthalam Block Hospital", "public", "MYD", 72, 6, 3, "manual",
     _GEN, set(), -0.079, 0.031),

    # ------------------------------------------------------------------ Cuddalore
    ("CDMG", "Cuddalore Government Medical College Hospital", "public", "CDL", 860, 70, 40, "api",
     _TER, {"blood_bank", "trauma_centre", "cath_lab", "dialysis"}, 0.005, 0.005),
    ("CHDM", "Chidambaram Government Hospital", "public", "CDL", 240, 20, 10, "api",
     _MED + ["orthopaedics"], {"blood_bank"}, -0.079, 0.113),
    ("PRTB", "Portonovo Industrial Hospital", "private", "CDL", 140, 16, 9, "manual",
     _MED, {"blood_bank"}, 0.098, -0.021),
    ("VRDH", "Vridhachalam Taluk Hospital", "public", "CDL", 104, 8, 4, "manual",
     _GEN, set(), -0.271, -0.123),

    # ------------------------------------------------------------------ Ariyalur
    ("ARLG", "Ariyalur Government Medical College Hospital", "public", "ARL", 520, 42, 22, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.006),
    ("JAYN", "Jayankondam Government Hospital", "public", "ARL", 130, 11, 5, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.079, 0.190),
    ("SEND", "Sendurai Block Hospital", "public", "ARL", 64, 5, 2, "manual",
     _GEN, set(), 0.098, -0.113),

    # --------------------------------------------------------------- Perambalur
    ("PBHG", "Perambalur Government Medical College Hospital", "public", "PBL", 560, 46, 24, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.005, 0.004),
    ("KUNA", "Kunnam Taluk Hospital", "public", "PBL", 82, 6, 3, "manual",
     _GEN, set(), -0.061, -0.098),
    ("VEPP", "Veppanthattai Rural Hospital", "public", "PBL", 66, 5, 2, "manual",
     _GEN, set(), 0.098, 0.072),

    # ------------------------------------------------------------ Tiruchirappalli
    ("TRMG", "Tiruchirappalli Government Medical College Hospital", "public", "TRY", 1140, 106, 62, "api",
     _FULL + ["paediatrics", "critical_care"],
     {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "burn_unit", "dialysis"}, 0.005, 0.005),
    ("SRNG", "Srirangam Temple Town Hospital", "trust", "TRY", 220, 22, 12, "api",
     _MED + ["cardiology"], {"blood_bank", "cath_lab"}, 0.036, 0.024),
    ("GOLD", "Golden Rock Railway Hospital", "trust", "TRY", 260, 30, 18, "api",
     _MED + ["orthopaedics", "trauma"], {"blood_bank", "trauma_centre"}, -0.015, 0.052),
    ("MANP", "Manapparai Taluk Hospital", "public", "TRY", 140, 11, 5, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.104, -0.198),
    ("THUV", "Thuvakudi Industrial Health Centre", "private", "TRY", 96, 10, 5, "manual",
     _MED, set(), 0.028, 0.136),

    # ---------------------------------------------------------------- Pudukkottai
    ("PDMG", "Pudukkottai Government Medical College Hospital", "public", "PDK", 700, 56, 30, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.005),
    ("ARNT", "Aranthangi Government Hospital", "public", "PDK", 150, 12, 6, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.108, 0.198),
    ("KARA", "Karaikudi Speciality Hospital", "private", "PDK", 190, 24, 14, "api",
     _MED + ["cardiology", "nephrology"], {"blood_bank", "cath_lab", "dialysis"}, 0.079, -0.113),

    # ------------------------------------------------------------------- Tenkasi
    ("TKMG", "Tenkasi Government Medical College Hospital", "public", "TEN", 580, 48, 26, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.005),
    ("SNKT", "Shenkottai Ghat Road Hospital", "public", "TEN", 130, 12, 6, "manual",
     ["general_medicine", "general_surgery", "orthopaedics", "trauma"], {"blood_bank", "trauma_centre"}, 0.088, -0.148),
    ("CRTR", "Courtallam Falls Emergency Centre", "trust", "TEN", 74, 7, 3, "manual",
     _GEN, set(), -0.043, -0.098),

    # ---------------------------------------------------------------- Tirunelveli
    ("TNMG", "Tirunelveli Government Medical College Hospital", "public", "TNV", 1080, 96, 56, "api",
     _FULL + ["paediatrics"],
     {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "burn_unit", "dialysis"}, 0.005, 0.005),
    ("PLYM", "Palayamkottai Mission Hospital", "trust", "TNV", 320, 36, 22, "api",
     _TER, {"blood_bank", "cath_lab", "dialysis"}, 0.011, 0.008),
    ("AMBS", "Ambasamudram Government Hospital", "public", "TNV", 170, 14, 7, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.118, -0.079),
    ("VKRH", "Valliyoor Highway Hospital", "private", "TNV", 128, 14, 8, "manual",
     _MED, {"blood_bank"}, 0.072, 0.108),

    # ---------------------------------------------------------------- Thoothukudi
    ("THMG", "Thoothukudi Government Medical College Hospital", "public", "THO", 820, 66, 36, "api",
     _TER, {"blood_bank", "trauma_centre", "cath_lab", "dialysis"}, 0.005, 0.005),
    ("TUTI", "Tuticorin Port Trust Hospital", "trust", "THO", 200, 22, 12, "api",
     _MED + ["trauma", "orthopaedics"], {"blood_bank", "trauma_centre"}, 0.021, 0.031),
    ("KOVL", "Kovilpatti Match Belt Hospital", "private", "THO", 160, 18, 10, "manual",
     _MED + ["orthopaedics"], {"blood_bank"}, -0.088, 0.108),
    ("TIRU", "Tiruchendur Coastal Hospital", "public", "THO", 96, 8, 4, "manual",
     _GEN + ["trauma"], set(), -0.198, 0.098),

    # --------------------------------------------------------------- Virudhunagar
    ("VRMG", "Virudhunagar Government Medical College Hospital", "public", "VNR", 760, 62, 34, "api",
     _TER, {"blood_bank", "trauma_centre", "cath_lab", "dialysis"}, 0.005, 0.005),
    ("SIVK", "Sivakasi Fireworks Belt Hospital", "private", "VNR", 220, 30, 20, "api",
     ["burns", "trauma", "orthopaedics", "critical_care", "general_surgery"],
     {"burn_unit", "trauma_centre", "blood_bank"}, -0.098, -0.213),
    ("RAJY", "Rajapalayam Government Hospital", "public", "VNR", 180, 15, 7, "api",
     _GEN + ["orthopaedics", "trauma"], {"blood_bank"}, -0.428, -0.129),
    ("ARUP", "Aruppukottai Taluk Hospital", "public", "VNR", 110, 9, 4, "manual",
     _GEN, set(), 0.098, 0.042),

    # ------------------------------------------------------------- Ramanathapuram
    ("RMMG", "Ramanathapuram Government Medical College Hospital", "public", "RMD", 660, 54, 30, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.005, 0.005),
    ("RAMN", "Rameswaram Island Hospital", "public", "RMD", 120, 10, 5, "manual",
     _GEN + ["trauma"], {"blood_bank"}, -0.061, 0.451),
    ("PARM", "Paramakudi Government Hospital", "public", "RMD", 140, 12, 6, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.108, -0.198),
    ("KLRB", "Kilakarai Coastal Health Centre", "trust", "RMD", 78, 7, 3, "manual",
     _GEN, set(), -0.148, -0.021),

    # ------------------------------------------------------------------ Sivaganga
    ("SVGH", "Sivaganga Government Medical College Hospital", "public", "SVG", 620, 50, 27, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.004, 0.005),
    ("KARB", "Karaikudi Government Hospital", "public", "SVG", 190, 16, 8, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.013, 0.024),
    ("MANM", "Manamadurai Block Hospital", "public", "SVG", 88, 7, 3, "manual",
     _GEN, set(), -0.108, -0.079),
    ("DEVA", "Devakottai Taluk Hospital", "public", "SVG", 96, 8, 4, "manual",
     _GEN, set(), -0.028, 0.152),

    # --------------------------------------------------------------------- Theni
    ("TNHG", "Theni Government Medical College Hospital", "public", "THE", 640, 52, 28, "api",
     _TER, {"blood_bank", "trauma_centre", "dialysis"}, 0.005, 0.004),
    ("BODI", "Bodinayakanur Hill Hospital", "public", "THE", 140, 13, 6, "manual",
     _GEN + ["orthopaedics"], {"blood_bank"}, -0.048, 0.028),
    ("PERI", "Periyakulam Government Hospital", "public", "THE", 120, 10, 5, "manual",
     _GEN + ["trauma"], {"blood_bank"}, 0.062, -0.024),
    ("KAMB", "Kambam Valley Estate Hospital", "trust", "THE", 86, 8, 4, "manual",
     ["general_medicine", "general_surgery", "orthopaedics", "obstetrics"], set(), -0.158, -0.038),

    # --------------------------------------------------------------- Kanyakumari
    ("KKMG", "Kanyakumari Government Medical College Hospital", "public", "KKM", 900, 78, 44, "api",
     _FULL, {"blood_bank", "trauma_centre", "cath_lab", "neonatal_icu", "dialysis"}, 0.004, 0.005),
    ("NGRC", "Nagercoil Town Hospital", "private", "KKM", 240, 30, 18, "api",
     _TER, {"blood_bank", "cath_lab"}, -0.008, -0.061),
    ("MARP", "Marthandam Coastal Hospital", "trust", "KKM", 160, 16, 9, "manual",
     _MED + ["trauma"], {"blood_bank"}, 0.098, -0.021),
    ("KULK", "Kulasekaram Taluk Hospital", "public", "KKM", 92, 8, 4, "manual",
     _GEN, set(), 0.061, 0.108),
    ("PADM", "Padmanabhapuram Heritage Hospital", "trust", "KKM", 110, 10, 5, "manual",
     _GEN + ["paediatrics"], set(), 0.028, 0.042),
]
