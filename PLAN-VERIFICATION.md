# Plan verification — fourth audit round

Recorded 2026-10-04 against commit `4dcc351` on a **freshly seeded database**
(the previous demo DB was corrupted by a workspace rollback and deleted; the
API re-seeded on start: 38 districts, 152 hospitals, 1,069 doctors, 27,360
capacity records, 66 ambulances, 4 seed incidents, 4 connectors).

This document maps every section of the consolidated fix-and-verify plan to
the evidence that closes it, using **runs executed today on this tree** — not
results carried over from earlier sessions. The stance of the round is kept:
code was changed only where a test demonstrated a problem; everything below
either passes now or is recorded honestly as not-exercised-this-run with the
coverage that stands behind it.

**Evidence ledger (all fresh, all on `4dcc351` + fresh DB):**

| Run | Result |
| --- | --- |
| `pytest tests/` (backend) | **89 passed, 0 skipped** (25.9 s) |
| `bash tools/qa/plan-spotchecks.sh` (live API battery, new this round) | **45 passed, 0 failed** |
| `node probe-multiuser.mjs` (simulator OFF, six browser sessions, one backend) | **ALL-GREEN**, 97 s |
| Nine-harness browser matrix (simulator ON) | **9 / 9 PASS**, 715 s total |
| `tsc --noEmit` (mobile) | clean |
| `expo export --clear` ×2 + key-leak grep | keyless `dist/` contains no `AIzaSy…`; keyed build contains it |
| API log, simulator ON | 6 × `demo control room: TN-… committed to <facility> (<hold>)` observed |

---

## §1 — The P0 fixes, re-proven on the current tree

| # | Plan item | Where it lives | Test that owns it | Fresh proof today | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | WS deltas scoped per role **and per relationship** (driver sees only their trip, resolved per event; ward sees its facility's rows; surge stays ops+gov; unknown kinds fail closed) | `app/routers/ws.py` | `test_ws_incident_feed_gives_a_driver_only_their_own_trip`, `test_ws_notification_created_reaches_only_its_addressee` | Teeth re-checked this round: with the filter reverted to pass-through the two socket tests **fail**; restored they pass. Probe S1/S2/S4 show driver+ward receiving live, and only their own, events | ✅ |
| 2 | Re-route notifies both ends (new ward gets the prep alert with recomputed ETA; bypassed ward gets a durable "Destination changed" row; `incident.rerouted` carries previous hospital + released holds) | `app/routers/dispatch.py`, `models.py` (`DESTINATION_CHANGED`), `notifications.py` ("Destination changed" label) | `test_a_reroute_moves_the_hold_and_keeps_the_crew`, `test_a_reroute_cannot_swap_the_crew` | Probe S4 both legs: hold moved `[[2,"bed"]] → [[5]]`, bypassed ward got exactly 1 `destination_changed` row, self-declined KGCH got 0 rows, driver screen followed both legs without refresh | ✅ |
| 3 | Suite green with no skips | `tests/test_api.py` (4,254 lines) | the suite itself | 89 passed / 0 skipped, twice today (post-rebuild and post-verification) | ✅ |
| 4 | Incident export names cross-district destinations (hospital-name lookup unfiltered; jurisdiction belongs on the incident filter) | `app/routers/analytics.py` | `test_the_incident_export_names_a_cross_district_destination`, `test_the_incident_export_carries_the_officers_jurisdiction` | Battery: live gov export, **0 rows with an id but no name** across 26 rows (fresh DB is single-district today; the cross-district path is owned by the pytest) | ✅ |
| 5 | Simulator commits are labelled in the log so demo incidents are never mistaken for an operator's | `app/simulator.py` | observed-behaviour item | 6 labelled `demo control room: … committed to …` lines captured in today's API log | ✅ |
| 6 | Input validation & auth spot checks (bounds, illegal transitions, structured decline reasons, scoped writes, expired tokens) | routers + `schemas.py` | `test_a_decline_needs_a_reason`, `test_quick_adjust_applies_delta_and_clamps_at_zero`, `test_facility_scope_is_enforced` | Battery §"authentication"/"input validation": 16 live checks, all green (details in §2 below) | ✅ |
| 7 | No half-state after a **failed** dispatch (incident stays open, no assignment, no holds) | `app/routers/dispatch.py` | dispatch-guard tests incl. `test_a_blocked_facility_needs_a_typed_override_and_the_audit_keeps_it` | Battery: after the 409 out-of-service refusal the incident reads `open / None / 0 holds` | ✅ |
| 10 | Hold-picker segmented control clickable at desktop widths (`flexShrink+minWidth:0`, never `flexBasis:0` in column parents) | `src/ui/index.tsx` | probe S1 commits a real hold through the UI | Probe S1: bed hold `[[1,"bed"]]` created by clicking the picker | ✅ |
| 11 | Analytics actions row wraps at 360 px | `app/analytics/index.tsx` | `probe-mobile-widths` | Harness PASS today (`/analytics @430` + 360 px overflow checks) | ✅ |

Items 8, 9, 12 of the checklist are the probe, the harness ownership map and
the matrix itself — see §3/§4 below.

## §2 — Backend verification matrix (live battery, 45/45)

`tools/qa/plan-spotchecks.sh` (new, committed) runs 45 real requests against
the live API and self-cleans (incidents cancelled, capacity restored, units
released). Today's run: **45 passed, 0 failed**. Grouped:

- **Authentication (6):** wrong password 401 · garbage bearer 401 ·
  expired-shaped JWT 401 · missing token 401 · valid session 200 · `/auth/me`
  reports the true role.
- **Role & resource scope (10):** ward blocked from another facility's
  capacity write **and** hold (403 ×2) · dispatcher, ward, driver blocked from
  `/governance/audit` (403 ×3) · gov **allowed** `/governance/audit` (200 —
  by design: `require_roles(PLATFORM_ADMIN, GOV_OFFICIAL)`, the oversight
  role) · anonymous blocked from the queue (401) · gov blocked from creating
  incidents (403) · driver blocked from progressing an unassigned incident
  (404) and from progressing another unit's incident (404).
- **Input validation (10):** `lat 95` → 422 · `lng -200` → 422 · empty
  quick-adjust → 422 · overdraw quick-adjust → 200 with the written record
  **clamped to 0, never negative** · `open → handed_over` → 409 **listing the
  legal transitions** · dispatch precondition 200 · decline without reason →
  422 · free-text decline reason → 422 · structured decline → 200 · decline
  released the hold (`0`) and marked the facility ineligible (`[1]`), and the
  re-scored shortlist drops it.
- **Dispatch guards (5):** out-of-service unit → 409 · a hand-picked unit
  with the wrong capability is **not** silently accepted: it commits only
  with recorded accountability — `crew_notes.matched: false` and a warning
  naming what the unit carries vs what the incident asks (this is the
  designed override contract; hard 409s are reserved for units that are not
  free — pytest owns the override-reason path at L3875/L3963).
- **State after failure (1):** the refused dispatch left `open / no
  ambulance / no holds`.
- **Exports (9):** gov capacity + incidents exports 200 with
  `content-type: text/csv` and a server filename · capacity export >100 rows ·
  incidents export carries destination names, **0 blank names** · ward 403 on
  both exports · driver 403 · expired token 401.

Notes recorded honestly: a first battery draft produced false failures from
script bugs (wrong CSV column name, reading a clamp result after the
simulator had already overwritten it, ordering a zero-bed check before a
dispatch to that bed) — each was diagnosed against the code, the script was
corrected, and the corrected battery is what is committed. No product defect
was found by the battery; the two live behaviours that surprised the first
draft (gov audit access, manual-capability accountability) are documented
design, cited above with their guards.

## §3 — UI verification matrix (nine harnesses, 9/9 PASS, simulator ON)

| Harness | What it proves for the plan | Today |
| --- | --- | --- |
| `surfaces.mjs` | all five consumer surfaces render and act; both export buttons press and download; role refusals explained ("why Operations is closed to it"); no uncaught console errors | PASS |
| `sweep.mjs` | 32 route × viewport pairs clean, no broken routes, no overflow | PASS |
| `maps.mjs` (keyed build :8081) | route drawn, Google directions summary surfaced, navigation handoff correct, **maps failure told to the operator, not a blank box**, page still renders | PASS |
| `probe-admin.mjs` | admin edits real; fleet position shown as an **age**, not a raw ISO stamp; facility selector is a picker, not 152 chips | PASS |
| `probe-inbox-shell.mjs` | notification rows deep-link (`/dashboard?focus=inbound`); public shell clean; crew inbox renders | PASS (soft skip: no live crew alert at that moment — row not exercised; the crew-alert path is exercised by probe S1 and `probe-crew-lifecycle`) |
| `probe-pickers.mjs` | DistrictPicker everywhere; 108 location EXACT-vs-APPROXIMATE unmistakable; 360 px no overflow on /, /doctors, /onboard, /console, /admin | PASS |
| `probe-crew-lifecycle.mjs` | full crew progression survives refresh; dominant state band reads correctly at every stage; handover receipt names the hospital; **GPS foreground-only limitation stays labelled** | PASS |
| `probe-mobile-widths.mjs` | 360/390/430 px + Tamil rendering, no overflow anywhere | PASS |
| `probe-console-crew.mjs` | console crew workflow; with **no free unit** the console says so in its own words ("Choose a unit (0 free)"); stale engine lines not left on screen | PASS (soft skip: no declined/blocked row existed at that moment, so the override dialog click wasn't exercised this run; the override contract is owned by pytest L3875/L3906/L3963 and was click-verified in the probe's earlier green runs) |

Soft skips are the harnesses' own recorded `....` lines, not failures; both
skipped paths carry the coverage named beside them.

## §4 — Multi-user scenarios (probe-multiuser, simulator OFF, ALL-GREEN)

Six separate browser contexts through the real sign-in form, **one backend
process**, every scenario recording the four required outcomes (backend
response → stored state → initiator screen → other users' screens). Run
today in 97 s, all agree:

- **S1 intake→dispatch:** incident created, NICU unit offered and explicitly
  chosen, KGCH committed with bed hold `[[1,"bed"]]`, ward notification row
  in the DB; **driver and KGCH ward both see it WITHOUT refresh**.
- **S2 decline:** reason recorded (`no_icu`), hold released `[]`, KGCH left
  the eligible set, re-scored shortlist drops it; **dispatcher's untouched
  screen shows "Destination withdrawn"**.
- **S4 reroute ×2 legs:** leg 1 → SRMC: destination moved, crew unchanged,
  hold moved `[[2,"bed"]]`, new ward alerted, **self-declined KGCH asserted
  NOT notified (0 rows)**, driver's screen follows live. Leg 2 → MMCH: hold
  moved `[[5]]`, bypassed SRMC got its `destination_changed` row, driver
  follows again, KGCH inbox retains the original alert.
- **S5 concurrent assignment:** two dispatchers race the last free unit —
  **exactly one commit wins**, loser told "cannot be assigned", one live trip
  in the DB.
- **S9 failure & recovery:** offline intake **fails honestly** (banner, 19→19
  nothing created); retry under a double-click succeeds **exactly once**
  (19→20).
- **S10 exports:** gov session downloads both CSVs with server filenames.

Scenarios S3/S6/S7/S8 of the plan's ten are owned by the named harnesses per
checklist item 9 (crew lifecycle across refreshes, duty expiry, admin edits,
notifications acted on) — all re-run green today in §3.

## §5 — Limitations kept as documented, not bugs

Per the plan's own instruction these stand labelled in-product and in docs:
synthetic pilot data (label visible in-product) · no SMS/IVR · foreground-only
GPS (labelled on the crew screen — re-verified today by
`probe-crew-lifecycle`) · keyless map fallback (labelled; keyed build verified
separately) · single-process SQLite/in-memory fan-out (cross-worker live
updates are **not claimed** — the probe runs one backend, as the plan
requires) · English consoles (Tamil directory rendering verified, consoles
stay English) · Android package not established.

## §6 — Acceptance criteria verdicts

| Criterion | Evidence | Verdict |
| --- | --- | --- |
| Every button performs its stated action or is disabled-with-reason | surfaces + console-crew ("0 free" wording) + probe S1/S2 clicks | ✅ |
| Forms validate; success/failure understandable | battery §validation + surfaces refusal copy + S9 honest failure | ✅ |
| Role scoping enforced server-side (hiding buttons is not enough) | battery §scope (10 live 403/401/404s) + ws.py scoping + teeth check | ✅ |
| Incident→dispatch→response→crew progression→reroute→cancel→handover end-to-end | probe S1/S2/S4 + crew-lifecycle harness + battery cancels | ✅ |
| Other users see updates without unexpected refresh | probe S1/S2/S4 "WITHOUT refresh" assertions, single backend | ✅ |
| Refresh/reopen preserves server-backed state | crew-lifecycle refresh checks + probe stored-state reads | ✅ |
| Holds/capacity/notifications/audit consistent after success **and** failure | probe hold moves + battery no-half-state + decline-releases-hold + audit rows | ✅ |
| Search/filters/pickers/maps/roster/admin/exports correct | pickers + maps + admin harnesses + battery exports | ✅ |
| No uncaught UI errors, broken routes, mobile overflow | sweep 32 pairs + widths harness + per-harness console-error checks | ✅ |
| Demo data + unfinished integrations clearly labelled | simulator log label (bug 5) + pilot-data label + §5 table | ✅ |

## History note (why hashes in the checklist differ)

The workspace suffered **two lossy rollbacks** during this round; the second
destroyed the original round-4 commits (`f048001`, `8f533e1` et al. cited in
`AUDIT-CHECKLIST.md` no longer exist as objects). Every change was
re-applied verbatim from the recorded contract and re-verified from scratch —
89/0 with the teeth check both ways — and committed as `243ec0f` → `880af63`
→ (rollback) → **`4dcc351`**, whose tree contains the full round-4 content.
All evidence in this document was produced on `4dcc351` after that
reconstruction, on a database seeded today.

## Reproducing

```bash
pip install -r backend/requirements.txt
(cd mobile && npm install) && (cd tools/qa && npm install && bash bootstrap.sh)
(cd backend && rm -f /tmp/medmesh-test.db* && python3 -m pytest tests/ -q)   # 89 passed
(cd mobile && ./node_modules/.bin/tsc --noEmit && npx expo export --clear -p web)
cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000     # seeds on first run
bash tools/qa/plan-spotchecks.sh                                             # 45/45, simulator on or off
# simulator OFF for the multi-user probe, ON for the nine-harness matrix:
(cd tools/qa && node probe-multiuser.mjs)
(cd tools/qa && for h in surfaces sweep maps probe-admin probe-inbox-shell \
   probe-pickers probe-crew-lifecycle probe-mobile-widths probe-console-crew; \
   do node $h.mjs || echo "FAIL $h"; done)
```
