# MedMesh — end-to-end UX + workflow hardening pass

Working checklist for `problem_new.pdf` (54 findings + release hygiene + a
70-step prioritised plan). Every row below was either fixed and verified, or
recorded with the reason it is deliberately out of pilot scope. Verification
means one of: the backend suite (`backend/tests/test_api.py`, 83 tests), or one
of the six browser harnesses in `tools/qa` (`surfaces`, `sweep`, `maps`,
`probe-admin`, `probe-console-crew`, `probe-inbox-shell`), or `tsc --noEmit`.

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
- [x] Backend suite green — 83 passed, 1 skipped (fixture-conditional), 2
      Starlette deprecation warnings.
- [x] All browser harnesses green — `surfaces`, `sweep`, `maps` (keyed build),
      `probe-admin`, `probe-console-crew`, `probe-inbox-shell`.
- [x] All 38 districts present and selectable — picker chips + searchable
      picker; dataset asserts 38 districts.
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
