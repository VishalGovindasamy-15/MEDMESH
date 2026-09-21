# MedMesh

Real-time healthcare capacity exchange — Python backend, React Native (Expo) frontend.

Reference implementation of the architecture in `MedMesh_Architecture_Report.pdf`: a
shared live capacity layer that sits *alongside* hospital systems rather than
replacing them, and exposes bed / ICU / ventilator / ED / specialist availability
to emergency dispatch, citizens, hospitals and government.

---

## Running it

**Two processes.** The API must be up before the app makes sense.

```bash
# 1 — backend (FastAPI + SQLite, self-seeding)
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000

# 2 — frontend (Expo / React Native — one codebase, web + iOS + Android)
cd mobile
npm install
npm run web            # browser  → http://localhost:8081
# or
npm start              # Expo Go / simulator: scan the QR code
```

Then open the app. The public directory needs no account. For the operational
surfaces, `/sign-in` lists five one-tap pilot accounts (dispatcher, hospital bed
control, ambulance crew, district officer, platform admin).

### Cross-platform networking

The API client resolves its base URL per platform (`src/api/client.ts`):

| Where the app runs | How it reaches the backend |
|---|---|
| Web (browser) | Same origin — relative `/api`, so it works behind any proxy or tunnel |
| iOS simulator | `http://localhost:8000` |
| Android emulator | `http://10.0.2.2:8000` |
| Physical device (Expo Go) | The host machine's LAN IP, derived from the Metro bundler URI |
| Anything else | Set `EXPO_PUBLIC_API_URL=http://host:8000` |

### Preview server (optional)

For a single origin that serves the built web app and proxies the API and
WebSocket — useful behind a sandbox or tunnel where `localhost:8000` is not
reachable from the browser:

```bash
cd mobile && ./setup.sh                      # installs deps, exports dist/ with --clear
cd ../tools && node preview-server.mjs      # http://localhost:8080
```

> `mobile/setup.sh` exists because `EXPO_PUBLIC_*` variables are **inlined into
> the bundle at build time**, and Metro's cache key does not reliably include the
> environment. Exporting once with a Maps key and once without can ship the first
> key in the second build. Always exporting with `--clear` makes the bundle a
> function of the current environment, which is the property that matters.

### Android

See **[ANDROID_BUILD.md](ANDROID_BUILD.md)** for the APK path — EAS Build or a
local `gradlew assembleRelease`, Maps-key restriction by package name and SHA-1,
and the pre-flight checks worth running before handing a build to a hospital.

---

## What is actually implemented

### Backend — `backend/app/`

| Module | Responsibility |
|---|---|
| `services/trust.py` | Freshness bands + anomaly screen. Impossible updates are **quarantined**, not published. Trust score is explainable — every factor carries a signed, displayable delta. |
| `services/matching.py` | Capability-first ranking over 6 weighted factors, with holds deducted, an ED-congestion penalty, and a **priority-scaled catchment** so a trauma centre four hours away cannot outrank one twelve minutes away. |
| `services/triage.py` | Structured, non-identifying incident intake. Rejects anything shaped like an identifier, so the zero-PHI claim holds at the API boundary and not merely in the schema. |
| `services/reservations.py` | The bed-hold critical section: per-facility lock plus `SELECT … FOR UPDATE`, so two dispatchers racing for the last ICU bed produce one hold and one clear refusal. |
| `services/geo.py` | Haversine, ETA estimation, deterministic route corridors. Single seam where Google Directions / Distance Matrix drops in. |
| `services/connectors.py` | Hospital integration: key issue/rotate, health classification from last-seen and last-status, and the canonical FHIR mapping that vendor adapters normalise into. |
| `services/notifications.py` | Facility- and user-addressed alerts, staleness sweep, retention. The two-way prep alert rides on this. |
| `services/audit.py` | Append-only attribution for every capacity report, dispatch, verification decision and account change. |
| `live.py` | In-memory capacity projection + pub/sub fan-out. Interface-compatible with a Redis implementation. |
| `routers/dispatch.py` | Incident intake → ranked shortlist → commit → bed hold → two-way alert → re-route → handover. |
| `routers/governance.py` | Complaints loop, audit queries, user administration, estate health. |
| `simulator.py` | Connector simulator + workflow driver, so the dashboards show movement without anyone clicking. Includes deliberate anomaly injection so the quarantine path is exercised rather than assumed. |
| `seed.py` | Six districts, 29 facilities, 165 clinicians, 17 vehicles, 5,220 historical capacity records. |

Endpoints follow §12 of the report; full interactive reference at `/docs`.

### Frontend — `mobile/`

One Expo Router codebase, two layout modes:

* **`< 620 px`** — phone: single column, bottom tab bar, full-bleed lists, large tap targets
* **`620–1024 px`** — tablet: two-column card grids
* **`>= 1024 px`** — desktop: persistent left rail, multi-column operational layouts

| Route | Surface | Who |
|---|---|---|
| `/` | Public capacity directory — map, filters, live counts | anyone |
| `/facility/[id]` | Facility detail, roster, trust breakdown, 24 h history | anyone |
| `/doctors` | Specialist cover, grouped by facility | anyone |
| `/sign-in` | Staff sign-in + one-tap pilot accounts | anyone |
| `/console` | 108 incident queue, intake, fleet | dispatcher |
| `/console/[id]` | Incident workspace — ranked shortlist with reasons, commit, holds, re-route | dispatcher |
| `/dashboard` | Hospital portal — quick-update keypad, roster, inbound alerts | hospital_admin |
| `/crew` | Crew app — destination, route, capacity on arrival, one-tap re-route, offline cache | driver |
| `/analytics` | District rollup, SLA, surge control, CSV export | gov_official |
| `/analytics/[district]` | District detail, trend, per-facility drill-down | gov_official |
| `/account` | Session, role capability, platform health, connection diagnostics | any signed-in |

---

## Design decisions worth knowing about

**No patient data, structurally.** The schema has no patient table, no MRN, no
diagnosis field and no free-text clinical column. Incident notes are validated
against identifier patterns at the API boundary; the clinical "notes" that do
exist are non-identifying triage categories. This is enforced by the shape of the
data model, not by policy — a future feature cannot leak PHI through a column
that does not exist.

**Trust is explainable or it is not shown.** Every score decomposes into signed
factors the UI renders verbatim ("Data freshness +16", "Manual entry −6"). An ops
lead asking "why is this hospital at 61?" gets an answer, not a number.

**Holds are deducted from what everyone sees.** A bed promised to an inbound
ambulance is not available, and the public figure reflects that immediately.

**Reachability beats raw capability.** A more capable facility two hours away is
not a better destination. The catchment rule excludes distant candidates *only
when something nearer can take the patient* — otherwise it presents them as an
explicit last resort with a warning attached.

**Quarantined updates are stored, not dropped.** They are evidence, and the
hospital that submitted one is told why it was withheld.

**Nothing is hidden behind a README.** The pilot accounts are on the sign-in
screen; the API has a plain landing page listing what is live; `MEDMESH_*`
environment variables cover every tunable.

---

## Verification

```bash
cd backend && python3 -m pytest tests -q      # 26 tests
cd mobile  && npx tsc --noEmit                # 0 errors
cd tools/qa && node sweep.mjs                 # 31 route × viewport combinations
cd tools/qa && node maps.mjs                  # Google Maps integration, 17 checks
cd tools/qa && node surfaces.mjs              # role-scoped surfaces, per-viewport fit
```

The API suite covers the paths that matter operationally rather than chasing line
coverage: quarantine of impossible updates, facility-scope RBAC enforcement,
quick-adjust clamping, the full dispatch→hold→handover lifecycle, re-route
releasing the old hold, the catchment regression, identifier rejection in
incident notes, jurisdiction scoping of analytics, WebSocket snapshot-then-delta,
concurrent holds on a single contested bed, and the publication gate that keeps
unverified and suspended facilities out of the public directory.

Two of them exist because of a bug found in the ingest simulator's log rather
than in a test: incident references are three characters from a 24-symbol
alphabet, which is 13,824 values per day, and both the console and the simulator
were drawing from that space blind. At a few hundred incidents a day the
birthday paradox makes a repeat near-certain; the unique constraint caught it,
and the resulting exception unwound out of the simulator's background loop. The
fix is a shared check-then-take allocator (`services/references.py`) that both
producers now use, and the two tests pin the behaviour down — one forces a clash
by pinning the random source, the other persists 200 allocations and asserts
they are all distinct. Both fail against the old code.

The browser harnesses drive the real sign-in form as each pilot role, in a
separate browser context per role, and assert on what a person would see: that
every surface fits its viewport without horizontal scroll, that the bottom bar
stays pinned on a phone, that enum names never reach the screen, that the Tamil
interface is genuinely translated, and that no uncaught console error occurs
anywhere in the run.

`docs/shots/` holds screenshots of every surface and viewport combination,
generated by the same harnesses — which is also the check that catches "it
typechecks but renders a blank screen".

---

## Known limitations

These are deliberate pilot-stage trade-offs, recorded here rather than discovered
later:

* **Tokens live in AsyncStorage, not the device keychain.** Readable on a rooted
  device. Production moves to SecureStore and shortens the access-token TTL.
* **No rate limiting, MFA or lockout.** `auth.py` notes where the API gateway
  takes over.
* **Maps fall back to a schematic renderer without a key.** Google Maps is
  wired across every surface (`components/MapSurface.tsx` picks the tile
  renderer when a key is configured and the labelled schematic otherwise), but
  the preview build ships without one, so the default screenshot set shows the
  schematic. Set `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` and rebuild for real tiles.
* **Routing uses the estimated ETA by default.** Google Directions is wired and
  drawn when `EXPO_PUBLIC_GOOGLE_MAPS_DIRECTIONS_KEY` is set; without it the ETA
  comes from `services/geo.py` and is labelled an estimate. A self-hosted OSRM
  instance is the intended production path.
* **SQLite by default.** Set `MEDMESH_DATABASE_URL` to PostgreSQL; the
  window-function query in `repository.py` carries its `DISTINCT ON` variant in a
  comment.
* **Single-node pub/sub.** `LiveStore` is an interface-compatible stand-in for
  Redis pub/sub; swap the class and nothing above it changes.
* **Operational consoles are English-only.** The citizen surface is fully
  bilingual (English and Tamil) with voice search in both. Machine-translating a
  dispatch console is a patient-safety risk, so the consoles stay English until a
  human translation is commissioned.
* **No offline/SMS/IVR fallback yet.** The crew screen caches its last known
  assignment and shows a stale banner, but the report's §7 offline path — an SMS
  or IVR channel for facilities and callers without data — is not implemented.

---

## Environment variables

All prefixed `MEDMESH_` (`app/config.py`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `sqlite+pysqlite:///./medmesh.db` | Operational store |
| `JWT_SECRET` | dev placeholder | **Change before any deployment** |
| `FRESHNESS_LIVE_MINUTES` | `15` | Live band |
| `FRESHNESS_WARM_MINUTES` | `60` | Recent band |
| `ANOMALY_ABS_DELTA` | `12` | Absolute jump that triggers review |
| `ANOMALY_PCT_DELTA` | `0.45` | Relative jump that triggers review |
| `DEFAULT_HOLD_TTL_SECONDS` | `900` | Bed hold window |
| `SIMULATOR_ENABLED` | `true` | **Set `false` in production** |

Frontend variables are `EXPO_PUBLIC_*` and are **inlined at build time** — they
are not read at runtime, so changing one requires a rebuild. See
`mobile/.env.example` for the full set and the restriction each Google key needs.

---

## Layout

```
medmesh/
├── backend/
│   ├── app/
│   │   ├── models.py        operational schema — no patient fields by construction
│   │   ├── live.py          capacity projection + fan-out
│   │   ├── repository.py    read-side queries
│   │   ├── security.py      hashing, JWT, RBAC dependencies
│   │   ├── routers/         auth · hospitals · doctors · dispatch · analytics · governance · ws · connectors
│   │   ├── services/        trust · matching · triage · geo · audit · reservations · connectors · notifications
│   │   ├── seed.py          pilot dataset
│   │   ├── simulator.py     connector + workflow loops
│   │   └── main.py
│   └── tests/test_api.py
├── mobile/
│   ├── app/                 expo-router routes (file = route)
│   ├── app.config.ts        permissions, Maps keys, per-platform config
│   ├── eas.json             build profiles (development · preview · production)
│   ├── setup.sh             npm install + keyless `expo export --clear`
│   └── src/
│       ├── api/             client, platform-aware base URL, domain types
│       ├── components/      MapSurface · GoogleMap · MapCanvas · mapTypes · VoiceSearch
│       ├── lib/             format · maps · i18n (English + Tamil)
│       ├── state/           AuthProvider · LiveProvider · SessionGate
│       ├── theme/           tokens (single source of colour/type/space) + language
│       └── ui/              design system primitives
├── tools/
│   ├── preview-server.mjs   static dist/ + API/WS proxy, one origin
│   └── qa/                  setup.sh · sweep.mjs · maps.mjs · surfaces.mjs
├── docs/shots/              generated screenshots
└── ANDROID_BUILD.md         APK / AAB build guide
```

---

## Where the map ends up

Every surface that shows geography goes through one component,
`src/components/MapSurface.tsx`. It is the only place that decides between a real
tile renderer and the schematic canvas, and the only place that decides whether to
draw a route corridor — which matters, because a corridor drawn beside a real road
route is a lie about precision.

Callers pass `MapPoint`s: an id, a label, a coordinate, and optionally a live
capacity and a bed count. That is deliberately a smaller type than `Facility`.
Several screens legitimately map something that is not a facility — a shortlist
candidate, a crew's destination — and when the map demanded the full record, those
screens had to invent the missing fields, and one of them crashed on the invented
data. Declaring the real requirement removed the class of bug rather than the
instance.

Pin colour comes from the same vocabulary as the status dots elsewhere: green for
ICU free, amber for beds without critical care, red for at capacity, grey for no
recent report. Grey rather than red is deliberate — a facility that has not
reported is not in trouble, and the interface should not imply that it is.
