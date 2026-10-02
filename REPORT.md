# MedMesh — Project Report

**A real-time cross-hospital capacity exchange for Tamil Nadu.**

| | |
| --- | --- |
| Backend | Python 3.13 · FastAPI · SQLAlchemy 2.0 · SQLite/WAL (Postgres-ready) |
| Frontend | React Native 0.86 / Expo SDK 57 · expo-router · one codebase, web + iOS + Android |
| Coverage | 38 districts · 152 facilities · 1,069 clinicians · 66 ambulances |
| Code | 15,192 backend Python · 20,729 frontend TS/TSX · 3,916 lines of tests · 2,434 lines of browser harness |
| Verified | 84 API tests passing · 9 browser harnesses · 32 route × viewport sweeps · 12 surfaces × 3 phone widths + Tamil · Google Maps suite · clean typecheck |
| Repository | local git, 226 tracked files — push URL pending from you |

---

## 1. The change you asked for

You identified that the system was doing this:

```
Google route → Frontend visualization
```

and that it needed to do this:

```
Google route → Distance / ETA → Matching engine → Hospital ranking → Dispatcher → Google map
```

**That change is implemented.** Routing is no longer a decoration drawn after the
decision; it is the input the decision is made on. The specific work:

**A routing service with a provider seam.** `backend/app/services/routing.py`
defines a `RoutingProvider` interface, a Google Distance Matrix implementation,
and a geometric fallback implementing the same interface. The engine only ever
talks to the interface, so the platform behaves identically with or without a
Maps key — but *labelled differently*, which is the part that matters.

**Distance Matrix rather than Directions.** The engine asks one question —
"how far is each of these 152 facilities" — which is a one-to-many question.
Directions answers one pair per request and returns geometry nobody in the
matching path needs, so using it here would be 152 billed calls where six
suffice. Directions remains the right API for the *chosen* route, where geometry
and turn-by-turn are the point, and the crew screen uses it for exactly that.
Two different APIs for two genuinely different questions.

**Ranking before rendering.** `build_shortlist()` now resolves road legs for
every candidate *before* `rank_candidates()` is called, and the proximity factor
is scored on road drive time rather than straight-line distance. The corridor
estimate that used to sit beside the real route is gone; `MapSurface` owns the
fallback and draws it only when Directions is configured but unresolvable, never
alongside real road geometry.

**A cost-aware prefilter, derived from the clinical catchment.** A road is never
shorter than a straight line, so a facility whose straight-line distance already
exceeds what the priority's catchment could contain cannot be inside it by any
road. Those are dropped before a single request is spent. The radius is *derived*,
not hard-coded: P1's 75-minute catchment at a generous 70 km/h gives 88 km, so a
statewide shortlist routes ~60 of 152 facilities instead of all of them. A flat
260 km would have dropped almost nothing and billed six requests per console
refresh; a flat 50 km would have silently hidden the distant trauma centre that
is the only correct answer to a P3 transfer.

**Split cache lifetimes.** Road *distance* between two fixed points is a property
of the road network and barely changes; road *duration* is traffic and goes stale
in minutes. The provider caches them on separate clocks, so a known 14 km road
does not become unknown when the duration expires.

**Failure degrades and says so.** Routing is a third-party network call in the
path of an emergency dispatch. It is treated as such: a 4-second timeout well
inside a human's tolerance, per-element fallback when the provider has no answer
for one destination, whole-request fallback when the provider is unreachable, and
never an exception that unwinds a dispatch. A leg carries its `provider` and
`traffic_aware` flags, and the shortlist carries a summary — so the console can
tell a dispatcher whether the minutes in front of them came off a road network or
out of a winding factor.

In the running system, a Perambalur P3 incident now reports:

> *Ranked on straight-line estimates · no road routing configured (152 facilities)*

and each candidate row reads `64.2 km · 79 min direct`. Configure
`MEDMESH_GOOGLE_MAPS_SERVER_KEY` and the same line reads *Ranked on road drive
time · 61 of 152 facilities routed · 44 with live traffic within a 210 km
straight-line prefilter*, and the rows read `via road · live traffic`. The
distinction is never invisible.

### What this is worth, concretely

The engine can now distinguish two hospitals that are equidistant in metres and
twenty minutes apart in time — a river with one bridge, a hill with one ghat road,
a national highway that runs the long way round and is twice as quick. That is
the claim in your message, and it is now true of the code rather than aspirational.

---

## 2. All 38 districts of Tamil Nadu

The dataset previously covered six pilot districts. It now covers the state.

**`backend/app/data/tn_districts.py`** holds all 38 districts with their Tamil
names, headquarters coordinates and Census 2011 populations — including the five
carved out in 2019 (Kallakurichi, Ranipet, Tirupathur, Tenkasi, Chengalpattu),
which a dataset built from older material silently omits. A capacity exchange
that cannot find Chengalpattu is not usable in the state it is built for.

**What is real and what is not** is stated at the top of that file and worth
repeating here, because a pilot dataset that blurs the line is worse than none:

- **Real:** district identity, Tamil names, headquarters coordinates to ~11 m,
  populations (Census 2011).
- **Synthetic:** every facility. Bed counts, ICU counts, capabilities and
  rosters are plausible pilot values, not returns from any hospital. Names
  follow Tamil Nadu's actual conventions — "Government Medical College Hospital,
  \<district\>", "District Headquarters Hospital", "\<town\> \<speciality\>
  Hospital" — so the *shape* of the estate is right even though the estate is
  invented.

Coordinates had to be true for this to work at all: now that ranking scores on
road distance, a district placed in the wrong part of the state produces a
confidently wrong ranking.

**The estate, sized to the state:**

| | |
| --- | --- |
| Districts | 38 |
| Facilities | 152 — 99 public, 32 private, 21 trust |
| Connector-linked / manual | 78 / 74 |
| Clinicians | 1,069 (623 on duty) |
| Ambulances | 66 — 54 GVK EMRI 108, 12 private |
| Beds / ICU beds | 47,766 / 4,459 |
| Capacity records | 27,430 |

The fleet is sized to the districts rather than to the demo: roughly one 108 unit
per 1.4 million residents, minimum one per district, because a district with no
unit is a district where the ambulance-assignment path can never be exercised.
NICU units are based only where a facility with a neonatal ICU exists to receive
them — a neonatal transport two hours from the nearest incubator is a capability
on paper only.

### Two genuine bugs the coverage tests found

Both were found by writing the test first and watching it fail, and both are the
kind that would have surfaced as a production incident rather than a bad
screenshot:

**A whole district could vanish from the public directory.** Verification was
assigned by list position (`idx % 9 == 7`). That was harmless for 29 facilities
and wrong for 152: the modulus landed such that the Nilgiris — a hill district
where the only road between towns is long and winding — had both its hospitals
unverified, so the district disappeared from the citizen map entirely while
looking fine from inside the platform. The rule now assigns by role in the
estate: a district's principal public hospital is always verified, because it is
the state's actual safety net. A rule that can silently erase a district is not a
fixture, it is a bug waiting for the dataset to change.

**Three districts were under-provisioned.** The test asserting every district has
at least three facilities and public provision failed on Nilgiris (two
facilities), Nagapattinam and Mayiladuthurai. Eleven facilities were added to
close it.

### Performance at the new scale

The candidate set grew 5×. Intake plus a full statewide ranking takes **62–79 ms**
— comfortably inside the report's sub-second read budget, and now asserted by a
test that measures five runs and fails above 1 s, precisely because a 5× larger
candidate set is the change most likely to blow it quietly.

---

## 3. The rest of the product

### Five consumer surfaces, one codebase

| Surface | Route | Who |
| --- | --- | --- |
| Citizen directory | `/`, `/facility/[id]`, `/doctors` | anyone |
| Ward dashboard | `/dashboard`, `/inbox` | hospital admin |
| 108 dispatcher console | `/console`, `/console/[id]` | dispatcher |
| Ambulance crew app | `/crew` | driver |
| Government analytics | `/analytics`, `/analytics/[district]` | district officer |
| Platform operations | `/admin` | platform admin |

Layout switches on measured width: phone (single column, bottom tab bar,
full-bleed lists), tablet (two-column cards), desktop (persistent left rail).

### The matching chain

Ordered the way a clinician asks the question, not the way the data is shaped:

**capability → specialist on duty → capacity → trust/freshness → road ETA →
catchment → load balance**

Weights: capability .28, specialist on duty .12, proximity .24 (half-life 32 min),
headroom .14, trust .11, load .11, with an ED-congestion penalty of 0/3/11/24.
"Department exists" and "specialist on duty" are scored separately because
Hospital A with cardiology listed and nobody on shift must not rank equal to
Hospital B with both.

Reachability beats raw capability: a facility four hours away with a trauma centre
cannot outrank one twelve minutes away, but is not hidden when it is the only
option left — it is presented as an explicit last resort with a warning.

### Safety and correctness properties now asserted by tests

- **No patient data, structurally.** No patient table, no MRN, no diagnosis
  column, no free-text clinical field. Incident notes are validated against
  identifier patterns at the API boundary.
- **Bed holds under a real critical section.** Per-facility lock plus
  `SELECT … FOR UPDATE`; capacity counted from committed rows minus live holds
  inside the lock. Two dispatchers racing for the last ICU bed produce one hold
  and one clear refusal.
- **Incident references cannot collide.** Found in the simulator log, not in a
  test: both producers drew `TN-DDMM-XXX` from a 13,824-value space *without
  checking it was free*. At a few hundred incidents a day the birthday paradox
  makes a repeat near-certain, and the resulting exception unwound out of the
  background loop. Now a shared check-then-take allocator, with two tests that
  fail against the old code.
- **The publication gate.** Unverified and suspended facilities are hidden from
  the anonymous directory, and `include_unverified=true` does not override it for
  anonymous callers.

### Citizen accessibility

The citizen surface is fully bilingual (English and Tamil, ~45 keys) with voice
search whose locale follows the interface language. It **never auto-submits** —
a misheard place name acted on is worse than no voice search. Operational
consoles stay English deliberately: a machine-translated dispatch console is a
patient-safety risk, and that decision is documented in `src/lib/i18n.ts`.

---

## 4. The end-to-end audit

A forty-two item review of every route, role and screen was worked in order after
the statewide build. Most items were small. These are the ones that changed
behaviour.

**A ward could not answer.** An inbound prep alert had no reply, so a facility
that could not take the patient had no way to say so and its bed stayed on the
next incident's shortlist. Facilities now accept or decline with a structured
reason: a decline releases the holds immediately, corrects the counters where
the reason implies it, records the facility so the shortlist does not re-offer
it, and leaves the incident running — a closed door is not a cancelled call. A
dispatcher can record the same answer taken down by telephone, and the audit
trail distinguishes the two, because after an incident somebody asks. Re-routing
back onto a facility that has refused is refused in turn unless the dispatcher
states a reason, and that reason is the audit entry.

**The driver's phone never reported its position.** `POST /crew/location` had
existed from the first week and no client called it: the only thing that moved a
vehicle on the console's map was the position attached to a status press. Four
or five fixes across a whole trip, none during the longest leg, and a console
watching a unit sit motionless on the way to a P1 — a picture that is not stale
so much as confidently wrong. The crew screen now reports while a trip is live
and shows the age of the last fix; the route strip states plainly that it is an
overview rather than turn-by-turn and that navigation runs in Google Maps; the
cached-capacity warning prints the age at the size of the counters it qualifies;
and the endpoint bounds a fix to the state instead of accepting `lat: 95`.

**The operations picture was public.** `/analytics/overview` — open incidents,
live fleet strength, active bed holds, surge state — accepted an optional
credential, so anyone could read how many ambulances were free across Tamil Nadu.
It is now authenticated and role-scoped, the SLA report is operations-only, and
both CSVs carry the officer's jurisdiction; the district export button downloads
the file with the token attached instead of opening a tab containing the API's
401 body. It was also broken: the incident CSV had been raising `NameError` since
the split-interval columns landed, which nothing had ever pressed.

Also from the same pass: one incident-visibility rule replacing per-endpoint
guesses about who may read a case; flat `assigned_hospital_id` /
`assigned_ambulance_id` on the incident payload, so a client can ask "is this
mine" without null-checking a nested object; structured decline reasons and a
422 when none is given; and the console rendering holds and destination for all
eight stages of a trip rather than the first three.

---

## 5. The second audit — `problem_new.pdf`

The second review arrived as 54 numbered findings with severities, plus a
70-step prioritised plan and a release-hygiene section. Every one of them is
tracked in `AUDIT-CHECKLIST.md`, row by row, with the verification that closed
it; this section summarises what changed and how it was proven. 53 of the 54
findings are fixed and verified in this repository. The remaining four plan
items (MFA, rate limiting, secure token storage, session/device controls) are
recorded as production hardening, deliberately out of pilot scope, with the
reason on the checklist row.

**How the pass was run.** The PDF's own plan became the work order: emergency
workflow first, then availability truth, then the shared pickers, mobile
navigation, maps, inbox, admin, privacy, and release hygiene last. Each phase
ended in a verification step before the next began — either a backend test or a
browser harness assertion, never "looks right in the browser".

**Phase 1, emergency workflow.** The dispatcher's incident workspace gained the
crew half of the decision: a ranked unit list (capability match → free → crewed
→ distance), a unit preview with registration, operator, linked crew, status and
GPS-fix age, a manual picker of every unit in scope, and a confirmation step in
front of every commit. Overriding the engine — or requiring a unit that is not
free — is a typed-reason dialog, and the reason lands in the audit trail against
the operator's account. Committing with no free unit anywhere no longer echoes
the engine's verbatim line: the console re-reads the fleet and rebuilds the
sentence with real counts, picker open beside it. The queue gained a fleet
board: stage counts, a schematic fleet map coloured by trip stage with the
freshness ring explained, and GPS age on every row.

**Phase 2, availability truth.** Duty is now computed on read everywhere
(`duty_state`, signed `minutes_remaining`), the roster sweep runs on a loop, and
the roster editor's rows carry the same presence badge the public directory
shows — including the awkward case where the stored flag is still up after the
window closed, which the row now says out loud. Shift windows are a picker of
six patterns; the free-text box that produced unparseable rosters is gone.

**Phase 3, one picker everywhere.** `DistrictPicker`/`FacilityPicker` are the
only facility choosers left: the admin account form (which used to expose 14 of
152 facilities with no hint there were more), the connector form (152 chips in a
horizontal scroll), and the directory's own district control all use them. The
picker searches name, code and district, offers district chips with counts, and
states when it is showing a subset. The ICU facet count is computed over the
list the facet will act on, and every filter chip now carries a count.

**Phase 4, mobile and confirmations.** The phone shell keeps four primary
destinations plus a "More" sheet that reaches Account, Analytics and
Operations. The directory opens list-first on a phone. Every destructive or
consequential action — disable account, release crew, activate or stand down a
surge, commit, re-route — now passes through one shared confirmation component;
the override variant refuses to fire until a reason of at least twelve
characters exists.

**Phase 5, maps.** The keyed map fits its camera to whatever it is showing and
re-fits when the set changes, clusters pins by screen distance with count
labels and worst-state colour, and draws freshness as the pin outline so
capacity and report age stay two separate statements. The schematic fallback
gained the same split in its legend. The tap instruction matches the gesture on
each platform.

**Phase 6, inbox into workflow.** A ward's inbound alert carries "Review
inbound case" into the dashboard with the queue highlighted; a crew alert
carries "Open assignment" into the crew screen. Answering an alert marks it read
and attributed, so unread counts stop counting handled work.

**Phase 7, admin.** Accounts are editable in place — name, email, role,
facility, district, vehicle — with the creation scope rules re-enforced on every
edit and vehicle re-linking releasing the previous crew in the same transaction.
Fleet rows show GPS age instead of a raw timestamp. The audit trail pages with
an honest total. Complaints close through a real decision: upheld, dismissed or
under review, with the reviewer's note stored on the report.

**Phase 8, privacy.** Anonymous feedback carries the category only. Signed-in
notes are short and refused — not silently redacted — when they match a phone
number, an email, a digit run, an age or a named patient. The audit trail no
long carries free text: the note lives on the report, the audit carries ids,
kind and decision.

**Phase 9, release hygiene and verification.** `tools/package-release.sh`
stages a source-only archive and refuses to zip it if any of `.env`, `*.db*`,
`node_modules`, `.expo`, `.android`, `dist`, `dist-gmaps` or a keystore
survives; `.env.example` is asserted present. The verification matrix at the end
of this report is the closing evidence for the phase.

**Bugs the pass uncovered that were not in the PDF.** The demo control-room
loop logged a shortlist key that never existed, so every simulated commit ran
silently with its log line swallowed by the tick's own exception handler. The
re-route endpoint silently ignored a client-sent crew id — a console could
believe it had re-crewed a moving vehicle; it now refuses with the reason, and
the console only sends the crew choice on the commit path. A declined-facility
re-route refusal surfaced as a bare error banner instead of the override dialog
its own payload described.

## 5a. The third audit — pickers, 108 intake, crew lifecycle

The reviewer walked the running app a third time. The headline finding was that
the second pass's own checklist overclaimed: "one reusable searchable picker
everywhere" was contradicted by four screens that still rendered district
choice as a segmented control, a button row, or an eight-chip shortcut hiding
30 of 38 districts. The instruction was explicit — fix the code first, then
correct the documents — so three new harnesses were written *before* the fixes,
every fix was proven by a failing check going green, and both this report and
`AUDIT-CHECKLIST.md` were re-synced against the code afterwards.

**Must-fix 1–8, one picker truly everywhere.** `DistrictPicker` now backs every
district choice in the product: onboarding (was a 38-button row), admin
create-user and edit-user (were segmented controls), fleet create, fleet
filter and fleet edit, the doctors screen, and the directory's
`FacilityPicker` (whose eight-district chip shortcut is gone, replaced by
"Search facility or district" + an "All districts ▼" picker). The pickers are
semantically different where the choices are: the fleet *filter* offers
"All districts · 54 units" and clears, while the fleet *form* has no "All" row
— a vehicle must belong somewhere. Counts are per surface: facilities on the
admin forms, units on fleet, clinicians on doctors ("All districts — 1069
doctors"), and the admin user form is role-explicit — hospital admins see
Facility only (no district field), dispatchers and gov see Jurisdiction,
drivers see Reporting district plus a vehicle picker.

**Must-fix 9–12, behaviour under test.** The 108 intake now asks "How do you
know the location?" as an explicit four-way choice — caller location, device
location, map pin, or district centre — with the first three badged ● EXACT and
the fallback ○ APPROXIMATE, which stores `location_approximate=true` and raises
a warm banner in the incident workspace ("confirm the address with the caller
before committing a unit"). A district centre can no longer be dispatched as if
it were a doorstep. `probe-pickers.mjs` creates a real incident per source from
a cold dispatcher session and asserts the stored fields server-side.
`probe-crew-lifecycle.mjs` walks the driver from dispatch to handover, and at
every stage it advances, verifies server-side, verifies the crew screen's
dominant state band, **reloads the whole app**, and verifies the band survived
the cold start — then asserts the standby receipt (last trip reference,
handover time) and the GPS limitation label ("Live GPS while trip screen is
active", kept per the audit's own instruction). Duty expiry across `duty_end`
is enforced on read and covered by backend tests.

**Polish 13–20.** The driver's current state is a full-width band at the top of
the crew screen ("Transporting patient", "At hospital, handing over") — the
buttons carry the next action, never the state. Fleet rows show GPS as an age
("LAST POSITION · 12 h ago", warm past ten minutes). Doctor cards carry the
filled/hollow `DutyBadge` (colour-blind safe) with countdown and an explicit
OFF DUTY — SHIFT ENDED. The shell keeps "connection" and "data age" as two
separate statements. Every destructive or consequential button now passes a
confirmation dialog — including two this audit added: **cancel call** (names
both costs: the crew stood down and the bed hold released) and **roster
removal** (names the dispatch consequence, offers End duty as the reversible
alternative). `probe-mobile-widths.mjs` measures 12 surfaces at 360/390/430 px
plus Tamil at 360 and fails on any horizontal overflow; it caught two real
bugs, both fixed — the console candidate stat row (React Native Web's default
`flexShrink: 0` refused the parent's wrap until the row got
`flexBasis: 0, flexShrink: 1, minWidth: 0`) and the admin users table (a
five-column row needs ~400 px minimums, so on phones it renders as a stacked
two-line card with a count strip instead of column headers).

**21–22.** All nine browser harnesses were re-run green against the final
build, and both documents were corrected to match the code — the checklist's
picker rows now say what `probe-pickers` actually asserts, and this section
exists because the previous ones described a product that was one audit behind.

## 6. Verification

```bash
cd backend  && python3 -m pytest tests -q            # 84 passed, 1 skipped
cd mobile   && npx tsc --noEmit                      # clean
cd tools/qa && node sweep.mjs                        # 32 route × viewport, 0 problems
cd tools/qa && node surfaces.mjs                     # all surfaces verified
cd tools/qa && node maps.mjs                         # Google Maps integration verified
cd tools/qa && node probe-admin.mjs                  # admin panel verified
cd tools/qa && node probe-console-crew.mjs           # console crew workflow verified
cd tools/qa && node probe-inbox-shell.mjs            # inbox and shell verified
cd tools/qa && node probe-pickers.mjs                # pickers + 108 location sources verified
cd tools/qa && node probe-crew-lifecycle.mjs         # crew lifecycle verified (refresh at every stage)
cd tools/qa && node probe-mobile-widths.mjs          # all width checks passed (360/390/430 + Tamil)
./tools/package-release.sh                           # source-only archive, or refuses
```

The API suite covers the paths that matter operationally, not line coverage:
quarantine of impossible updates, facility-scope RBAC, quick-adjust clamping,
the full dispatch→hold→handover lifecycle, re-route releasing the old hold, the
catchment regression, identifier rejection in incident notes, jurisdiction
scoping, WebSocket snapshot-then-delta, concurrent holds on a contested bed, the
publication gate, road distance outranking straight-line distance, graceful
routing failure, the prefilter, cache TTL separation, statewide district
coverage, and the performance budget.

Several tests were confirmed to have teeth by reverting the fix and watching them
fail — the routing ranking test, the reference-collision tests, and the
verification-gate test were each checked this way rather than assumed.

The browser harnesses drive the real sign-in form as each pilot role in a
separate context, and assert on what a person would see: every surface fits its
viewport without horizontal scroll, the bottom bar stays pinned on a phone, enum
names never reach the screen, the Tamil interface is genuinely translated, the
map labels its facilities, each shortlist candidate says whether its ETA came off
the road network, both CSV exports produce an actual file, and no uncaught
console error occurs anywhere in the run.

The second audit added three focused harnesses. `probe-console-crew.mjs` works
the dispatcher's crew workflow end to end — picker, preview, confirmation, the
stand-the-fleet-down state — and plants its own outages through the fleet API,
restoring them in a `finally` so a crash can never leave the pilot fleet stood
down. `probe-admin.mjs` asserts each admin fix against the behaviour the audit
described: a searchable 152-facility selector, an audit window that says how much
is left, a complaint form that asks what the reviewer found. `probe-inbox-shell.mjs`
covers the inbox-to-workflow handoffs and the two shell statements — "Pilot
dataset", and the separation of connection state from data age. The Google Maps
harness grew assertions for camera fit and clustering, checked against a stub
that records what the map was asked to do.

The third audit added three more, each written before the fix it verifies.
`probe-pickers.mjs` signs every role in cold and asserts the searchable picker
on all eight converted surfaces — including that no legacy segmented or
38-chip row survives — then creates a real 108 incident per location source
and checks the stored `location_source`/`location_approximate` server-side.
`probe-crew-lifecycle.mjs` releases its test unit through any leftover trip
first (the simulator and previous runs leave units mid-job), dispatches with a
retry loop that only accepts its own unit, and then walks the seven crew
stages with a full app reload between each assertion. `probe-mobile-widths.mjs`
measures twelve surfaces at 360, 390 and 430 px — plus the Tamil interface at
360 — and fails on any element wider than its viewport.

Four of the audit's findings were caught by these harnesses rather than by
reading, and two of the harness failures were bugs in the harness — a ward
session asserting on another facility's screen, and a crew fixture that assumed a
unit was free. Both are fixed where they belonged, which is the point of having
them: the suite is allowed to be wrong about the product, and is not allowed to
stay wrong. The width harness paid for itself immediately: it found the
candidate stat row and the admin users table overflowing at 360 px after every
human-sized viewport looked fine, and the lifecycle harness found that a
handover correctly *ends* the trip — the crew screen stands by with a receipt
rather than showing a stage band, which the first draft of the harness wrongly
asserted against.

---

## 7. Continuous integration

`.github/workflows/ci.yml` runs three jobs on push and pull request:

1. **Backend** — the 84-test suite. Seeds its own database at a temp path and
   disables the simulator, so it needs no services and is order-independent.
2. **Frontend** — typecheck, then a web export **without a Maps key**, then an
   assertion that no `AIzaSy…` string appears anywhere in the public bundle.
   `EXPO_PUBLIC_*` variables are inlined at build time and readable by anyone who
   loads the page; a key leaking into a public artefact is the single most
   expensive mistake available in this project, so CI fails on it.
3. **Browser** — boots the API and both preview servers (the keyless build on
   8080, plus a second export built with a deliberate dummy key on 8081 that
   the maps harness stubs — no request leaves the runner), installs Playwright,
   runs all nine harnesses, uploads screenshots as artefacts.

Notably absent: lint and coverage gates. The failures that have actually hurt
this project were structural — a ranking that ignored road distance, an allocator
that could hand out a duplicate reference, a map that drew no labels — and every
one was caught by an assertion about behaviour. Style rules would not have
caught any of them.

---

## 8. Android build

`ANDROID_BUILD.md` covers EAS Build and the local Gradle path. Verified by
running: `expo prebuild` generates `android/` with package `in.medmesh.app`; the
Maps key wiring works (with `MEDMESH_GOOGLE_MAPS_ANDROID_KEY` set the manifest
carries `com.google.android.geo.API_KEY`, with it unset the entry is **absent
entirely** rather than a placeholder that fails at runtime); `react-native-maps`
autolinks; Gradle 9.3.1 demands JVM 17.

A completed `assembleDebug` was **not** achieved here — the environment has two
cores and the first build spent twenty minutes downloading artifacts before it
was stopped. That is stated plainly in the document rather than implied
otherwise. EAS Build is the recommended route and produces a signed artefact.

---

## 9. Known limitations

Recorded rather than discovered later.

**Not implemented**

- **Offline / SMS / IVR fallback** — the report's §7 item. The crew screen caches
  its last assignment and prints the age of the cached counters at the size of
  the counters, because that number is what a crew plans around; but there is no
  SMS or IVR channel for facilities and callers without data. This is the only
  genuinely unimplemented §7 item.
- **Background location is deliberately not used.** The crew app reports its
  position only while the trip screen is open. Continuous background GPS costs
  battery, needs the "always" permission tier, and would need to survive a
  handset the driver has pocketed — which is a worse trade in a pilot than the
  coverage it buys. The consequence is honest and stated in the code: a fix is
  reported while somebody is looking at the screen, and the age of the last one
  is on that screen.
- **Real PostgreSQL and Redis** — deferred by your instruction. SQLite/WAL now;
  `MEDMESH_DATABASE_URL` switches it, and the window-function query in
  `repository.py` carries its `DISTINCT ON` variant in a comment. `LiveStore` is
  an interface-compatible stand-in for Redis pub/sub; swap the class and nothing
  above it changes.

**Deliberate pilot-stage trade-offs**

- **Maps fall back to a schematic renderer without a key.** The routing path is
  fully wired and tested through a stubbed provider, but the preview ships
  keyless. Set `MEDMESH_GOOGLE_MAPS_SERVER_KEY` (server, IP-restricted) and
  `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` (browser, referrer-restricted) — these must
  be two different keys, because a browser key must be public to work and a
  public key with Distance Matrix enabled is an open billing account.
- **Tokens in AsyncStorage, not the device keychain.** Readable on a rooted
  device. Production moves to SecureStore and shortens the access-token TTL.
- **No rate limiting, MFA or lockout.** `auth.py` notes where the API gateway
  takes over.
- **Operational consoles are English-only**, per the safety argument above.
- **Facility data is synthetic.** See §2. Since the second audit it is also
  labelled: every shell carries a "Pilot dataset" strip stating the figures are
  simulated and describe no real patient or facility, fetched from the
  unauthenticated status endpoint so it shows before sign-in as well as after.

---

## 10. Repository

Initialised locally, 226 tracked files, `.gitignore` covering build artefacts,
databases, native projects and credentials. A sanity check confirms no
`node_modules`, database, key or keystore is staged, and
`tools/package-release.sh` re-asserts the same list on every archive it builds.

**I do not have the repository URL** — you selected "I'll paste it now" but the
link did not come through. Send it and I will push, or tell me to add a remote and
you can push yourself:

```bash
cd /home/user/medmesh
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

## 11. Running it

```bash
cd backend && bash setup.sh && python3 -m uvicorn app.main:app --port 8000
cd mobile  && bash setup.sh && npx expo start
```

Pilot accounts are listed on the sign-in screen. The public directory needs no
account.
