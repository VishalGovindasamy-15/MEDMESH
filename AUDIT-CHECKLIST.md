# MedMesh — end-to-end UX + workflow hardening pass

Working checklist for `problem_new.pdf` (54 findings + release hygiene + a
70-step prioritised plan) and the third re-audit (22 findings, tracked in the
final section). Every row below was either fixed and verified, or recorded with
the reason it is deliberately out of pilot scope. Verification means one of:
the backend suite (`backend/tests/test_api.py`, 84 tests), or one of the nine
browser harnesses in `tools/qa` (`surfaces`, `sweep`, `maps`, `probe-admin`,
`probe-console-crew`, `probe-inbox-shell`, `probe-pickers`,
`probe-crew-lifecycle`, `probe-mobile-widths`), or `tsc --noEmit`.

Legend: `[x]` done and verified · `[~]` done partly / deliberately scoped ·
`[ ]` not started · `n/a` not applicable, with the reason.

---

## Release hygiene (audit §"Release hygiene issue")

- [x] `backend/.env` excluded from any shared archive
- [x] `backend/medmesh.db` + `-wal` + `-shm` excluded
- [x] `mobile/.expo/`, `mobile/.android/`, `mobile/dist-gmaps/` excluded
- [x] `.gitignore` and a `tools/package-release.sh` that builds a clean archive
      — the script rsyncs to a stage, then *refuses* to zip if any forbidden
      name survives; verified by building `out/medmesh-release.zip` (13 MB,
      source only) and listing it.
- [x] `.env.example` is the only environment file shipped — asserted inside the
      script (archive aborts if `backend/.env.example` is missing).

---

## Phase 1 — Emergency workflow (P0 items 1–12, 29–36)

| # | Item | Status |
|---|------|--------|
| 2 | `/crew/assignment` active-stage query covers all live states | [x] |
| 3 | Driver "Accept & go" (DISPATCHED → EN_ROUTE) | [x] |
| 10 | Crew reroute hold resource derived from the incident | [x] |
| 1 | 108 new-incident flow: type → priority → location → create | [x] |
| 1a | "Create incident & find hospital" replaces "Run matching" | [x] |
| 1b | Scene assessment behind "Optional triage details" | [x] |
| 1c | Three obvious location controls + one-click district centre | [x] |
| 28 | Intake form progressive disclosure | [x] |
| 29 | Manual ambulance picker in the dispatcher | [x] |
| 30 | Ambulance preview before dispatch | [x] |
| 6/12 | Dispatch confirmation dialog | [x] |
| 11 | Override needs a typed reason, recorded in the audit | [x] |
| 31 | Stale "no ambulance" error message | [x] |
| 32 | Driver top-level state band | [x] |
| 33 | Driver GPS freshness | [x] |
| 34 | Dispatcher fleet map: trip stage, not just availability | [x] |
| 36 | Driver notification opens the crew screen | [x] |
| 9 | Duplicate crew call buttons removed | [x] |

Verification notes (Phase 1): `probe-console-crew.mjs` asserts the intake
controls, the fleet board's stage breakdown and GPS-ring legend, the crew
picker as accessible buttons with capability/availability labels, the unit
preview (registration, crew, GPS age, capability match), the commit
confirmation, and the "no free unit" state with the stale engine line absent
(it stands the whole fleet down through the fleet API and restores it in a
`finally`). The override contract is asserted server-side deterministically
(`test_a_blocked_facility_needs_a_typed_override_and_the_audit_keeps_it`,
`test_a_unit_that_is_not_free_is_refused_until_overridden`,
`test_a_reroute_cannot_swap_the_crew`) and in the browser whenever the live
case carries a declined/blocked row. #36: inbox rows for crew carry
"Open assignment" → `/crew`; the row only exists while an assignment alert is
live, and the crew screen itself is exercised by `maps.mjs`.

## Phase 2 — Doctor/availability correctness (items 4, 5, 23–27)

- [x] 5 · Duty expiry enforced on read (`duty_end > now`), not only by rollover
- [x] 5b · A scheduler actually runs the rollover (`roster_loop`, 300 s)
- [x] 4 · Explicit ON DUTY NOW / OFF DUTY on doctor cards (`DutyPresence.tsx`)
- [x] 4b · Duty countdown ("duty ends in 2h 18m")
- [x] 23 · Facility rows show doctor availability (`FacilityRow` on-duty line)
- [x] 24 · "Doctors on duty" states presence explicitly
- [x] 25 · "View all doctors" instead of a silent truncation at 8
- [x] 26 · Roster rows carry status, not only a toggle — rows now show the same
      `DutyBadge` the public directory uses, plus "roster flag still up, window
      closed" when the stored flag and the computed truth disagree; the toggle
      became explicit Start/End duty buttons.
- [x] 27 · Shift window is a picker, not free text — six preset shift patterns;
      the free-text box is gone.

## Phase 3 — One picker everywhere (items 13–21)

- [x] 19 · **Bug**: admin hospital selector exposes only the first 14 facilities
      — replaced by the shared searchable `FacilityPicker`; probe asserts
      "Choose from 152 facilities" and a search that narrows 152 → 5.
- [x] 13–18, 20 · One reusable searchable `DistrictPicker` / `FacilityPicker`
      everywhere — the picker now also carries district chips with per-district
      counts, and the connector creation form uses it instead of 152 chips.
      (Third-audit correction: this row was written before every district
      *selector* was converted — see the "Third re-audit" section, items 1–8.
      As of that pass the claim is true in code: `DistrictPicker` backs
      onboarding, admin create/edit user, fleet create/filter/edit, the doctors
      screen and the directory's `FacilityPicker`; no segmented or chip row of
      38 districts remains anywhere.)
- [x] 21 · **Bug**: ICU filter count computed from the unfiltered list — facet
      counts are computed over the district+search-scoped list (the list the
      chip will act on), and every chip now carries a count.

## Phase 4 — Mobile navigation & confirmations (items 6, 22, 38, 39, 45, 52)

- [x] 6 · Mobile navigation `slice(0, 5)` → a "More" sheet
- [x] 45 · Account reachable from "More"
- [x] 6b · Analytics/Operations reachable from "More"
- [x] 22 · Map does not dominate the phone screen — the directory opens with the
      list on phones; the map is one tap away and stays open on desktop.
- [x] 38 · Disable account confirmation — `ConfirmDialog`, danger tone, states
      what disabling costs before it happens.
- [x] 39 · Release crew confirmation — same, and says the vehicle becomes
      undispatchable.
- [x] 12/44 · Confirmations on destructive actions, surge, dispatch — dispatch
      and re-route confirm in the console; surge activation/stand-down behind a
      confirmation in analytics; account disable and crew release in admin.

## Phase 5 — Maps (items 7, 8, 48–50)

- [x] 7/48 · Google map auto-fits visible facilities, not Coimbatore —
      `fitBounds` over the visible points (plus the scene), re-fitted when the
      *set* changes, never on capacity ticks; single facility gets centre+zoom.
      `maps.mjs` asserts the stub recorded the fit.
- [x] 7b · District/search result re-fits — the fit key includes the point set.
- [x] 49 · Marker clustering — screen-distance clustering with count labels,
      worst-state fill, click-to-zoom; `maps.mjs` asserts 152 facilities render
      as fewer markers (78 at the test zoom).
- [x] 8 · Tap vs long-press instruction matches behaviour — the instruction is
      platform-aware: tap on web, press-and-hold on native, where the map view
      reserves taps for panning.
- [x] 50 · Legend separates capacity from freshness — two labelled groups
      ("Fill" / "Freshness"); pins carry capacity as fill and report age as the
      outline ring, on the schematic canvas and on tiles alike.

## Phase 6 — Inbox → workflow (items 35, 36, 43)

- [x] 35 · Hospital inbox → "Review inbound case" — lands on the dashboard with
      the inbound queue highlighted ("From your inbox — this is the case you
      opened"), or an honest "Nothing waiting at this desk" if it was already
      answered.
- [x] 36 · Driver inbox → "Open assignment" — lands on the crew screen.
- [x] 43 · Notification actions clear state after acting — answering an inbound
      alert from the dashboard marks that facility's inbound notifications read
      and attributed (`_ack_inbound_alerts`), so the unread count stops counting
      handled work.

## Phase 7 — Admin (items 37, 40–42)

- [x] 37 · Full user editing (name, email, role, hospital, district, vehicle) —
      edit panel in the users tab; `PATCH /governance/users/{id}` applies scoped
      edits (vehicle re-linking goes through `ambulances.driver_id`, releasing
      the previous crew in the same transaction) and re-enforces the creation
      scope rules on every edit; audited as one change list.
- [x] 40 · Fleet "last GPS" as an age, not a timestamp — "LAST POSITION · 12 h
      ago", warm-toned past ten minutes.
- [x] 41 · Audit pagination instead of a silent 250-row cap — the endpoint
      returns `total`/`offset`/`limit`/`has_more`; the panel pages locally in
      fifties and fetches older pages on demand, saying how many are left.
- [x] 42 · Complaint resolution form (outcome + notes) — upheld / dismissed /
      under review with a reviewer note stored on the report; the hard-coded
      "Confirmed against the facility bed-control desk" is gone.

## Phase 8 — Privacy (items 47, 53; 54–57 production list)

- [x] 47 · Feedback free text restricted / PII-blocked — anonymous reports carry
      the category only; signed-in notes are capped at 200 characters and
      refused (not redacted) when they match phone, email, digit-run, age or
      named-patient patterns, server-side, with the client mirroring the rule as
      a live warning.
- [x] 53 · Audit payloads carry no free text — the feedback note lives on the
      report row; the submit audit carries ids and kind only, the resolve audit
      carries the decision and a boolean "note on report".
- [~] 54–57 · MFA, rate limiting, secure token storage, session/device controls
      — deliberately out of pilot scope: these are deployment-side controls
      (identity provider, WAF/gateway, Keychain/EncryptedSharedPreferences,
      session store) listed in the architecture report's production hardening
      section. Nothing in the pilot pretends to provide them.

## Phase 9 — Verification & release

- [x] Frontend typecheck — `tsc --noEmit` clean.
- [x] Backend suite green — 84 passed, 1 skipped (fixture-conditional), 2
      Starlette deprecation warnings.
- [x] All browser harnesses green — `surfaces`, `sweep`, `maps` (keyed build),
      `probe-admin`, `probe-console-crew`, `probe-inbox-shell`,
      `probe-pickers`, `probe-crew-lifecycle`, `probe-mobile-widths`.
- [x] All 38 districts present and selectable — searchable `DistrictPicker` on
      every district-selection surface (onboarding, admin create/edit user,
      fleet create/filter/edit, doctors, directory via `FacilityPicker`);
      dataset asserts 38 districts; `probe-pickers` asserts the pickers and
      that no legacy segmented/chip row of districts remains.
- [x] Every role's workflow driven end to end — citizen/hospital/dispatcher/
      gov/admin across the harnesses; crew through `maps.mjs` and the crew
      probe.
- [x] Every stage of the incident lifecycle exercised — backend lifecycle tests
      plus the simulator's control-room loop committing real dispatches.
- [x] Report written — `REPORT.md`, section 5.

---

## Findings fixed outside the numbered list

- `_control_room_tick` logged `best["hospital_name"]`, a key the shortlist never
  had; the KeyError was swallowed by the tick's blanket except, so every demo
  commit happened silently with no log line. Now logs `short_name`/`name`.
- `POST /incidents/{id}/reroute` silently ignored a client-sent `ambulance_id`.
  A re-route moves the destination, not the crew; the endpoint now refuses a
  differing crew id with the reason, and the console only sends the crew choice
  on the commit path.
- A declined-facility re-route 409 (message + override hint, no blockers array)
  used to surface as a plain error banner; it now opens the same reasoned
  override dialog as every other refusal.
- `tools/qa/bootstrap.sh` and `tools/dev-up.sh` added: the harnesses and the
  whole stack rebuild from a clean container in two commands, in the order that
  works.

---

## Third re-audit (22 findings — pickers, 108 intake, crew lifecycle, polish)

The reviewer walked the running app a third time and found that the "one picker
everywhere" claim above was contradicted by four screens, that the 108 intake's
location entry let an approximate district centre be dispatched as if it were
exact, and that the driver app's state changes were legible only through button
labels. Every "must fix" and "polish" item is listed with the verification that
closed it. Three new harnesses were written for items 9–12 and 19–20 first, so
each fix below was proven by a failing check going green, not by inspection.

### Must fix — pickers (items 1–8)

- [x] 1 · Onboarding's 38-district button row → `DistrictPicker` (`hideAll`,
      facilities count) — `probe-pickers` walks the real onboarding flow.
- [x] 2 · Admin create-user district `Segmented` → `DistrictPicker`; the form is
      now role-explicit: hospital_admin sees **Facility only** (no district
      field), dispatcher/gov see **Jurisdiction**, driver sees **Reporting
      district + Vehicle picker**.
- [x] 3 · Admin edit-user district `Segmented` → `DistrictPicker` with facility
      counts ("Coimbatore · 12 facilities"); probe locates it by that text.
- [x] 4 · Fleet create-vehicle district selector → `DistrictPicker` ("Base
      district", units count, no "All" row — a vehicle must belong somewhere).
- [x] 5 · Fleet filter → separate control: `DistrictPicker` with `allowClear`
      ("All districts · 54 units" default). Filter and form are two different
      pickers with different semantics, as the audit demanded.
- [x] 6 · Fleet edit-vehicle district selector → `DistrictPicker` (`hideAll`,
      no count — the modal is about one vehicle, not a directory).
- [x] 7 · Doctors screen district selector → `DistrictPicker` with
      **clinician counts** ("All districts — 1069 doctors", "Coimbatore · 61
      doctors"); `countUnit` prop added for this.
- [x] 8 · Directory `FacilityPicker`'s 8-district chip shortcut → a real
      district selector inside the picker: "Search facility or district" input +
      "All districts ▼" `DistrictPicker`; the chips that hid 30 districts are
      gone.

### Must fix — behaviour tests (items 9–12)

- [x] 9 · Fresh-operator 108 creation → `probe-console-crew.mjs` signs a
      dispatcher in cold through the real sign-in form (fresh browser context,
      no stored token) and asserts the guided intake ("Create incident & find
      hospital", optional triage disclosure, one-click district) and a live TN
      reference in the queue; `probe-pickers.mjs` then creates real incidents
      through that intake — one per location source (item 10) — and asserts
      each lands server-side with the right fields.
- [x] 10 · 108 creation with all four location sources → the intake asks
      "How do you know the location?" explicitly: **Caller location / Device
      location / Drop map pin / District centre — approximate**. Each maps to a
      `location_source` (`manual`/`gps`/`map`/`district`) and the first three
      badge "● EXACT", the fourth "○ APPROX" + `location_approximate=true`, so a
      district centre can never be dispatched as if it were a doorstep.
      `probe-pickers` creates an incident per source and asserts the stored
      fields server-side.
- [x] 11 · Driver lifecycle dispatch → handover **with a full app refresh at
      every stage** → `probe-crew-lifecycle.mjs`: for each stage
      (dispatched → en_route → at_scene → patient_onboard → transporting →
      at_hospital → handed_over) it advances, verifies server-side, verifies the
      dominant state band without a refresh, reloads the app and verifies the
      band survived the cold start. After handover it asserts the standby
      receipt (last trip reference, handover time) and the GPS limitation label.
- [x] 12 · Doctor duty expiry after crossing `duty_end` → backend
      `test_a_duty_window_that_has_elapsed_is_not_availability` (duty computed
      on read; `duty_end` in the past ⇒ `duty_state='expired'`, excluded from
      matching and from "on duty now" counts) plus the roster sweep test.

### Polish (items 13–22)

- [x] 13 · Driver current state visually dominant — a full-width stage band at
      the top of the crew screen ("En route to scene", "Transporting patient",
      …) with the reference, the stage's own verb and the next action beneath;
      the buttons no longer carry the state.
- [x] 14 · Location-source UI — the explicit four-way choice of item 10; the
      ● EXACT / ○ APPROX distinction lives on the intake's capture card and in
      the chosen-location summary, and an approximate scene is restated as a
      warm banner at the top of the incident workspace ("Scene location is
      approximate — confirm the address with the caller before committing a
      unit"), so the distinction follows the call from intake to commit.
- [x] 15 · Fleet GPS freshness — fleet rows show "LAST POSITION · 12 h ago" as
      an age, warm-toned past ten minutes; the fleet map's freshness ring is
      labelled in the legend (`probe-admin` asserts the age format).
- [x] 16 · Doctor availability cards — `DutyBadge` with filled/hollow dot
      (colour-blind safe), ON DUTY NOW / OFF DUTY / OFF DUTY — SHIFT ENDED,
      countdown when on duty; the same badge on roster rows, facility rows and
      the public directory.
- [x] 17 · State vs freshness distinction — the shell separates "connection"
      (live/reconnecting) from "data age" (pilot dataset, last snapshot);
      capacity pins carry state as fill and report age as outline ring; trust
      chips say which factor is which (`probe-inbox-shell` asserts the two
      statements stay separate).
- [x] 18 · Destructive/consequential button review — every one now passes a
      `ConfirmDialog`: disable account, release crew, surge activate/stand-down,
      commit, re-route, override (typed reason), complaint resolve, **cancel
      call** (names both costs: crew stood down, bed hold released) and
      **roster removal** (names the dispatch consequence, offers End duty as
      the reversible alternative). Sign out stays one tap — it is destructive
      only to the session.
- [x] 19 · Mobile layout at 360/390/430 → `probe-mobile-widths.mjs` measures
      12 surfaces at all three widths plus Tamil at 360 and fails on any
      horizontal overflow. It caught two real bugs, both fixed: the console
      candidate stat row (RN-web's default `flexShrink: 0` refused the parent's
      wrap — now `flexBasis: 0, flexShrink: 1, minWidth: 0`) and the admin users
      table (a 5-column row needs ~400 px minimums — on phones it renders as a
      stacked two-line card with a count strip instead of column headers).
- [x] 20 · Tamil overflow after the new selectors — the same harness runs the
      directory, intake and crew screens in Tamil at 360 px; picker labels,
      stage bands and badges all fit (translations exist for every new string
      via `i18n.ts`).
- [x] 21 · Full browser harness re-run — all nine harnesses green against the
      final build (sweep: 32 route × viewport pairs; surfaces walked manually
      per role; maps against the keyed build).
- [x] 22 · `REPORT.md` matches the implementation — §5a (third audit) added,
      §6 verification matrix lists all nine harnesses and 84 backend tests.

### Kept, per the audit's own instruction

- [x] Driver GPS foreground-only limitation stays clearly labelled — "Live GPS
      while trip screen is active" on the crew screen and in the handover
      receipt (`probe-crew-lifecycle` asserts the string after every reload).

