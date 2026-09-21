# MedMesh — architecture notes

How the implementation maps onto `MedMesh_Architecture_Report.pdf`, and where it
deviates. Deviations are listed with the reasoning, because "we did it
differently" is only defensible if the reason is written down.

---

## 1. Layer mapping

The report describes a layered, microservices-oriented system (§9.1). This
implementation keeps the layering and collapses the service count, because a
pilot with 29 facilities does not need eleven deployables — and splitting a
codebase that small across services makes every change slower without making
anything more reliable.

| Report layer | Here | Notes |
|---|---|---|
| Data Sources — hospital systems (API) | `simulator.ingest_loop` | Stands in for real connectors. Emits through the same ingest function the HTTP endpoint uses, so the trust engine cannot be bypassed by a "different" path. |
| Data Sources — manual entry dashboard | `app/dashboard.tsx` + `POST /capacity/quick` | The `+1 bed freed` keypad from §6.2. |
| Ingestion — API connectors / HL7-FHIR adapter | `POST /hospitals/{id}/capacity` | One write path. A real HL7-FHIR adapter is a mapper in front of this endpoint, not a second pipeline. |
| Ingestion — data validation queue | `CapacityRecord.quarantined` + trust engine | Quarantined rows are stored, excluded from the projection, and surfaced in the hospital portal and audit trail. |
| Core — Data Quality & Trust Engine | `services/trust.py` | Freshness bands, anomaly screen, composite explainable score. |
| Core — Matching & Routing Engine | `services/matching.py` + `services/geo.py` | Weighted 6-factor ranking with catchment logic. |
| Core — Doctor Directory Service | `routers/doctors.py` | On-duty status, specialty, opt-out for private facilities. |
| Core — Bed-Hold / Reservation Service | `models.BedHold` | Expire-on-read, hold counts deducted from the published projection. |
| Core — Notification Service | `live_store.publish` → WebSocket | Fan-out with topic filters. Production swaps in FCM/Twilio at this seam. |
| Core — Government Analytics Engine | `routers/analytics.py` | District rollups, trend from the append-only series, surge mode, CSV export. |
| Data — Live Capacity Store | `live.py` (`LiveStore`) | Process-local dict + asyncio fan-out. Interface-compatible stand-in for Redis. |
| Data — Operational DB | PostgreSQL-ready SQLAlchemy models | SQLite by default so the pilot boots with zero infrastructure. |
| Data — Analytics Warehouse | `CapacityRecord` append-only series | Rollups computed from the series rather than from the live projection, so historic reports are reproducible. |
| Data — Audit Log Store | `models.AuditLog` | Append-only by convention: no update or delete path exists in the codebase. |
| Surfaces | `mobile/app/*` | Five role-scoped surfaces from one Expo Router codebase. |

---

## 2. Deviations from the recommended stack

### Backend: FastAPI (Python) instead of NestJS / Spring Boot

Requested by you, and the report itself lists the backend as "Node.js/NestJS or
Java Spring Boot *microservices*" — a recommendation rather than a constraint.

Worth noting what Python buys and costs here. It buys: the health-data ecosystem
(FHIR/HIPAA tooling, `fhir.resources`, pandas for analytics) is Python-first, and
the analytics and future ML work in §19 will not need a second language. It
costs: CPU-bound fan-out is weaker than Node's, so the trust engine and matching
are written to be async-safe rather than to exploit threads. Both are pure
functions over small inputs, so this has not been a constraint at pilot scale.

### Frontend: one Expo codebase instead of separate Next.js portals

The report recommends React/Next.js for the public portal, hospital portal, 108
console and government dashboard, plus React Native for the driver app.
Implementing that literally means five frontends and four redesigns of every
list, table and status component.

Instead: one Expo Router codebase with platform-responsive layout. Expo Router
compiles to a real web app (the preview you are looking at) *and* to native iOS
and Android from the same source. The crew app is a route, not a second
repository.

The cost is real and should be stated: a Next.js portal would give server-side
rendering and better first-paint SEO for the citizen directory, and would let the
public site ship without downloading a React Native web runtime. **For a
citizen-facing public portal at national scale, that is the right call and this
should be split out.** At pilot scale the unification is worth more than the
bundle size.

### Maps: schematic canvas instead of Google Maps Platform

§8's technology table specifies Google Maps Platform. That needs a billable API
key, and shipping a fake-looking map that *implies* real geography is worse than
shipping an honestly-labelled schematic one.

So: `MapCanvas` projects true lat/lng onto a graticule, labels itself
`SCHEMATIC · TRUE COORDINATES · NOT TO SCALE`, and hands off to the device map
application for anything navigational. `RouteCanvas` does the same for corridors.
The seam is one function — `services/geo.estimate_leg()` — and one component
prop; dropping in Directions API polylines changes nothing above them.

### Live store: in-process instead of Redis

`LiveStore` has the same surface a Redis-backed implementation would
(`get`/`all`/`put`/`subscribe`/`publish`). Swapping the class is the whole change.
The pilot runs single-node; a multi-AZ deployment needs Redis pub/sub because the
fan-out must cross process boundaries.

---

## 3. Data model: the zero-PHI rule, structurally

§13 of the report commits to collecting no patient-identifiable information. That
commitment is enforced by the schema rather than by policy:

* There is no patient entity. No MRN, no name, no age, no diagnosis field, and no
  free-text clinical column anywhere in `models.py`.
* `Incident` carries a category from a closed enum of twelve non-clinical triage
  buckets, a location, and a required-capabilities set. That is enough to choose a
  destination and not enough to identify a person.
* `IncidentCreate.caller_notes` is validated against identifier patterns
  (`name:`, `aadhaar`, `age:`, phone-number phrasing) and rejects the request. An
  operator who types a patient's name is told to remove it rather than having it
  silently stored.
* `Doctor` is the only personal data in the system, and only professional
  attributes: name, registration number, specialty, on-duty state. No contact
  details, no schedules, no patient interactions. Private facilities can opt out
  of doctor-level exposure entirely (`expose_doctor_directory`).

The consequence worth stating: a future feature *cannot* leak PHI through an
existing column, because there is no column to leak it through. Adding one would
require a deliberate schema migration, which is reviewed.

---

## 4. The trust engine (§6.3)

Two entry points, both in `services/trust.py`.

**`evaluate_ingest()`** runs on every write, before the value can become the live
projection. It has two tiers:

1. *Hard integrity* — negative counts, or counts exceeding the facility's declared
   capacity. These quarantine outright. A 1,020-bed hospital reporting 4,000 free
   beds is not an optimistic estimate; it is a data error, and publishing it would
   send an ambulance to a bed that does not exist.
2. *Rate-of-change* — a single update moving a counter by ≥12 units **and** ≥45%
   is flagged for review. Both conditions, not either: a small clinic going 2→14
   beds is a 600% jump that is genuinely unremarkable.

Quarantined records are **written and retained**. They are evidence, and the
facility that submitted one is told exactly which rule it tripped and that the
live figure was not changed. Silently dropping a report is how a facility learns
to stop reporting.

**`score_facility()`** produces the directory's trust score from freshness,
provenance (API vs manual), verification status, capability, upheld feedback and
quarantine history. It is anchored at 52 so the scale discriminates: in the seeded
pilot, scores spread 50–94 rather than saturating at 100.

Every factor carries a signed delta that the UI renders verbatim. "Why is this
facility at 61?" has a specific answer, because a score nobody can interrogate is
a score nobody should route on.

---

## 5. Matching engine (§6.4)

```
score = 100 × ( 0.34·capability + 0.26·proximity + 0.16·headroom
              + 0.12·trust      + 0.12·load_balance )
        − ED congestion penalty
```

**Capability is weighted heaviest, deliberately.** Routing a burns patient to a
facility four minutes closer that has no burns unit is not a good outcome, and
the weights should not pretend otherwise. A missing required capability is a hard
blocker, not a soft penalty.

Three decisions that matter more than the weights:

**Proximity decays at a 32-minute half-life, not 11.** Half-life is expressed in
ETA minutes because minutes are what the decision is made in. An earlier
11-minute half-life made everything beyond ~40 minutes score identically at ~0,
which produced a real pathology: a Madurai hospital 222 km away ranked third for
a Coimbatore road accident, ahead of facilities 6 km away, because it had a trauma
centre and distance had stopped differentiating.

**Catchment is priority-scaled (P1 75 min, P2 120 min, P3 180 min), and it is not
a hard filter.** If any eligible candidate is inside the catchment, everything
outside it is excluded *with an explicit reason*. If nothing is in range, distant
candidates stay eligible and carry a warning, so the shortlist presents itself as
a genuine last resort rather than as a normal choice.

**Holds are deducted before scoring.** `beds_effective = beds_available −
active_holds`. A bed promised to an inbound crew is not available, and a
dispatcher reading "3 free" who finds 2 will stop trusting the number.

Every candidate — including rejected ones — returns machine-generated reasons,
and the whole shortlist is snapshotted onto the incident at dispatch time. When a
review asks why the ambulance went to Hospital A instead of the nearer Hospital
B, the answer is stored and specific.

---

## 6. Realtime

`LiveStore` is a projection plus an asyncio pub/sub. Two WebSocket endpoints:

* `/ws/feed` — capacity deltas. Hospital-scoped accounts receive only their own
  facility (`scope=mine`), enforced server-side. Client-side filtering would mean
  shipping the whole state's capacity stream to every connected tablet.
* `/ws/incidents` — dispatcher-only: incidents, holds, inbound alerts.

Protocol is snapshot-then-delta: current state on connect so no surface renders an
empty grid, then deltas only. Heartbeats every 20–25 s double as a liveness check;
a silently dead socket on an ops wall display is worse than a visibly broken one.
Slow consumers are dropped from the queue rather than allowed to back-pressure the
ingest path.

Client-side (`state/LiveProvider.tsx`): capped exponential backoff, sockets closed
while backgrounded, and `connected` tracked separately from `degraded` — "the
socket dropped" and "the socket dropped and nothing has arrived for 45 s" are
different problems to an operator. Every surface shows the age of its own data.

---

## 7. RBAC (§8)

Enforced at the dependency layer, not in handlers:

* Citizens browse with no account. `current_user_optional` drops anonymous callers
  to public scope; operational routers use `require_roles(...)`.
* `require_facility_scope` confines hospital accounts to their own facility. A
  facility admin cannot read *or* write another hospital's capacity, roster or
  audit history.
* Government officials are jurisdiction-scoped — a Coimbatore officer reading
  another district's analytics gets 403.
* Self-service registration is restricted to citizens at the service level: an
  unauthenticated endpoint that could mint a `hospital_admin` token would make the
  whole model decorative. Operational accounts are provisioned by a platform admin.

Cross-cutting: every write calls `services/audit.record()` with actor, action,
entity, summary and a diff payload. The table has no update or delete path.

---

## 8. What production adds

In rough dependency order:

1. **PostgreSQL** — set `MEDMESH_DATABASE_URL`. The latest-per-facility query in
   `repository.py` carries its `DISTINCT ON` variant in a comment.
2. **Redis** — implement `LiveStore` against it; the class is the only change.
3. **Real connectors** — HL7-FHIR adapter in front of `POST /capacity`, per
   vendor. The manual dashboard remains the universal fallback.
4. **Google Maps Platform** — `geo.estimate_leg()` and the two canvas components.
5. **Keycloak/Auth0** — replace `security.verify_token`. Keep the `sub`/`role`/
   `scope` claim shape and nothing downstream changes.
6. **FCM/APNs + Twilio** — `live_store.publish` is the fan-out seam; SMS/IVR is a
   subscriber, not a rewrite.
7. **SecureStore for tokens**, short TTLs, refresh rotation, rate limiting, MFA.
8. **Kafka → warehouse** for the analytics tier, so district reporting stops
   sharing an engine with live reads.
9. **Prometheus + Grafana** — `/governance/health` and `/analytics/sla` already
   expose the metrics that matter: feed coverage, staleness counts, quarantine
   rate, dispatch latency percentiles, connected sockets.

---

## 9. Testing

`backend/tests/test_api.py` — 16 tests, aimed at the paths that cause harm rather
than at coverage percentage:

| Test | What it protects |
|---|---|
| `test_trust_engine_quarantines_impossible_update` | Absurd values never reach the projection or the public directory |
| `test_facility_scope_is_enforced` | One hospital cannot write another's data |
| `test_quick_adjust_applies_delta_and_clamps_at_zero` | The keypad cannot produce negative capacity |
| `test_dispatch_flow_creates_hold_and_alerts_hospital` | Full lifecycle, and the hold is visibly deducted |
| `test_catchment_rule_beats_raw_capability` | The 222 km ranking regression |
| `test_incident_notes_reject_patient_identifiers` | The zero-PHI rule at the boundary |
| `test_matching_rejects_facility_without_required_resource` | Every ineligible candidate explains itself |
| `test_government_analytics_aggregates_without_pii` | Aggregation, jurisdiction scope, CSV has no patient columns |
| `test_surge_mode_relaxes_freshness_and_is_single_active` | Surge state machine |
| `test_realtime_feed_pushes_snapshot_then_delta` | The WebSocket contract the UI depends on |

Plus `npx tsc --noEmit` in CI, and the headless-browser pass that produced
`docs/shots/` — which is the check that catches "it typechecks but renders a blank
screen".

---

## 10. Three bugs this build actually had

Recorded because they are the failures this shape of system invites, and the
fixes are now load-bearing:

**Anonymous first requests.** Every authenticated screen fired its first data call
while the stored session was still being read, so it went out with a null token
and rendered a 401 error state on a completely valid session. Fixed by
`SessionGate`, which holds the tree until the session resolves. Root cause was
per-screen discipline; the fix removes the need for it.

**A ranking pathology.** With an 11-minute proximity half-life, distance stopped
discriminating past ~40 minutes, so a trauma centre four hours away outranked
facilities six kilometres away. This is the failure mode of any weighted scoring
function whose terms silently saturate — the fix was to express decay in the unit
the decision is made in, and to add a catchment rule with an explicit reason
attached.

**A zero that read as perfection.** Median dispatch time rendered as `0 s` on a
freshly seeded database, because no dispatch had been committed yet. A dashboard
that reports a metric of zero when it means "no data" quietly destroys its own
credibility. It now reports the sample size instead.
