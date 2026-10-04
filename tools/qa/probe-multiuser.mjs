/**
 * Multi-user probe — the fourth audit's checklist, run as actual scenarios.
 *
 * Every scenario uses SEPARATE browser contexts (separate sessions, separate
 * cookies/storage) against ONE backend process, and records the four outcomes
 * the audit demands before declaring anything passed:
 *
 *   1. the backend's response,
 *   2. the stored state (read back through the API and, where the API does
 *      not expose it, straight out of the database file read-only),
 *   3. the initiating user's screen,
 *   4. every other affected user's screen — WITHOUT manual refresh where the
 *      product claims live updates.
 *
 * Any disagreement between the four fails the scenario.
 *
 * Scenarios (the audit's ten, minus the ones other harnesses already own):
 *   S1  dispatch creation      — dispatcher commits a paediatric P1 to KGCH
 *                                with the crew's NICU unit chosen explicitly;
 *                                driver + ward see it live.
 *   S2  hospital decline       — ward declines with a reason; the hold
 *                                releases, the hospital leaves the eligible
 *                                set, and the dispatcher sees the withdrawal
 *                                without touching the page.
 *   S4  reroute of a live trip — two legs. Leg 1 reroutes after the decline
 *                                (new ward alerted; the self-declined ward is
 *                                NOT spuriously notified). Leg 2 reroutes away
 *                                from an active destination: the bypassed
 *                                ward gets its "no longer inbound" row, the
 *                                hold moves, the driver's screen follows both
 *                                legs without a refresh, crew never changes.
 *   S5  concurrent assignment  — two ops sessions race for the last free
 *                                unit; exactly one wins, the loser is told.
 *   S9  failure and recovery   — offline creation fails honestly, then
 *                                succeeds EXACTLY once (double-click too).
 *   S10 export download        — gov session downloads both CSVs.
 *
 * Why paediatric P1: the crew demo account drives 108-TNCBE-4204, a NICU
 * unit, and the picker only offers units whose capability matches the call.
 * A trauma call wants ALS and correctly hides the NICU van — so the probe
 * raises the call the fixture crew actually answers.
 *
 * S3 (crew lifecycle across refresh) is owned by probe-crew-lifecycle.mjs,
 * S6 (duty expiry) by the backend roster tests + sweep.mjs, S7 (admin edits)
 * by probe-admin.mjs + probe-pickers.mjs, S8 (notifications/complaints acted
 * on) by probe-inbox-shell.mjs — all re-run in this round.
 *
 * PRECONDITION: run the API with MEDMESH_SIMULATOR_ENABLED=false. The demo
 * control room commits and re-scores incidents within seconds and would race
 * every assertion here.
 *
 * Run:  BASE=http://127.0.0.1:8080 node probe-multiuser.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const API = process.env.API || 'http://127.0.0.1:8000/api/v1';
const DB = process.env.DB || '/home/user/medmesh/backend/medmesh.db';
const DESKTOP = { width: 1440, height: 950 };

const CREW_CALLSIGN = '108-TNCBE-4204'; // crew@medmesh.in's linked unit (id 1, NICU)
const KGCH = { id: 1, name: 'Kovai Government General Hospital' };
const SRMC = { id: 2, name: 'Sri Ranga Medical College Hospital' };
const DISTRICT = 1; // Coimbatore — both fixture wards and the crew unit live here

const problems = [];
function check(scenario, outcome, name, pass, detail = '') {
  const tag = pass ? 'ok  ' : 'FAIL';
  console.log(`  [${scenario}/${outcome}] ${tag} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) problems.push(`${scenario} (${outcome}): ${name} — ${detail}`);
}

/* ------------------------------------------------------------------ api */
async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: r.status, json, text };
}
async function apiOk(path, opts) {
  const r = await api(path, opts);
  if (r.status >= 400) throw new Error(`${opts?.method || 'GET'} ${path} -> ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}
async function loginApi(email, password) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (r.status !== 200) throw new Error(`api login ${email} -> ${r.status}`);
  return r.json.access_token;
}

/* Read-only database peek for the "stored state" outcome where no API
   surface exposes the row (facility-addressed notifications, for one). */
function db(sql) {
  const script = [
    'import sqlite3, json, sys',
    `c = sqlite3.connect("file:${DB}?mode=ro", uri=True)`,
    'print(json.dumps(c.execute(sys.argv[1]).fetchall()))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script, sql]).toString());
}

/* -------------------------------------------------------------- browser */
const browser = await chromium.launch();
async function session(email, password, { viewport = DESKTOP, geolocation } = {}) {
  const ctx = await browser.newContext({
    viewport,
    ...(geolocation ? { permissions: ['geolocation'], geolocation } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('name@hospital.gov.in').fill(email);
  await page.getByPlaceholder('••••••••••').fill(password);
  await page.getByText('Sign in', { exact: true }).last().click();
  await page.waitForFunction(() => Boolean(localStorage.getItem('medmesh.token')), null, { timeout: 20000 });
  const token = await page.evaluate(() => localStorage.getItem('medmesh.token'));
  return { ctx, page, token };
}
async function seeText(page, re, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await page.innerText('body').catch(() => '');
    if (re.test(body)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
const shortlist = (id, token) => apiOk(`/incidents/${id}/shortlist`, { token });

/* The demo control room can commit the crew's unit and, with the simulator
   switched off for this probe, its trip then sits mid-stage forever — so the
   fixture unit is not free when the scenarios start. Free it the way ops
   would: cancel the live trip carrying it. */
async function freeTheCrewUnit() {
  for (let i = 0; i < 12; i++) {
    const a = await apiOk('/ambulances/1', { token: adminToken });
    const amb = a.ambulance ?? a;
    if (amb.status === 'available') return true;
    const live = (amb.recent_incidents ?? []).filter(
      (r) => !['handed_over', 'closed', 'cancelled'].includes(r.status),
    );
    for (const r of live) {
      await api(`/incidents/${r.id}/status`, { method: 'POST', token: dispToken, body: { status: 'cancelled' } });
      console.log(`  precondition: cancelled ${r.reference} to free ${CREW_CALLSIGN} (${r.status})`);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}

const GEO = { latitude: 11.0168, longitude: 76.9558 };
let dispA, dispB, crew, kgch, srmc, gov;
let scenarioIncident = null; // the S1–S4 incident, cancelled in cleanup
let adminToken = null;
let dispToken = null;

async function cancelIncident(id) {
  const cur = await apiOk(`/incidents/${id}`, { token: dispToken });
  if (!['cancelled', 'closed', 'handed_over'].includes(cur.status)) {
    await api(`/incidents/${id}/status`, { method: 'POST', token: dispToken, body: { status: 'cancelled' } });
  }
}

try {
  adminToken = await loginApi('admin@medmesh.in', 'MedMesh@2026');
  dispToken = await loginApi('dispatch@medmesh.in', 'Dispatch@108');

  const unitFree = await freeTheCrewUnit();
  if (!unitFree) throw new Error('could not free the fixture crew unit — scenarios would race a live trip');

  console.log('\n== sessions (separate browser profiles, one backend) ==');
  [dispA, dispB, crew, kgch, srmc, gov] = await Promise.all([
    session('dispatch@medmesh.in', 'Dispatch@108', { geolocation: GEO }),
    session('admin@medmesh.in', 'MedMesh@2026', { geolocation: GEO }),
    session('crew@medmesh.in', 'Crew@108'),
    session('admin@kgch.medmesh.in', 'Hospital@2026'),
    session('admin@srmc.medmesh.in', 'Hospital@2026'),
    session('gov@medmesh.in', 'District@2026'),
  ]);
  console.log('  six sessions signed in through the real form');

  /* Park the non-initiator screens where their updates must land, so every
     "without manual refresh" claim is about a page nobody touched. */
  await crew.page.goto(`${BASE}/crew`, { waitUntil: 'domcontentloaded' });
  await kgch.page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await srmc.page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  for (const s of [crew, kgch, srmc]) await s.page.waitForTimeout(2500);

  /* ==================================================================== S1
     Paediatric P1 through the intake, committed to KGCH with the crew's NICU
     unit chosen explicitly. Driver and ward must see it live. */
  console.log('\n== S1: dispatch creation (dispatcher -> driver + ward) ==');
  await dispA.page.goto(`${BASE}/console`, { waitUntil: 'domcontentloaded' });
  await dispA.page.waitForTimeout(3000);
  await dispA.page.getByRole('radio', { name: 'Paediatric', exact: true }).first().click();
  await dispA.page.waitForTimeout(400);
  await dispA.page.getByText(/^Caller gave coordinates$/i).first().click();
  await dispA.page.waitForTimeout(600);
  await dispA.page.getByPlaceholder('11.01684').fill('11.02340');
  await dispA.page.getByPlaceholder('76.95583').fill('76.91230');
  await dispA.page.getByRole('button', { name: /use these/i }).first().click();
  await dispA.page.waitForTimeout(700);
  const before = (await apiOk('/incidents?limit=1', { token: dispToken })).results[0]?.id ?? 0;
  await dispA.page.getByRole('button', { name: /Create incident & find hospital/i }).first().click();
  await dispA.page.waitForTimeout(3500);
  const created = (await apiOk('/incidents?limit=5', { token: dispToken })).results
    .find((i) => i.id > before);
  check('S1', 'backend', 'intake created the incident', Boolean(created), created?.reference ?? 'none');
  if (!created) throw new Error('S1 could not create an incident — nothing else can run');
  scenarioIncident = created;
  const ref = created.reference;

  await dispA.page.goto(`${BASE}/console/${created.id}`, { waitUntil: 'domcontentloaded' });
  await dispA.page.waitForTimeout(3500);

  // Choose the crew unit explicitly, so the driver screen is deterministic.
  await dispA.page.getByText(/Choose a unit/).first().click();
  await dispA.page.waitForTimeout(900);
  const unitBtn = dispA.page.getByRole('button').filter({ hasText: CREW_CALLSIGN }).first();
  const unitOffered = await unitBtn.isVisible().catch(() => false);
  check('S1', 'initiator', 'the crew NICU unit is offered for this call', unitOffered, CREW_CALLSIGN);
  if (unitOffered) {
    await unitBtn.click();
    await dispA.page.waitForTimeout(600);
    await dispA.page.getByText(/Hide units|Choose a unit|Let the engine choose/).first().click().catch(() => {});
    await dispA.page.waitForTimeout(500);
  }

  // Select the KGCH row (rows follow the shortlist order).
  let list = (await shortlist(created.id, dispToken)).results ?? [];
  const kgchIdx = list.findIndex((c) => c.hospital_id === KGCH.id);
  const selectBtns = dispA.page.getByRole('button', { name: /^(Select|Selected)$/ });
  if (kgchIdx >= 0) {
    const label = await selectBtns.nth(kgchIdx).innerText().catch(() => '');
    if (label.trim() === 'Select') await selectBtns.nth(kgchIdx).click();
    await dispA.page.waitForTimeout(700);
  }
  check('S1', 'backend', 'KGCH is on the shortlist', kgchIdx >= 0, kgchIdx >= 0 ? `rank ${kgchIdx + 1}` : 'absent');

  // Reserve a bed on dispatch — the picker defaults to "No hold", and a
  // probe that never touches it would be asserting on a product path nobody
  // takes when a hold is the whole point of the concurrency story.
  await dispA.page.getByRole('tab', { name: 'Bed', exact: true }).first().click();
  await dispA.page.waitForTimeout(400);

  // Commit. If KGCH is blocked (capacity moved), the override path is the
  // product's own answer — take it and record that we did.
  let overridden = false;
  await dispA.page.getByRole('button', { name: 'Dispatch & alert hospital', exact: true }).first().click();
  await dispA.page.waitForTimeout(1300);
  const dlg = await dispA.page.innerText('body');
  if (/Why are you overriding the engine\?/i.test(dlg)) {
    overridden = true;
    // The reason field is a labelled TextField with no placeholder; anchor
    // on its label and take the first input after it.
    await dispA.page
      .getByText(/Why are you overriding the engine\?/i)
      .first()
      .locator('xpath=following::input[1]')
      .fill('Multi-user probe: destination under test by phone confirmation');
    await dispA.page.getByRole('button', { name: 'Override and commit', exact: true }).click();
  } else {
    await dispA.page.getByRole('button', { name: 'Dispatch', exact: true }).last().click();
  }
  await dispA.page.waitForTimeout(3500);

  let detail = await apiOk(`/incidents/${created.id}`, { token: dispToken });
  check('S1', 'backend', 'incident committed', detail.status === 'dispatched',
    detail.status === 'dispatched' ? detail.status : `${detail.status}; page: ${(await dispA.page.innerText('body').catch(() => '')).slice(0, 160).replace(/\n/g, ' ')}`);
  check('S1', 'stored', 'destination is KGCH', detail.assigned_hospital_id === KGCH.id,
    `${detail.assigned_hospital_id}${overridden ? ' (via typed override)' : ''}`);
  check('S1', 'stored', 'crew is the chosen unit', detail.assigned_ambulance_id === 1,
    `ambulance ${detail.assigned_ambulance_id}`);
  const holdRows = db(
    `select hospital_id, resource from bed_holds where incident_id=${created.id} and status='active'`,
  );
  check('S1', 'stored', 'a bed hold stands at KGCH for this incident',
    holdRows.some((r) => r[0] === KGCH.id && r[1] === 'bed'), JSON.stringify(holdRows));
  const inboundRows = db(
    `select count(*) from notifications where kind='inbound_patient' and incident_id=${created.id} and hospital_id=${KGCH.id}`,
  );
  check('S1', 'stored', 'the ward notification is in the database', inboundRows[0][0] > 0,
    `${inboundRows[0][0]} row(s)`);
  check('S1', 'initiator', 'dispatcher screen shows the committed trip',
    await seeText(dispA.page, new RegExp(ref), 10000), ref);
  check('S1', 'other-users', `driver sees ${ref} WITHOUT refresh`,
    await seeText(crew.page, new RegExp(ref)), 'crew screen, no reload');
  check('S1', 'other-users', 'KGCH ward sees the inbound alert WITHOUT refresh',
    await seeText(kgch.page, new RegExp(ref)), 'dashboard, no reload');

  /* ==================================================================== S2
     The ward declines with a structured reason. The hold must release, the
     hospital must leave the eligible set, and the dispatcher must see the
     withdrawal without touching the page. */
  console.log('\n== S2: hospital decline (ward -> dispatcher) ==');
  await kgch.page.getByRole('button', { name: 'We cannot receive', exact: true }).first().click();
  await kgch.page.waitForTimeout(900);
  await kgch.page.getByRole('button', { name: 'No ICU bed', exact: true }).first().click();
  await kgch.page.waitForTimeout(2500);

  detail = await apiOk(`/incidents/${created.id}`, { token: dispToken });
  check('S2', 'backend', 'decline recorded with its reason',
    detail.facility_decline_reason === 'no_icu' && Boolean(detail.facility_declined_at),
    `${detail.facility_response ?? 'n/a'}/${detail.facility_decline_reason}`);
  check('S2', 'stored', 'KGCH left the eligible set',
    (detail.declined_hospital_ids ?? []).includes(KGCH.id),
    `declined ids ${JSON.stringify(detail.declined_hospital_ids ?? [])}`);
  const holdsAfterDecline = db(
    `select hospital_id, status, release_reason from bed_holds where incident_id=${created.id} and status='active'`,
  );
  check('S2', 'stored', 'the KGCH hold released with the decline',
    holdsAfterDecline.length === 0, JSON.stringify(holdsAfterDecline));
  list = (await shortlist(created.id, dispToken)).results ?? [];
  const kgchRow = list.find((c) => c.hospital_id === KGCH.id);
  check('S2', 'stored', 're-scored shortlist marks KGCH ineligible',
    kgchRow ? kgchRow.eligible === false : true, kgchRow ? `eligible=${kgchRow.eligible}` : 'row gone');
  check('S2', 'initiator', 'ward screen confirms the decline',
    await seeText(kgch.page, /Declined — hold released/i, 10000));
  check('S2', 'other-users', 'dispatcher sees "Destination withdrawn" WITHOUT refresh',
    await seeText(dispA.page, /Destination withdrawn/i), 'incident page, no reload');

  /* ==================================================================== S4
     Reroute the live trip, in two legs.

     Leg 1 is the post-decline reroute: KGCH withdrew itself, so there is no
     bypassed ward to notify — the product is right to send the new
     destination its prep alert and nobody else. Leg 2 reroutes AWAY FROM an
     active, never-declined destination, which is the flow where the old ward
     must be told the patient is no longer inbound (the round-4 fix), and
     where the driver's screen must move without a refresh. */
  console.log('\n== S4: reroute of the live trip (dispatcher -> wards + driver) ==');
  const hospitalOf = async (id) => {
    const h = await apiOk(`/hospitals/${id}`, { token: dispToken });
    return { id, name: h.name, short: h.short_name ?? h.name };
  };
  const rerouteTo = async (idx, expectPrevId) => {
    const label = await selectBtns.nth(idx).innerText().catch(() => '');
    if (label.trim() === 'Select') await selectBtns.nth(idx).click();
    await dispA.page.waitForTimeout(600);
    await dispA.page.getByRole('button', { name: 'Re-route to this facility', exact: true }).first().click();
    await dispA.page.waitForTimeout(1300);
    await dispA.page.getByRole('button', { name: 'Re-route', exact: true }).last().click();
    await dispA.page.waitForTimeout(3500);
    return apiOk(`/incidents/${created.id}`, { token: dispToken });
  };

  list = (await shortlist(created.id, dispToken)).results ?? [];
  let t1Idx = list.findIndex((c) => c.hospital_id === SRMC.id && c.eligible);
  if (t1Idx < 0) t1Idx = list.findIndex((c) => c.eligible && c.hospital_id !== KGCH.id);
  const t1 = t1Idx >= 0 ? await hospitalOf(list[t1Idx].hospital_id) : null;
  check('S4', 'backend', 'leg 1: a reroute target exists', Boolean(t1),
    t1 ? `${t1.name} (${t1.short}, rank ${t1Idx + 1})` : 'no eligible candidate');
  if (t1) {
    detail = await rerouteTo(t1Idx);
    // A reroute puts the trip en route by design — the ambulance is moving.
    check('S4', 'backend', 'leg 1: reroute committed', ['dispatched', 'en_route'].includes(detail.status), detail.status);
    check('S4', 'stored', 'leg 1: destination moved', detail.assigned_hospital_id === t1.id,
      `now ${detail.assigned_hospital_id}, wanted ${t1.id}`);
    check('S4', 'stored', 'leg 1: crew unchanged by the reroute', detail.assigned_ambulance_id === 1,
      `ambulance ${detail.assigned_ambulance_id}`);
    const hold1 = db(
      `select hospital_id, resource from bed_holds where incident_id=${created.id} and status='active'`,
    );
    check('S4', 'stored', 'leg 1: the new ward carries the hold',
      hold1.some((r) => r[0] === t1.id), JSON.stringify(hold1));
    const inbound1 = db(
      `select count(*) from notifications where kind='inbound_patient' and incident_id=${created.id} and hospital_id=${t1.id}`,
    );
    check('S4', 'stored', 'leg 1: the new ward was alerted in the database', inbound1[0][0] > 0,
      `${inbound1[0][0]} row(s) for ${t1.short}`);
    // KGCH declined itself out — no bypassed-ward notification is owed, and
    // asserting one would be asserting a bug. Its inbox keeps the original
    // prep alert as the record of the offer.
    const kgchChanged = db(
      `select count(*) from notifications where kind='destination_changed' and incident_id=${created.id} and hospital_id=${KGCH.id}`,
    );
    check('S4', 'stored', 'leg 1: a self-declined ward is not spuriously notified',
      kgchChanged[0][0] === 0, `${kgchChanged[0][0]} row(s)`);
    check('S4', 'initiator', 'leg 1: dispatcher screen shows the new destination',
      await seeText(dispA.page, new RegExp(t1.short), 10000), t1.short);
    if (t1.id === SRMC.id) {
      check('S4', 'other-users', 'leg 1: SRMC ward sees the new inbound alert WITHOUT refresh',
        await seeText(srmc.page, new RegExp(ref)), 'dashboard, no reload');
    } else {
      console.log(`  [S4/other-users] note: ${t1.short} has no fixture login — its alert is proven by the database row above`);
    }
    check('S4', 'other-users', "leg 1: driver's destination moves WITHOUT refresh",
      await seeText(crew.page, new RegExp(t1.short), 50000), t1.short);

    /* ---- leg 2: reroute away from an ACTIVE destination ---- */
    list = (await shortlist(created.id, dispToken)).results ?? [];
    let t2Idx = list.findIndex((c) => c.eligible && c.hospital_id !== t1.id && c.hospital_id !== KGCH.id);
    const t2 = t2Idx >= 0 ? await hospitalOf(list[t2Idx].hospital_id) : null;
    check('S4', 'backend', 'leg 2: a second target exists', Boolean(t2),
      t2 ? `${t2.name} (${t2.short})` : 'no eligible candidate');
    if (t2) {
      detail = await rerouteTo(t2Idx);
      check('S4', 'stored', 'leg 2: destination moved again', detail.assigned_hospital_id === t2.id,
        `now ${detail.assigned_hospital_id}, wanted ${t2.id}`);
      check('S4', 'stored', 'leg 2: crew still unchanged', detail.assigned_ambulance_id === 1,
        `ambulance ${detail.assigned_ambulance_id}`);
      // THE round-4 assertion: the ward that was actively expecting this
      // ambulance is told the patient is no longer inbound.
      const changed = db(
        `select count(*) from notifications where kind='destination_changed' and incident_id=${created.id} and hospital_id=${t1.id}`,
      );
      check('S4', 'stored', 'leg 2: the bypassed ward got its "no longer inbound" notification',
        changed[0][0] > 0, `${changed[0][0]} row(s) for ${t1.short}`);
      const inbound2 = db(
        `select count(*) from notifications where kind='inbound_patient' and incident_id=${created.id} and hospital_id=${t2.id}`,
      );
      check('S4', 'stored', 'leg 2: the new ward was alerted in the database', inbound2[0][0] > 0,
        `${inbound2[0][0]} row(s) for ${t2.short}`);
      const hold2 = db(
        `select hospital_id from bed_holds where incident_id=${created.id} and status='active'`,
      );
      check('S4', 'stored', 'leg 2: the hold moved with the trip',
        hold2.some((r) => r[0] === t2.id) && !hold2.some((r) => r[0] === t1.id), JSON.stringify(hold2));
      check('S4', 'initiator', 'leg 2: dispatcher screen follows the second reroute',
        await seeText(dispA.page, new RegExp(t2.short), 10000), t2.short);
      check('S4', 'other-users', "leg 2: driver's destination moves again WITHOUT refresh",
        await seeText(crew.page, new RegExp(t2.short), 50000), t2.short);
    }
    // The declined ward's inbox still carries the original offer as its record.
    await kgch.page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' });
    await kgch.page.waitForTimeout(2500);
    const inboxBody = await kgch.page.innerText('body');
    check('S4', 'other-users', 'KGCH inbox retains the original inbound alert',
      inboxBody.includes(ref), inboxBody.includes(ref) ? 'reference present' : 'reference missing');
  }

  await cancelIncident(created.id); // frees the crew unit for the race
  await dispA.page.waitForTimeout(1500);

  /* ==================================================================== S5
     Two ops sessions race for the LAST free unit. Exactly one commit may
     win; the loser must be told plainly, not silently. */
  console.log('\n== S5: concurrent assignment (two dispatchers, one unit) ==');
  const units = (await apiOk('/ambulances?limit=200', { token: adminToken })).results ?? [];
  const districtUnits = units.filter((u) => (u.base_district_id ?? u.district_id) === DISTRICT);
  const stood = [];
  for (const u of districtUnits) {
    if (u.id !== 1 && u.status === 'available') {
      await api(`/ambulances/${u.id}/status`, { method: 'POST', token: adminToken, body: { status: 'out_of_service' } });
      stood.push(u.id);
    }
  }
  const raceA = await apiOk('/incidents', { method: 'POST', token: dispToken, body: { category: 'paediatric', urgency: 'P1', lat: 11.02, lng: 76.92, landmark: 'Multiuser race A', district_id: DISTRICT } });
  const raceB = await apiOk('/incidents', { method: 'POST', token: dispToken, body: { category: 'paediatric', urgency: 'P1', lat: 11.03, lng: 76.93, landmark: 'Multiuser race B', district_id: DISTRICT } });
  try {
    await dispA.page.goto(`${BASE}/console/${raceA.id}`, { waitUntil: 'domcontentloaded' });
    await dispB.page.goto(`${BASE}/console/${raceB.id}`, { waitUntil: 'domcontentloaded' });
    await dispA.page.waitForTimeout(3000);
    await dispB.page.waitForTimeout(3000);

    // Both explicitly choose the last free unit, then both confirm at once.
    for (const s of [dispA, dispB]) {
      await s.page.getByText(/Choose a unit/).first().click();
      await s.page.waitForTimeout(800);
      await s.page.getByRole('button').filter({ hasText: CREW_CALLSIGN }).first().click();
      await s.page.waitForTimeout(500);
      await s.page.getByText(/Hide units|Choose a unit|Let the engine choose/).first().click().catch(() => {});
      await s.page.getByRole('button', { name: 'Dispatch & alert hospital', exact: true }).first().click();
      await s.page.waitForTimeout(1000);
    }
    await Promise.all([
      dispA.page.getByRole('button', { name: 'Dispatch', exact: true }).last().click(),
      dispB.page.getByRole('button', { name: 'Dispatch', exact: true }).last().click(),
    ]);
    await dispA.page.waitForTimeout(4000);

    const a = await apiOk(`/incidents/${raceA.id}`, { token: dispToken });
    const b = await apiOk(`/incidents/${raceB.id}`, { token: dispToken });
    const winners = [a, b].filter((i) => i.status === 'dispatched');
    const losers = [a, b].filter((i) => i.status !== 'dispatched');
    check('S5', 'backend', 'exactly one commit won the unit', winners.length === 1,
      `winner=${winners[0]?.reference ?? 'none'} loser=${losers[0]?.reference ?? 'none'}`);
    check('S5', 'stored', 'the unit carries exactly one live trip',
      winners.length === 1 && winners[0].assigned_ambulance_id === 1 && losers[0].assigned_ambulance_id == null,
      `winner unit ${winners[0]?.assigned_ambulance_id}, loser unit ${losers[0]?.assigned_ambulance_id ?? 'none'}`);
    const liveTrips = db(
      `select count(*) from incidents where assigned_ambulance_id=1 and status not in ('handed_over','closed','cancelled')`,
    );
    check('S5', 'stored', 'one live trip on the unit in the database', liveTrips[0][0] === 1,
      `${liveTrips[0][0]} live trip(s)`);
    if (winners.length === 1) {
      const loserPage = winners[0].id === raceA.id ? dispB : dispA;
      const winnerPage = winners[0].id === raceA.id ? dispA : dispB;
      check('S5', 'initiator', 'the losing dispatcher is told the unit cannot be assigned',
        await seeText(loserPage.page, /cannot be assigned|not free|already|conflict|requires a reason/i, 8000));
      check('S5', 'other-users', 'the winning dispatcher sees a committed trip, no error',
        await seeText(winnerPage.page, new RegExp(winners[0].reference), 8000) &&
        !(await seeText(winnerPage.page, /cannot be assigned/i, 1000)));
    }
  } finally {
    for (const i of [raceA, raceB]) await cancelIncident(i.id).catch(() => {});
    for (const id of stood) {
      await api(`/ambulances/${id}/status`, { method: 'POST', token: adminToken, body: { status: 'available' } });
    }
    console.log(`  S5 cleanup: 2 race incidents cancelled, ${stood.length} unit(s) restored to available`);
  }

  /* ==================================================================== S9
     Offline: the failure must be visible and honest — no phantom success,
     no duplicate when the retry lands (double-click included). */
  console.log('\n== S9: failure and recovery (offline dispatcher) ==');
  await dispA.page.goto(`${BASE}/console`, { waitUntil: 'domcontentloaded' });
  await dispA.page.waitForTimeout(2500);
  await dispA.page.getByText(/^Caller gave coordinates$/i).first().click();
  await dispA.page.waitForTimeout(500);
  await dispA.page.getByPlaceholder('11.01684').fill('11.02340');
  await dispA.page.getByPlaceholder('76.95583').fill('76.91230');
  await dispA.page.getByRole('button', { name: /use these/i }).first().click();
  await dispA.page.waitForTimeout(600);
  const countBefore = (await apiOk('/incidents?limit=1', { token: dispToken })).count ?? 0;
  await dispA.ctx.setOffline(true);
  await dispA.page.getByRole('button', { name: /Create incident & find hospital/i }).first().click();
  await dispA.page.waitForTimeout(3500);
  const offBody = await dispA.page.innerText('body').catch(() => '');
  const stillOnConsole = dispA.page.url().endsWith('/console');
  check('S9', 'initiator', 'the offline failure is shown, not swallowed',
    /Rejected|failed|error|offline|unable/i.test(offBody) && stillOnConsole,
    stillOnConsole ? 'banner on the intake' : `navigated to ${dispA.page.url()}`);
  const countDuring = (await apiOk('/incidents?limit=1', { token: dispToken })).count ?? 0;
  check('S9', 'backend', 'nothing was created while offline', countDuring === countBefore,
    `${countBefore} -> ${countDuring}`);

  await dispA.ctx.setOffline(false);
  await dispA.page.waitForTimeout(1200);
  const createBtn = dispA.page.getByRole('button', { name: /Create incident & find hospital/i }).first();
  await createBtn.dblclick().catch(async () => {
    await createBtn.click();
    await createBtn.click().catch(() => {});
  });
  await dispA.page.waitForTimeout(4000);
  const countAfter = (await apiOk('/incidents?limit=1', { token: dispToken })).count ?? 0;
  check('S9', 'backend', 'the retry succeeded EXACTLY once (double-click included)',
    countAfter === countBefore + 1, `${countBefore} -> ${countAfter}`);
  const newest = (await apiOk('/incidents?limit=1', { token: dispToken })).results[0];
  if (newest && countAfter === countBefore + 1) {
    await cancelIncident(newest.id).catch(() => {});
    console.log(`  S9 cleanup: ${newest.reference} cancelled`);
  }

  /* ==================================================================== S10
     The gov session downloads both exports — the incident file only grew a
     button this round, so this probe is the first thing to ever press it. */
  console.log('\n== S10: export downloads (gov official) ==');
  await gov.page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
  await gov.page.waitForTimeout(3000);
  for (const [label, kind] of [['Export capacity', 'capacity'], ['Export incidents', 'incident']]) {
    const dl = gov.page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await gov.page.getByText(label, { exact: true }).first().click();
    const file = await dl;
    check('S10', 'initiator', `the ${kind} export downloads a CSV`,
      Boolean(file) && /\.csv$/i.test(file?.suggestedFilename() ?? ''),
      file ? file.suggestedFilename() : 'no download was offered');
  }
} catch (e) {
  console.error(`\nPROBE ERROR: ${e.message}`);
  problems.push(`probe crashed: ${e.message}`);
  if (scenarioIncident) await cancelIncident(scenarioIncident.id).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${problems.length === 0
  ? 'MULTI-USER PROBE: all scenarios agree across backend, storage and every screen'
  : `MULTI-USER PROBLEMS (${problems.length}):`}`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(problems.length === 0 ? 0 : 1);
