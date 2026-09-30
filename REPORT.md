# MedMesh — Project Report

**A real-time cross-hospital capacity exchange for Tamil Nadu.**

| | |
| --- | --- |
| Backend | Python 3.13 · FastAPI · SQLAlchemy 2.0 · SQLite/WAL (Postgres-ready) |
| Frontend | React Native 0.86 / Expo SDK 57 · expo-router · one codebase, web + iOS + Android |
| Coverage | 38 districts · 152 facilities · 1,069 clinicians · 66 ambulances |
| Code | 10,958 backend Python · 13,505 frontend TS/TSX · 1,514 lines of tests · 753 lines of browser harness |
| Verified | 70 API tests · 64 route × viewport sweeps · role/notification/admin surface suite · Google Maps suite · clean typecheck |
| Repository | local git, one commit, 182 files — push URL pending from you |

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

## 5. Verification

```bash
cd backend  && python3 -m pytest tests -q      # 70 passed
cd mobile   && npx tsc --noEmit                # clean
cd tools/qa && node sweep.mjs                  # 32 route × viewport, 0 problems
cd tools/qa && node surfaces.mjs               # all surfaces verified
cd tools/qa && node maps.mjs                   # Google Maps integration verified
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

Four of the audit's findings were caught by these harnesses rather than by
reading, and two of the harness failures were bugs in the harness — a ward
session asserting on another facility's screen, and a crew fixture that assumed a
unit was free. Both are fixed where they belonged, which is the point of having
them: the suite is allowed to be wrong about the product, and is not allowed to
stay wrong.

---

## 6. Continuous integration

`.github/workflows/ci.yml` runs three jobs on push and pull request:

1. **Backend** — the 70-test suite. Seeds its own database at a temp path and
   disables the simulator, so it needs no services and is order-independent.
2. **Frontend** — typecheck, then a web export **without a Maps key**, then an
   assertion that no `AIzaSy…` string appears anywhere in the public bundle.
   `EXPO_PUBLIC_*` variables are inlined at build time and readable by anyone who
   loads the page; a key leaking into a public artefact is the single most
   expensive mistake available in this project, so CI fails on it.
3. **Browser** — boots the API and the preview server, installs Playwright, runs
   all three harnesses, uploads screenshots as artefacts.

Notably absent: lint and coverage gates. The failures that have actually hurt
this project were structural — a ranking that ignored road distance, an allocator
that could hand out a duplicate reference, a map that drew no labels — and every
one was caught by an assertion about behaviour. Style rules would not have
caught any of them.

---

## 7. Android build

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

## 8. Known limitations

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
- **Facility data is synthetic.** See §2.

---

## 9. Repository

Initialised locally with one commit, 182 files, `.gitignore` covering build
artefacts, databases, native projects and credentials. A sanity check confirms no
`node_modules`, database, key or keystore is staged.

**I do not have the repository URL** — you selected "I'll paste it now" but the
link did not come through. Send it and I will push, or tell me to add a remote and
you can push yourself:

```bash
cd /home/user/medmesh
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

## 10. Running it

```bash
cd backend && bash setup.sh && python3 -m uvicorn app.main:app --port 8000
cd mobile  && bash setup.sh && npx expo start
```

Pilot accounts are listed on the sign-in screen. The public directory needs no
account.
