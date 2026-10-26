# MedMesh — Real-Time Healthcare Capacity Exchange

> **A zero-PHI, real-time healthcare capacity and emergency dispatch exchange engine.**  
> Built with a high-performance **Python (FastAPI)** backend and a unified **React Native (Expo)** frontend serving Web, PWA, Android, and iOS from a single codebase.

---

## Visual Showcase — Desktop & Mobile Views

| Surface | Desktop View (Web / Console) | Mobile View (PWA / Handset) |
|:---|:---|:---|
| **Public Capacity Directory & Map**<br>*(Live beds, ICU status, trust indicator, bilingual EN/TA)* | <img src="docs/shots/directory-desktop.png" width="550" alt="Directory Desktop"/> | <img src="docs/shots/directory-phone.png" width="220" alt="Directory Mobile"/> |
| **Hospital Facility Detail**<br>*(Capacity breakdown, trust score deltas, on-duty specialists)* | <img src="docs/shots/facility-desktop.png" width="550" alt="Facility Detail Desktop"/> | <img src="docs/shots/facility-phone.png" width="220" alt="Facility Detail Mobile"/> |
| **108 Emergency Dispatch Console**<br>*(Live call intake, incident queue, real-time fleet map)* | <img src="docs/shots/console-desktop.png" width="550" alt="108 Console Desktop"/> | <img src="docs/shots/console-phone.png" width="220" alt="108 Console Mobile"/> |
| **Incident Workspace & Ranked Shortlist**<br>*(6-factor capability matching, bed holds, ambulance picker)* | <img src="docs/shots/case-desktop.png" width="550" alt="Incident Shortlist Desktop"/> | <img src="docs/shots/case-phone.png" width="220" alt="Incident Shortlist Mobile"/> |
| **Ambulance Crew Navigation & Trip Lifecycle**<br>*(Turn-by-turn routing, one-tap stage progression, handover)* | <img src="docs/shots/crew-desktop.png" width="550" alt="Crew Dashboard Desktop"/> | <img src="docs/shots/crew-phone.png" width="220" alt="Crew Dashboard Mobile"/> |
| **Hospital Bed Control Portal**<br>*(Inbound ambulance alerts, quick-adjust capacity keypad)* | <img src="docs/shots/dashboard-desktop.png" width="550" alt="Hospital Portal Desktop"/> | <img src="docs/shots/dashboard-phone.png" width="220" alt="Hospital Portal Mobile"/> |
| **Specialist Doctor Roster**<br>*(Departmental cover, active on-duty clinicians)* | <img src="docs/shots/doctors-desktop.png" width="550" alt="Doctors Directory Desktop"/> | <img src="docs/shots/doctors-phone.png" width="220" alt="Doctors Directory Mobile"/> |
| **Government Health Analytics**<br>*(District capacity rollups, surge control, SLA monitoring)* | <img src="docs/shots/analytics-desktop.png" width="550" alt="Analytics Desktop"/> | <img src="docs/shots/analytics-phone.png" width="220" alt="Analytics Mobile"/> |
| **District Detail & Trend Drilldown**<br>*(Per-facility occupancy trends and historical logs)* | <img src="docs/shots/analytics-district-desktop.png" width="550" alt="District Drilldown Desktop"/> | <img src="docs/shots/analytics-district-phone.png" width="220" alt="District Drilldown Mobile"/> |
| **Platform Administration & Fleet Operations**<br>*(Vehicle registration, driver assignment, audit trail)* | <img src="docs/shots/admin-desktop.png" width="550" alt="Admin Portal Desktop"/> | <img src="docs/shots/admin-phone.png" width="220" alt="Admin Portal Mobile"/> |
| **Role-Scoped Notification Inbox**<br>*(Inbound ambulance alerts, hold expirations, handoffs)* | <img src="docs/shots/inbox-dispatcher-desktop.png" width="550" alt="Inbox Desktop"/> | <img src="docs/shots/inbox-dispatcher-phone.png" width="220" alt="Inbox Mobile"/> |
| **Staff Authentication & Pilot Accounts**<br>*(Role-scoped sign-in and one-tap test credentials)* | <img src="docs/shots/signin-desktop.png" width="550" alt="Sign In Desktop"/> | <img src="docs/shots/signin-phone.png" width="220" alt="Sign In Mobile"/> |

---

## Table of Contents

1. [Visual Showcase — Desktop & Mobile Views](#visual-showcase--desktop--mobile-views)
2. [Executive Summary & Core Philosophy](#2-executive-summary--core-philosophy)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Technology Stack](#4-technology-stack)
5. [Core Engines & Business Logic](#5-core-engines--business-logic)
   - [5.1 Data Quality & Trust Engine](#51-data-quality--trust-engine)
   - [5.2 Capability-First Matching & Routing Engine](#52-capability-first-matching--routing-engine)
   - [5.3 Bed Reservation & Critical Section Engine](#53-bed-reservation--critical-section-engine)
   - [5.4 Zero-PHI Structural Triage](#54-zero-phi-structural-triage)
   - [5.5 Mass Casualty Incident (MCI) Protocol](#55-mass-casualty-incident-mci-protocol)
   - [5.6 Ambulance State Machine & Escalation Ladder](#56-ambulance-state-machine--escalation-ladder)
   - [5.7 Doctor Roster & Specialty Cover Service](#57-doctor-roster--specialty-cover-service)
6. [User Roles & Complete End-to-End User Flows](#6-user-roles--complete-end-to-end-user-flows)
   - [Role Matrix](#role-matrix)
   - [Flow 1: Citizen / Public User Journey](#flow-1-citizen--public-user-journey)
   - [Flow 2: 108 Emergency Dispatcher Workflow (Single Incident)](#flow-2-108-emergency-dispatcher-workflow-single-incident)
   - [Flow 3: 108 Emergency Dispatcher Workflow (Mass Casualty Incident - MCI)](#flow-3-108-emergency-dispatcher-workflow-mass-casualty-incident---mci)
   - [Flow 4: Ambulance Crew / Paramedic Mobile Journey](#flow-4-ambulance-crew--paramedic-mobile-journey)
   - [Flow 5: Hospital Bed Control & Emergency Ward Workflow](#flow-5-hospital-bed-control--emergency-ward-workflow)
   - [Flow 6: District Health Official Analytics & Surge Control](#flow-6-district-health-official-analytics--surge-control)
   - [Flow 7: Platform Operations & Administration](#flow-7-platform-operations--administration)
7. [Multi-Platform Delivery: Web, PWA & Native Mobile](#7-multi-platform-delivery-web-pwa--native-mobile)
   - [Responsive Web & Desktop Console](#responsive-web--desktop-console)
   - [Progressive Web App (PWA)](#progressive-web-app-pwa)
   - [Native Android & iOS Apps](#native-android--ios-apps)
   - [Maps & Geospatial Hybrid Architecture](#maps--geospatial-hybrid-architecture)
8. [Getting Started & Running the Project](#8-getting-started--running-the-project)
   - [Prerequisites](#prerequisites)
   - [Option A: Standard Local Development (Frontend + Backend)](#option-a-standard-local-development-frontend--backend)
   - [Option B: One-Command All-In-One Preview Server](#option-b-one-command-all-in-one-preview-server)
   - [Option C: Running on Android / iOS (Simulators & Physical Devices)](#option-c-running-on-android--ios-simulators--physical-devices)
   - [Option D: Building the Production Android APK / AAB](#option-d-building-the-production-android-apk--aab)
9. [Configuration & Environment Variables](#9-configuration--environment-variables)
   - [Backend Variables (`MEDMESH_*`)](#backend-variables-medmesh_)
   - [Frontend Variables (`EXPO_PUBLIC_*` & Build Keys)](#frontend-variables-expo_public_--build-keys)
10. [Verification, Testing & Quality Assurance](#10-verification-testing--quality-assurance)
11. [Directory Structure](#11-directory-structure)

---

## 2. Executive Summary & Core Philosophy

In emergency medical services (EMS), the single biggest cause of preventable transit mortality is **information asymmetry**:
- Ambulances transport critical patients to hospitals whose ICUs or emergency bays just reached capacity.
- Hospital staff have no advance notice of inbound trauma until the siren arrives at the bay.
- Multiple dispatchers unwittingly contest the last critical care bed across city lines.
- Fragmented Hospital Information Systems (HIS/EMRs) operate in isolated silos, leaving emergency call centres (108/911) relying on manual phone calls.

**MedMesh** solves this by establishing a **real-time, federated capacity exchange layer that sits alongside existing hospital systems rather than attempting to replace them**.

### Core Guarantees

1. **Zero-PHI by Construction:** The database contains no patient records, no names, no Aadhaar/Social Security numbers, and no clinical free-text columns. Triage is performed across standardized non-clinical categories. PHI is rejected at the API boundary.
2. **Explainable Trust Engine:** Rather than presenting an arbitrary confidence number, facility data reliability is scored on a visible scale (50–94) backed by signed, transparent deltas (e.g., *“Live API Feed +18”*, *“Manual Entry -6”*, *“Stale Report -12”*).
3. **Capability-First, Proximity-Aware Matching:** Proximity alone is dangerous—routing a critical burn victim to a hospital 4 minutes away that lacks a burns unit results in fatal re-transfers. MedMesh matches clinical capabilities first, then filters by clinical catchment times using live road routing.
4. **Guaranteed Bed Reservations (Zero Race Conditions):** When a dispatcher commits an incident to a hospital, a cryptographic bed hold is placed through a per-facility critical section with row locks (`SELECT ... FOR UPDATE`). Active holds are immediately deducted from the state-wide capacity view (`beds_effective = beds_available - active_holds`).
5. **Seamless Incident Re-Routing:** If a patient destabilizes en route or an ER enters diversion status, dispatchers can re-route the unit with a single click. The previous bed hold is atomically released and a new hold is placed without breaking the audit chain.

---

## 3. High-Level Architecture

MedMesh is organized into clean conceptual tiers matching standard healthcare interoperability patterns:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  PRESENTATION & CLIENTS                                     │
│  Public Directory  │  108 Dispatch Console  │  Hospital Portal  │  Crew App  │  Analytics  │
│  (Desktop Web)     │  (Desktop Multi-col)   │  (PWA / Tablet)   │  (Mobile)  │  (Gov Lead) │
└──────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                               │ HTTP / REST & WebSockets (wss://)
┌──────────────────────────────────────────────▼──────────────────────────────────────────────┐
│                                MEDMESH FASTAPI GATEWAY                                      │
│  • CORS & GZip Middleware   • Rate Limiting Seam   • RBAC Claims Guard   • Error Handlers   │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                  APPLICATION ROUTERS                                        │
│  /auth          /hospitals     /doctors       /dispatch      /analytics    /governance      │
│  /connectors    /passwords     /ws/feed       /ws/incidents  /crew                          │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                   CORE SERVICE ENGINES                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────────────────────┐  │
│  │ Trust Engine         │  │ Matching Engine      │  │ Bed Reservation Engine            │  │
│  │ • Freshness Bands    │  │ • 6-Factor Ranker    │  │ • Per-facility Mutex Locks        │  │
│  │ • Anomaly Screen     │  │ • Catchment Scaler   │  │ • SELECT FOR UPDATE Atomic Holds  │  │
│  │ • Delta Scoring      │  │ • Escalation Ladder  │  │ • Deductive Projection            │  │
│  └──────────────────────┘  └──────────────────────┘  └───────────────────────────────────┘  │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────────────────────┐  │
│  │ Routing & Geo Engine │  │ Incident Lifecycle   │  │ Roster & Duty Service             │  │
│  │ • Google Dist Matrix │  │ • Strict FSM         │  │ • Dynamic Duty-End Sweeper        │  │
│  │ • Geometric Fallback │  │ • MCI Protocol       │  │ • Departmental Cover              │  │
│  │ • Split TTL Caching  │  │ • Re-routing Engine  │  │ • Public Opt-Out Controls         │  │
│  └──────────────────────┘  └──────────────────────┘  └───────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                  STATE & DATA LAYER                                         │
│  ┌──────────────────────────────────────────────┐  ┌─────────────────────────────────────┐  │
│  │ LiveStore (In-Memory Pub/Sub)                │  │ Relational Operational DB           │  │
│  │ • Process-local projection (Redis compatible)│  │ • SQLite (Pilot / Zero-Config)      │  │
│  │ • Asyncio broadcast fan-out                  │  │ • PostgreSQL + psycopg (Production) │  │
│  │ • Snapshot-then-delta protocol               │  │ • Append-only Audit & Capacity Logs │  │
│  └──────────────────────────────────────────────┘  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Technology Stack

### Backend
- **Language & Runtime:** Python 3.12+
- **API Framework:** FastAPI (Asynchronous ASGI)
- **ASGI Server:** Uvicorn (HTTP/1.1 and WebSockets)
- **Data Modeling & ORM:** SQLAlchemy 2.0 with Pydantic v2 schemas
- **Database:**
  - **Development/Pilot:** SQLite (`sqlite+pysqlite:///./medmesh.db`) with zero external service dependencies.
  - **Production:** PostgreSQL (`postgresql+psycopg://...`) with indexed foreign keys and row-level locks.
- **Real-Time Projection:** `LiveStore` — In-process cache with asyncio topic queues (drop-in replaceable with Redis Pub/Sub).
- **Authentication & Security:** Passlib (Bcrypt password hashing), PyJWT (HS256 tokens with role/scope claims).

### Frontend (Mobile, Web & PWA)
- **Framework:** Expo SDK 57 / React Native 0.86+ / React 19
- **Routing:** Expo Router v4 (File-system based navigation with typed route parameters)
- **Web Runtime:** `react-native-web` (Compiles React Native primitives to standard HTML/CSS)
- **Styling & Design System:** Custom semantic design tokens (`mobile/src/theme/tokens.ts`) with high-contrast healthcare palettes, responsive layouts (`useResponsive`), and accessible touch geometry.
- **Maps & Geolocation:**
  - Native Mobile: `react-native-maps` with Google Maps SDK.
  - Web & PWA: Leaflet / OpenStreetMap via `react-leaflet` fallback, with optional Google Maps JS API.
  - Zero-Dependency Schematic Canvas: `MapCanvas` (renders graticule projections when unkeyed).
- **Offline & Persistence:** `@react-native-async-storage/async-storage`.

---

## 5. Core Engines & Business Logic

### 5.1 Data Quality & Trust Engine
Located in `backend/app/services/trust.py`. Hospital capacity reports are never accepted blindly:

1. **Hard Integrity Filtering:** Counts cannot be negative and cannot exceed a hospital's declared physical capacity. A 500-bed hospital reporting 1,200 available beds is immediately quarantined.
2. **Rate-of-Change Anomaly Screening:** Updates that change a counter by **≥ 12 units AND ≥ 45%** in a single report are flagged for review. Requiring both prevents false alarms on small numbers (e.g. 2 beds rising to 4 is +100% but only 2 beds) while catching false sudden dumps (e.g. 0 to 50 beds).
3. **Quarantine Without Data Loss:** Quarantined updates are persisted in `models.CapacityRecord(quarantined=True)`. They do not reach the live projection, and the hospital is notified with the exact reason.
4. **Transparent Trust Score:** Facilities are scored between 50 and 94 using visible, explainable components:
   - **Freshness:** Updated <15m (+18), <60m (+8), >4h (-12).
   - **Source Provenance:** Automated API connector (+12) vs. manual dashboard entry (-6).
   - **Verification:** Health department on-site audit (+10).
   - **Integrity Penalties:** Recent quarantined attempts (-15).

### 5.2 Capability-First Matching & Routing Engine
Located in `backend/app/services/matching.py` and `backend/app/services/routing.py`.

```
Match Score = 100 × ( 0.34·capability + 0.26·proximity + 0.16·headroom + 0.12·trust + 0.12·load_balance ) 
              − ED congestion penalty
```

- **Capability Requirement as Hard Blocker:** If an incident demands a trauma surgeon or pediatric ICU and a facility lacks it, the hospital is classified as **ineligible** regardless of proximity.
- **Priority-Scaled Clinical Catchment:**
  - **P1 (Critical / Resuscitation):** 75-minute drive-time ceiling.
  - **P2 (Urgent / Serious):** 120-minute drive-time ceiling.
  - **P3 (Non-Urgent / Stable):** 180-minute drive-time ceiling.
- **Graceful Catchment Expansion:** If no capable hospital exists within the primary catchment radius, the engine does not fail; it expands outward and marks distant facilities with an explicit warning tag (*“Outside normal catchment · Last resort”*).
- **Road-Distance Prefiltering:** To keep Distance Matrix API costs sustainable, straight-line distance is computed first. Any hospital whose straight-line distance exceeds the maximum plausible highway travel boundary (`routing_prefilter_km = 260 km`) is skipped before billing a road route calculation.

### 5.3 Bed Reservation & Critical Section Engine
Located in `backend/app/services/reservations.py`.
- **Atomic Concurrency Control:** When two ambulances in the same district request the last ICU bed simultaneously, a thread lock and database row lock ensure exactly one hold succeeds. The second caller receives an honest rejection and alternative shortlist recommendations.
- **Automatic TTL Expiry:** Holds default to a 15-minute window (`MEDMESH_DEFAULT_HOLD_TTL_SECONDS = 900`). If an ambulance cancels or fails to arrive, the hold expires automatically, and the bed returns to the available pool.
- **Deductive Availability:** The live capacity projection calculates:
  $$\text{effective\_beds} = \max(0, \text{available\_beds} - \text{active\_holds})$$
  The public directory, 108 dispatchers, and hospitals all see the true unreserved capacity.

### 5.4 Zero-PHI Structural Triage
Located in `backend/app/services/triage.py`.
- **Zero Identification Columns:** The `Incident` model stores:
  - 12 standardized categories: `cardiac`, `stroke`, `road_accident`, `burns`, `respiratory`, `trauma`, `obstetric`, `pediatric`, `snakebite`, `poisoning`, `dialysis`, `other`.
  - Scene assessment enums: `patient_state` (alert, drowsy, unconscious), `mechanism` (two-wheeler, machinery, fall), `bleeding` (none, minor, severe), `hazard` (fire, chemical, electrical).
  - Geographic coordinates: Latitude, Longitude, Taluk, Landmark string.
- **API Boundary Sanitizer:** If an operator accidentally enters patient identifiers (e.g. names, phone numbers, Aadhaar IDs) in the landmark or free-text fields, the API throws an HTTP 422 validation error instructing the operator to remove personal information.

### 5.5 Mass Casualty Incident (MCI) Protocol
Located in `backend/app/routers/dispatch.py` and `mobile/app/console/mci/[id].tsx`.
- **Automatic Multi-Unit Trigger:** If casualty count $> 1$, the dispatch console enters **MCI Mode**.
- **Load-Balancing Distribution Plan:** The `/incidents/{id}/mci-plan` endpoint calculates a round-robin distribution plan across the top-ranked regional trauma centres to prevent overwhelming any single hospital's emergency room.
- **Dispatcher Review Console:** The dispatcher can review and manually adjust vehicle and destination assignments using interactive search dropdowns.
- **Child Incident Generation:** When committed (`/incidents/{id}/mci-commit`), the parent incident is split into distinct, traceable incidents (`TN-...-1`, `TN-...-2`, `TN-...-3`), each assigned to its respective ambulance and hospital while preserving full scene telemetry.

### 5.6 Ambulance State Machine & Escalation Ladder
Located in `backend/app/services/lifecycle.py`.
Ambulances transition through a strictly enforced state machine:
```
AVAILABLE 
   └── ASSIGNED 
          └── EN_ROUTE 
                 └── AT_SCENE 
                        └── TRANSPORTING 
                               └── AT_HOSPITAL 
                                      └── HANDED_OVER / CLOSED / CANCELLED 
                                             └── AVAILABLE
```
- **Escalation Ladder:** Ambulance selection searches in 3 concentric tiers:
  1. **Local District:** Units stationed in the same district as the scene.
  2. **Neighbouring Districts:** Mutual-aid units in adjacent bordering districts.
  3. **Statewide Fleet:** Any available unit in the state if local fleets are depleted.
- **Crew Availability Tie-Breakers:** A unit with a crew actively logged on shift is prioritized over an uncrewed vehicle parked at a depot.

### 5.7 Doctor Roster & Specialty Cover Service
Located in `backend/app/services/roster.py` and `backend/app/routers/doctors.py`.
- Tracks on-duty medical specialists (Cardiologists, Neurosurgeons, Orthopedic surgeons, Obstetricians, etc.).
- Background sweepers verify active duty windows (`duty_end > now()`).
- Allows hospitals to publish their active specialist cover while providing private institutions with privacy opt-out controls (`expose_doctor_directory`).

---

## 6. User Roles & Complete End-to-End User Flows

### Role Matrix

| Role Key | Name | Primary Surfaces | Core Permissions & Capabilities |
|---|---|---|---|
| *(Anonymous)* | **Citizen / Public** | `/`, `/facility/[id]`, `/doctors` | Public search, view live beds/ICU/specialties, bilingual support, directions. |
| `dispatcher` | **108 Dispatcher** | `/console`, `/console/[id]`, `/console/mci/[id]` | Incident intake, shortlist generation, bed holds, ambulance dispatch, MCI management. |
| `driver` | **Ambulance Crew** | `/crew`, `/account` | View assigned incident, navigation, one-tap trip lifecycle, patient handover. |
| `hospital_admin`| **Hospital Bed Control**| `/dashboard`, `/inbox`, `/facility/[id]` | Inbound ambulance prep alerts, bed quick-adjust keypad, doctor duty roster. |
| `gov_official` | **District Health Lead**| `/analytics`, `/analytics/[district]` | State/District rollup, capacity trends, surge alerts, SLA audits, CSV export. |
| `platform_admin`| **Platform Admin** | `/admin`, `/account` | User management, fleet provisioning, API connectors, append-only audit trail. |

---

### Flow 1: Citizen / Public User Journey

```
Open Directory (/) ──► Filter by District / Specialty ──► Tap Facility (/facility/[id]) ──► Get Directions
```

| Desktop View | Mobile View |
|:---|:---|
| <img src="docs/shots/directory-desktop.png" width="550" alt="Directory Desktop View" /> | <img src="docs/shots/directory-phone.png" width="220" alt="Directory Mobile View" /> |

1. **Accessing the Portal:** A citizen visits `http://localhost:8081/` or installs the MedMesh PWA. No account or login is required.
2. **Finding Care:** The home screen presents a clean list and live map of healthcare facilities.
   - **Language Toggle:** One-tap toggle between **English** and **Tamil (தமிழ்)** (`docs/shots/36-directory-tamil.png`) with full localized strings.
   - **Voice Search:** Tap the microphone icon in the search bar to dictate hospital names or medical requirements in English or Tamil.
   - **Filter by Care Type:** Filter by *ICU Beds*, *Oxygen Beds*, *Pediatric*, *Trauma*, or *Burns*.
   - **Live Indicators:** Clear color-coded indicators display real-time availability:
     - **Green:** ICU & General Beds Available.
     - **Amber:** General Beds Available (ICU Full).
     - **Red:** Facility at Full Capacity.
     - **Grey:** Stale / Offline (No live data in >4 hours).
3. **Inspecting Facility Details (`/facility/[id]`):** Tapping a facility opens its detail page:

| Desktop Facility Detail | Mobile Facility Detail |
|:---|:---|
| <img src="docs/shots/facility-desktop.png" width="550" alt="Facility Detail Desktop" /> | <img src="docs/shots/facility-phone.png" width="220" alt="Facility Detail Mobile" /> |

   - Breakdown of General Beds, ICU Beds, and Ventilators.
   - On-duty specialist doctors currently present.
   - Transparent data freshness and trust score breakdown.
   - Emergency contact button (`tel:`) and direct hand-off to Google Maps / Apple Maps for navigation.

---

### Flow 2: 108 Emergency Dispatcher Workflow (Single Incident)

```
Call Received ──► Intake Form (/console) ──► Ranked Shortlist (/console/[id]) ──► Confirm & Hold ──► Live Trip
```

| Desktop Dispatch Console | Mobile Dispatch Console |
|:---|:---|
| <img src="docs/shots/console-desktop.png" width="550" alt="Dispatch Console Desktop" /> | <img src="docs/shots/console-phone.png" width="220" alt="Dispatch Console Mobile" /> |

1. **Authentication:** The dispatcher signs in at `/sign-in` (or taps *“108 Dispatcher”* in demo mode).
2. **Call Intake (`/console`):** When an emergency call is received:
   - Select **Incident Category** (e.g. *Road Traffic Accident*, *Cardiac Arrest*).
   - Set **Priority** (`P1 - Lights & Siren`, `P2 - Urgent`, `P3 - Standard`).
   - Enter **Location / Landmark** (District auto-detects based on dispatcher circle).
   - Enter **Scene Assessment**: Conscious state, bleeding severity, mechanism of injury, hazards.
   - The system validates that **no patient PII** is entered.
3. **Shortlist Generation:** Click **Create Incident & Find Hospital**. The dispatcher is routed to the Incident Workspace (`/console/[id]`).

| Incident Shortlist Desktop | Incident Shortlist Mobile |
|:---|:---|
| <img src="docs/shots/case-desktop.png" width="550" alt="Incident Shortlist Desktop" /> | <img src="docs/shots/case-phone.png" width="220" alt="Incident Shortlist Mobile" /> |

   - The Matching Engine ranks all regional hospitals in real time.
   - For every candidate, the engine displays:
     - Predicted drive time (via road network).
     - Live available capacity.
     - Clinical match reasons (e.g. *“Cath lab available · On-duty cardiologist verified”*).
     - Potential blockers or warnings (e.g. *“ED heavily congested · 45m wait”*).
   - The engine automatically suggests the closest available ambulance matching the medical requirements (e.g. ALS vs BLS).
4. **Dispatch & Bed Hold:** The dispatcher selects the top-ranked hospital and clicks **Commit Dispatch & Reserve Bed**:
   - An atomic 15-minute bed hold is created.
   - The ambulance status moves to `ASSIGNED`.
   - A real-time prep alert is dispatched via WebSocket to the receiving hospital's triage desk.
5. **Re-Routing (Optional):** If the patient deteriorates or the chosen hospital encounters sudden diversion:
   - The dispatcher opens the incident, clicks **Re-Route Incident**, and picks an alternative hospital.
   - MedMesh atomically cancels the old hold, secures the new hold, and pushes an updated route to the crew.

---

### Flow 3: 108 Emergency Dispatcher Workflow (Mass Casualty Incident - MCI)

```
Intake: Casualties > 1 ──► Auto-trigger MCI (/console/mci/[id]) ──► Review Plan ──► Confirm & Dispatch All Units
```

| Multi-Incident Dispatch Queue | Routing Disclosure & Catchment Inspection |
|:---|:---|
| <img src="docs/shots/41-console-queue-statewide.png" width="550" alt="Console Queue Statewide" /> | <img src="docs/shots/42-console-routing-disclosure.png" width="550" alt="Routing Disclosure" /> |

1. **Intake:** In `/console`, the dispatcher enters **Casualties at scene** (e.g., `3` or `12`).
2. **MCI Activation:** The primary action button dynamically switches to **Create Incident & Plan MCI (X units)**.
3. **MCI Planning Console (`/console/mci/[id]`):**
   - The system calls `/incidents/{id}/mci-plan`, fetching the top capable hospitals and available ambulances.
   - It drafts an automated **round-robin distribution plan** designed to distribute casualties across multiple regional hospitals to prevent ER bottlenecks.
4. **Manual Dispatcher Override:**
   - For each casualty (Patient 1, Patient 2, etc.), the dispatcher can view the assigned ambulance and destination hospital.
   - Searchable pickers allow the dispatcher to manually re-assign any unit or hospital.
5. **Commit:** Tapping **Confirm & Dispatch All Units** executes `/mci-commit`:
   - Clones the incident into distinct tracked records (`TN-...-1`, `TN-...-2`, `TN-...-3`).
   - Places simultaneous bed holds across the destination hospitals.
   - Alerts all dispatched crews simultaneously.
   - Returns the dispatcher to the live fleet overview console.

---

### Flow 4: Ambulance Crew / Paramedic Mobile Journey

```
Dispatch Alert ──► En Route ──► At Scene ──► Patient Onboard ──► In Transit ──► Hospital Handover
```

| Crew Trip Desktop / Tablet | Crew Trip Mobile Handset |
|:---|:---|
| <img src="docs/shots/crew-desktop.png" width="550" alt="Crew Dashboard Desktop" /> | <img src="docs/shots/crew-phone.png" width="220" alt="Crew Dashboard Mobile" /> |

1. **Crew App (`/crew`):** Mounted on the ambulance dashboard tablet or paramedic handset.
2. **Inbound Call Received:** When dispatched, the screen alerts the crew with incident severity, landmark, and turn-by-turn map coordinates (`docs/shots/39-crew-trip.png`).
3. **One-Tap Trip Progression:** Paramedics advance the mission stage with a single large tap:
   - **`En Route`** $\rightarrow$ GPS broadcasts position back to 108 control room.
   - **`At Scene`** $\rightarrow$ Timer records arrival time for SLA compliance.
   - **`Patient Onboard`** $\rightarrow$ Destination hospital capacity is refreshed on screen.
   - **`Transporting`** $\rightarrow$ Turn-by-turn navigation guides the vehicle to the hospital trauma bay.
   - **`At Hospital`** $\rightarrow$ Crew arrives at the receiving emergency department.
4. **Handover & Clear:** Upon delivering the patient, the paramedic clicks **Confirm Patient Handover**. The bed hold is consumed, the incident is closed, and the vehicle returns to `AVAILABLE` status.

---

### Flow 5: Hospital Bed Control & Emergency Ward Workflow

```
Dashboard (/dashboard) ──► Inbound Alerts ──► One-Tap Quick Keypad ──► Doctor Duty Management
```

| Hospital Bed Portal Desktop | Hospital Bed Portal Mobile |
|:---|:---|
| <img src="docs/shots/dashboard-desktop.png" width="550" alt="Hospital Dashboard Desktop" /> | <img src="docs/shots/dashboard-phone.png" width="220" alt="Hospital Dashboard Mobile" /> |

1. **Hospital Operations Portal (`/dashboard`):** Designed for emergency department triage nurses and bed managers.
2. **Inbound Ambulance Prep Alerts:** A dedicated live panel shows inbound units:
   - ETA countdown.
   - Ambulance call sign.
   - Triage severity and expected clinical requirements (e.g. *Trauma / P1 / Blood required*).
   - Held bed reservation ticket.
3. **Quick-Adjust Capacity Keypad:** Designed for rapid, frictionless updates without complex menu navigation:
   - Large `+` and `-` buttons for:
     - **General Beds** (`+1`, `-1`, `+5`, `-5`)
     - **ICU Beds** (`+1`, `-1`)
     - **Ventilators** (`+1`, `-1`)
     - **ED Congestion State** (`Normal`, `Busy`, `Critical Diversion`)
   - Updates are instantly validated by the Trust Engine and broadcast to the 108 dispatch network via WebSockets.
4. **Duty Roster Management:** Toggle specialist doctors on/off duty with a single switch.

---

### Flow 6: District Health Official Analytics & Surge Control

```
District Rollup (/analytics) ──► Capacity Trends ──► Surge Mode Activation ──► CSV Audit Export
```

| Statewide Analytics Desktop | Statewide Analytics Mobile |
|:---|:---|
| <img src="docs/shots/analytics-desktop.png" width="550" alt="Analytics Overview Desktop" /> | <img src="docs/shots/analytics-phone.png" width="220" alt="Analytics Overview Mobile" /> |

| District Drilldown Desktop | District Drilldown Mobile |
|:---|:---|
| <img src="docs/shots/analytics-district-desktop.png" width="550" alt="District Drilldown Desktop" /> | <img src="docs/shots/analytics-district-phone.png" width="220" alt="District Drilldown Mobile" /> |

1. **Executive Dashboard (`/analytics`):** Used by District Medical Officers and Health Secretaries.
2. **Statewide / District Overview:** Real-time occupancy percentages, total available critical care capacity, and current active 108 incident counts.
3. **Surge Mode Activation:**
   - In disasters or epidemic surges, officials can activate **District Surge Mode**.
   - This adjusts trust freshness thresholds and automatically triggers mutual-aid ambulance escalation across neighboring districts.
4. **Auditing & SLA Compliance:**
   - View dispatch-to-scene response times, scene-to-hospital transit times, and hospital acceptance latencies.
   - **One-Tap CSV Export:** Export complete historical capacity and incident records for official government reporting.

---

### Flow 7: Platform Operations & Administration

```
Admin Portal (/admin) ──► User Management ──► Fleet Management ──► Append-Only Audit Trail
```

| Platform Administration Desktop | Platform Administration Mobile |
|:---|:---|
| <img src="docs/shots/admin-desktop.png" width="550" alt="Platform Administration Desktop" /> | <img src="docs/shots/admin-phone.png" width="220" alt="Platform Administration Mobile" /> |

1. **Administration Console (`/admin`):** Restricted to platform administrators.
2. **Fleet Management (`/admin/FleetPanel.tsx`):**
   - Register new ambulances with registration numbers, base stations, and capabilities (ALS, BLS, Neonatal, Patient Transport).
   - Link driver accounts to physical vehicles.
3. **Hospital Connector Status:** Inspect live FHIR/HL7 API connector status, heartbeat latency, and quarantine rates.
4. **Append-Only Audit Trail:** Query cryptographically attributed logs for every capacity update, bed hold, and dispatch override.

---

## 7. Multi-Platform Delivery: Web, PWA & Native Mobile

MedMesh delivers an identical, rock-solid user experience across all form factors through a single codebase:

```
                                  mobile/ (React Native / Expo)
                                                │
         ┌──────────────────────────────────────┼──────────────────────────────────────┐
         ▼                                      ▼                                      ▼
   Desktop Website                        Progressive Web App                     Native Mobile
 (Chrome, Edge, Safari)                  (Tablet / Home Screen)                 (Android APK / iOS)
• Responsive layouts                   • Standalone display mode              • Native Maps SDK
• Multi-column console                 • Offline asset caching                • GPS device sensors
• Left navigation rail                 • Zero-install hospital tablets        • Direct tel: links
```

### Responsive Web & Desktop Console
- **Adaptive Breakpoints (`mobile/src/ui/useResponsive.ts`):**
  - **Phone (`< 620 px`):** Single-column stacked layouts, bottom navigation bar, full-bleed lists, 48px minimum touch targets.
  - **Tablet (`620 px – 1024 px`):** Two-column card grids, flexible split views for hospital wards.
  - **Desktop (`>= 1024 px`):** Persistent left operational rail, multi-pane dispatcher workspaces (`Incident Queue` + `Active Workspace` + `Live Fleet Board`).

### Progressive Web App (PWA)
- Configured in `mobile/app.config.ts` under the `web` block:
  - `display: "standalone"` allows users to "Add to Home Screen" on Android, iOS, and Windows.
  - Custom favicon and web icons.
  - Instant loading via the bundled static export (`mobile/dist`).
- The **Preview Server** (`tools/preview-server.mjs`) serves the PWA assets while providing a zero-configuration reverse proxy for `/api` and `/ws` pass-through on a single port (`8080`).

### Native Android & iOS Apps
- **Prebuild & Native Tooling:** Compiles cleanly to native projects using Expo Prebuild (`in.medmesh.app`).
- **Permissions with Clear Justifications:**
  - `ACCESS_FINE_LOCATION` & `ACCESS_COARSE_LOCATION`: Used strictly during active ambulance trips to broadcast GPS to the control room. Background tracking is explicitly disabled to preserve privacy.
  - `CALL_PHONE`: Enables instant one-tap calls from the directory to hospital emergency desks.
  - `INTERNET`: For secure HTTPS and WSS communication.
- **EAS Build Ready:** Preconfigured build profiles in `mobile/eas.json` for internal testing APKs and Google Play production app bundles (`.aab`).

### Maps & Geospatial Hybrid Architecture
Located in `mobile/src/components/MapSurface.tsx`:
1. **Google Maps SDK / Tiles:** Activated when an API key is provided (`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` for web, `MEDMESH_GOOGLE_MAPS_ANDROID_KEY` for Android).
2. **Leaflet & OpenStreetMap Fallback:** Embedded web map fallback using OpenStreetMap tiles with zero key requirements.
3. **Schematic Map Canvas (`MapCanvas`):** When running in air-gapped or keyless environments, MedMesh renders a mathematical graticule projection labelled *“SCHEMATIC · TRUE COORDINATES”*, ensuring the app never crashes or displays a blank screen.

---

## 8. Getting Started & Running the Project

### Prerequisites
- **Python 3.12+** and `pip`
- **Node.js 20+** and `npm`
- **Git**

---

### Option A: Standard Local Development (Frontend + Backend)

This is the standard workflow for local development with live hot-reloading:

#### Step 1: Start the Backend API
```bash
# Navigate to the backend directory
cd backend

# Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the FastAPI server (auto-seeds the pilot database on first run)
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```
- The backend will start on **`http://localhost:8000`**.
- Interactive OpenAPI documentation will be live at **`http://localhost:8000/docs`**.

#### Step 2: Start the Frontend App
Open a second terminal window:
```bash
# Navigate to the mobile directory
cd mobile

# Install dependencies
npm install

# Start the Expo web application
npm run web
```
- The web app will open automatically at **`http://localhost:8081`**.
- For mobile testing with Expo Go, run `npm start` and scan the terminal QR code using your Android or iOS device.

---

### Option B: One-Command All-In-One Preview Server

For running MedMesh as a unified single-port application (ideal for staging environments, demos, or cloud sandboxes):

```bash
# 1. Run the dev-up bootstrap script (installs deps, seeds DB, exports web bundle)
./tools/dev-up.sh

# 2. In Terminal 1: Run the backend API
cd backend && source .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000

# 3. In Terminal 2: Run the unified preview server
node tools/preview-server.mjs
```
- Open **`http://localhost:8080`**.
- The preview server serves the compiled web app and automatically proxies `/api` and `/ws` to the backend on port 8000.

---

### Option C: Running on Android / iOS (Simulators & Physical Devices)

#### On Android Emulator:
```bash
cd mobile
npm run android
```
*(The API client automatically routes requests to `http://10.0.2.2:8000` when running inside the Android Emulator).*

#### On iOS Simulator (macOS only):
```bash
cd mobile
npm run ios
```

#### On Physical Device (via Wi-Fi / Expo Go):
```bash
cd mobile
npm start
```
1. Ensure your phone and development computer are connected to the same Wi-Fi network.
2. In `backend/app/config.py`, verify `CORS_ORIGINS=["*"]` (default).
3. Scan the QR code using the **Expo Go** app on Android or the Camera app on iOS.

---

### Option D: Building the Production Android APK / AAB

MedMesh includes complete native Android build configurations. Refer to **[ANDROID_BUILD.md](ANDROID_BUILD.md)** for detailed instructions.

#### Building an APK via Expo Application Services (EAS Build - Recommended):
```bash
cd mobile

# Install EAS CLI globally
npm install -g eas-cli

# Log in to your Expo account
eas login

# Configure project
eas init

# Build an internal test APK (downloadable link generated upon completion)
eas build -p android --profile preview

# Build a production Google Play App Bundle (.aab)
eas build -p android --profile production
```

#### Building an APK Locally with Gradle:
```bash
cd mobile

# Prebuild native Android project files
npx expo prebuild --platform android --clean

# Build release APK using Gradle
cd android
./gradlew assembleRelease
```
The output APK will be generated at:
`mobile/android/app/build/outputs/apk/release/app-release.apk`.

---

## 9. Configuration & Environment Variables

### Backend Variables (`MEDMESH_*`)
Configured in `backend/.env` (defaults defined in `backend/app/config.py`):

| Variable | Default Value | Description |
|---|---|---|
| `MEDMESH_DATABASE_URL` | `sqlite+pysqlite:///./medmesh.db` | SQLAlchemy connection string (`postgresql+psycopg://...` for production). |
| `MEDMESH_JWT_SECRET` | `dev-only-secret-...` | **Critical:** Secret key for signing authentication tokens. Change in production! |
| `MEDMESH_ACCESS_TOKEN_TTL_MINUTES` | `720` (12 hours) | Lifetime of session access tokens. |
| `MEDMESH_DEMO_MODE` | `true` (dev) / `false` (prod) | When `true`, exposes one-tap pilot test accounts on the sign-in screen. |
| `MEDMESH_FRESHNESS_LIVE_MINUTES` | `15` | Reports younger than this are tagged as `live` (+18 trust delta). |
| `MEDMESH_FRESHNESS_WARM_MINUTES` | `60` | Reports between 15m and 60m are tagged as `warm`. |
| `MEDMESH_FRESHNESS_STALE_MINUTES` | `240` (4 hours) | Reports older than 4h are tagged as `stale` and receive trust penalties. |
| `MEDMESH_ANOMALY_ABS_DELTA` | `12` | Absolute change threshold required to trigger anomaly review. |
| `MEDMESH_ANOMALY_PCT_DELTA` | `0.45` (45%) | Percentage change threshold required to trigger anomaly review. |
| `MEDMESH_DEFAULT_HOLD_TTL_SECONDS` | `900` (15 min) | Automatic expiration window for emergency bed reservations. |
| `MEDMESH_GOOGLE_MAPS_SERVER_KEY` | *(unset)* | Server-side API key for Google Distance Matrix (IP-restricted). |
| `MEDMESH_ROUTING_TIMEOUT_SECONDS` | `4.0` | Maximum wait time for third-party routing before falling back to geometry. |
| `MEDMESH_SIMULATOR_ENABLED` | `true` | Runs background capacity and dispatch simulator for active demos. |

### Frontend Variables (`EXPO_PUBLIC_*` & Build Keys)
Configured in `mobile/.env` (inlined into the JavaScript bundle at build time):

| Variable | Target Platform | Description |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | Web / App | Base URL of the backend API (e.g. `https://api.medmesh.example.in`). |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | Web / PWA | Google Maps JavaScript API key (restrict by HTTP Referrer). |
| `EXPO_PUBLIC_GOOGLE_MAPS_DIRECTIONS_KEY` | Web / PWA | Google Directions API key for drawing real road corridors. |
| `MEDMESH_GOOGLE_MAPS_ANDROID_KEY` | Android Native | Maps SDK for Android key (restrict by package `in.medmesh.app` & SHA-1 fingerprint). |
| `MEDMESH_GOOGLE_MAPS_IOS_KEY` | iOS Native | Maps SDK for iOS key (restrict by Bundle ID `in.medmesh.app`). |

---

## 10. Verification, Testing & Quality Assurance

MedMesh maintains rigorous automated test suites covering backend API contracts, frontend TypeScript types, and headless browser workflows:

```bash
# 1. Run the Backend API Pytest Suite (89 passed tests)
cd backend
source .venv/bin/activate
python3 -m pytest tests -q

# 2. Run the Frontend TypeScript Static Analysis (0 errors)
cd mobile
npx tsc --noEmit

# 3. Run the Headless Browser QA Harnesses (Simulates real user sessions)
cd tools/qa
node sweep.mjs                 # Validates 32 route × viewport combinations
node surfaces.mjs              # Validates role-scoped UI surfaces across viewports
node probe-console-crew.mjs    # Validates dispatcher-to-crew dispatch lifecycle
node probe-crew-lifecycle.mjs  # Validates full trip state machine from dispatch to handover
node probe-multiuser.mjs       # Validates concurrent sessions (dispatcher racing last bed, etc.)
```

---

## 11. Directory Structure

```
medmesh/
├── backend/                             # Python FastAPI Backend
│   ├── app/
│   │   ├── main.py                      # FastAPI application entrypoint & middleware
│   │   ├── config.py                    # Environment settings & engine thresholds
│   │   ├── database.py                  # SQLAlchemy engine & session factory
│   │   ├── models.py                    # Database schema (Strictly zero patient PII)
│   │   ├── schemas.py                   # Pydantic request/response validation schemas
│   │   ├── live.py                      # LiveStore in-memory projection & pub/sub
│   │   ├── repository.py                # Database queries & projection sync
│   │   ├── security.py                  # Bcrypt hashing, JWT tokens & RBAC dependencies
│   │   ├── seed.py                      # Statewide pilot dataset seeder (152 facilities)
│   │   ├── simulator.py                 # Background capacity & workflow driver
│   │   ├── data/
│   │   │   └── tn_districts.py          # All 38 Tamil Nadu districts & headquarters coords
│   │   ├── routers/                     # HTTP & WebSocket endpoints
│   │   │   ├── auth.py                  # Login, session verification & pilot accounts
│   │   │   ├── dispatch.py              # 108 intake, matching, bed holds & MCI engine
│   │   │   ├── hospitals.py             # Capacity updates, verification & facility queries
│   │   │   ├── doctors.py               # Specialist roster & on-duty tracking
│   │   │   ├── analytics.py             # District rollups, surge mode & CSV export
│   │   │   ├── governance.py            # Audit trail queries & estate health
│   │   │   ├── connectors.py            # Hospital FHIR/HL7 API connectors
│   │   │   └── ws.py                    # Real-time WebSockets (/ws/feed, /ws/incidents)
│   │   └── services/                    # Core business logic engines
│   │       ├── trust.py                 # Anomaly screening & explainable trust scoring
│   │       ├── matching.py              # 6-factor capability-first hospital ranking
│   │       ├── reservations.py          # Atomic bed hold critical sections
│   │       ├── triage.py                # Structured scene assessment & PHI filter
│   │       ├── routing.py               # Google Distance Matrix & geometric prefilter
│   │       ├── lifecycle.py             # Ambulance state machine & legal transitions
│   │       └── roster.py                # Specialist shift duty calculations
│   ├── tests/
│   │   └── test_api.py                  # 89 comprehensive integration tests
│   └── requirements.txt                 # Backend Python dependencies
│
├── mobile/                              # Universal React Native / Expo Frontend
│   ├── app/                             # Expo Router file-system routes
│   │   ├── _layout.tsx                  # Root app layout, providers & navigation chrome
│   │   ├── index.tsx                    # Public directory & live capacity map
│   │   ├── sign-in.tsx                  # Role login & one-tap pilot accounts
│   │   ├── crew.tsx                     # Ambulance crew active trip dashboard
│   │   ├── dashboard.tsx                # Hospital bed control & quick keypad
│   │   ├── inbox.tsx                    # Role-scoped operational notification inbox
│   │   ├── doctors.tsx                  # Specialist directory & duty cover
│   │   ├── account.tsx                  # User profile, diagnostics & session state
│   │   ├── onboard.tsx                  # Facility self-onboarding flow
│   │   ├── console/                     # 108 Dispatcher operational workspace
│   │   │   ├── index.tsx                # Queue, intake form & fleet overview
│   │   │   ├── [id].tsx                 # Single incident workspace & shortlist
│   │   │   └── mci/
│   │   │       └── [id].tsx             # Mass Casualty Incident planning console
│   │   ├── facility/
│   │   │   └── [id].tsx                 # Facility detail, trust factors & doctor roster
│   │   ├── analytics/                   # Government analytics & surge management
│   │   │   ├── index.tsx                # State overview & district cards
│   │   │   └── [district].tsx           # District drilldown & facility metrics
│   │   └── admin/                       # Platform operations
│   │       ├── index.tsx                # Admin overview & system logs
│   │       └── FleetPanel.tsx           # Fleet management & vehicle provisioning
│   ├── src/
│   │   ├── api/                         # Platform-aware HTTP client & TypeScript types
│   │   ├── components/                  # UI components (MapSurface, Selectors, etc.)
│   │   ├── state/                       # AuthProvider, LiveProvider (WebSockets), SessionGate
│   │   ├── theme/                       # Color tokens, typography & spacing system
│   │   └── ui/                          # Design system primitives (Button, Card, Stack, etc.)
│   ├── app.config.ts                    # Expo configuration, native permissions & Maps keys
│   ├── eas.json                         # EAS Build profiles (development, preview, production)
│   ├── package.json                     # Frontend dependencies & npm scripts
│   └── setup.sh                         # Clean build script for web export
│
├── tools/                               # Operational & Development Tooling
│   ├── dev-up.sh                        # One-command developer bootstrap script
│   ├── preview-server.mjs               # Standalone production PWA preview server
│   └── qa/                              # Automated headless browser QA harnesses
│
├── ANDROID_BUILD.md                     # Complete Android native APK & AAB build guide
├── ARCHITECTURE.md                      # Detailed technical architecture report
└── README.md                            # Comprehensive project documentation
```

---

## License

This project is licensed under the Apache License 2.0. See the LICENSE file for details.
