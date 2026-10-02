/**
 * Crew lifecycle — dispatch to handover, with an app refresh at every stage.
 *
 * Round-3 test #11: a driver's phone is killed, backgrounded, reloaded at
 * every one of these moments in real life, and the screen has to come back
 * showing the same trip at the same stage. Also checks the two things the
 * round added: the dominant state band ("This job" at headline size) and the
 * handover receipt on the standby screen after the trip ends.
 *
 * Run:  BASE=http://127.0.0.1:8080 node probe-crew-lifecycle.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const API = process.env.API || 'http://127.0.0.1:8000/api/v1';
const SHOTS = process.env.SHOTS || '/home/user/medmesh/tools/qa/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const problems = [];
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) problems.push(name);
};

async function login(email, password) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  const j = await r.json();
  return j.access_token ?? j.token;
}

async function signInPage(page, email, password) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.getByPlaceholder('name@hospital.gov.in').fill(email);
  await page.getByPlaceholder('••••••••••').fill(password);
  await page.getByText('Sign in', { exact: true }).last().click();
  await page.waitForTimeout(2800);
}

/* --------------------------------------------- set the trip up over HTTP -- */
const dispatchTok = await login('dispatch@medmesh.in', 'Dispatch@108');
const adminTok = await login('admin@medmesh.in', 'MedMesh@2026');
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

// The vehicle the crew account drives — from the API, not an assumed id.
const dir = await (await fetch(`${API}/ambulances/drivers`, { headers: H(adminTok) })).json();
const crewRow = dir.results.find((r) => r.email === 'crew@medmesh.in');
if (!crewRow?.linked_ambulance) {
  console.log('FAIL crew account has no linked vehicle — seed problem');
  process.exit(1);
}
const unit = crewRow.linked_ambulance;

// The vehicle may still be mid-trip from an earlier probe run (or from the
// simulator). A unit that is not available cannot be dispatched, so walk any
// live trip on it to handover first — the same release the pytest fixtures do.
const LIVE = new Set(['open', 'dispatched', 'en_route', 'at_scene', 'patient_onboard', 'transporting', 'at_hospital']);
{
  const detail = await (await fetch(`${API}/ambulances/${unit.id}`, { headers: H(dispatchTok) })).json();
  for (const item of detail.recent_incidents ?? []) {
    if (!LIVE.has(item.status) || item.status === 'open') continue;
    for (const step of ['en_route', 'at_scene', 'patient_onboard', 'at_hospital', 'handed_over']) {
      await fetch(`${API}/incidents/${item.id}/status`, {
        method: 'POST', headers: H(dispatchTok), body: JSON.stringify({ status: step }),
      }).catch(() => {});
    }
  }
}

// The simulator auto-dispatches open incidents within seconds — to ANY unit,
// which would put a stranger's trip on the crew screen. So create and claim
// in one tight loop, and only accept a dispatch that landed on OUR unit;
// otherwise cancel and try again.
let created = null;
let dispatched = null;
for (let attempt = 0; attempt < 4 && !dispatched; attempt += 1) {
  created = await (await fetch(`${API}/incidents`, {
    method: 'POST',
    headers: H(dispatchTok),
    body: JSON.stringify({
      category: 'trauma_fall',
      urgency: 'P2',
      lat: 11.0168,
      lng: 76.9558,
      landmark: 'Lifecycle probe',
      district_id: 1,
      location_source: 'manual',
    }),
  })).json();
  const shortlist = created.shortlist ?? [];
  const eligible = shortlist.find((s) => s.eligible) ?? shortlist[0];
  const r = await fetch(`${API}/incidents/${created.id}/dispatch`, {
    method: 'POST',
    headers: H(dispatchTok),
    body: JSON.stringify({
      hospital_id: eligible?.hospital_id ?? 1,
      ambulance_id: unit.id,
      hold_resource: 'bed',
    }),
  });
  if (r.ok) {
    const row = await r.json();
    if (row.assigned_ambulance_id === unit.id) dispatched = row;
  }
  if (!dispatched) {
    // raced or refused — cancel and retry so the crew screen cannot end up
    // showing a trip the simulator assigned to somebody else.
    await fetch(`${API}/incidents/${created.id}/status`, {
      method: 'POST', headers: H(dispatchTok), body: JSON.stringify({ status: 'cancelled' }),
    }).catch(() => {});
    await new Promise((res) => setTimeout(res, 500));
  }
}
const incidentId = created?.id;
ok('incident created over HTTP', Boolean(incidentId), created?.reference ?? '');
ok('incident dispatched to the crew vehicle', Boolean(dispatched), dispatched?.status ?? 'none');
if (!dispatched) {
  await browser.close();
  process.exit(1);
}

/* ------------------------------------------------ the crew walks the trip -- */
const ctx = await browser.newContext({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
const page = await ctx.newPage();
await signInPage(page, 'crew@medmesh.in', 'Crew@108');

/* [stage, button that reaches it, what the dominant band must read at it].
   The band is checked AFTER the advance and again AFTER a full page reload —
   the reload is the point of #11 (the app is killed and reopened constantly)
   and the band text is the point of #13 (state must be readable, not
   inferred from which button is highlighted). */
const STAGES = [
  ['dispatched', null, /Dispatched|Assigned/i],
  ['en_route', 'Accept & go', /En route|Accepted/i],
  ['at_scene', 'Arrived at scene', /At scene|On scene/i],
  ['patient_onboard', 'Patient loaded', /Patient on board|Loaded/i],
  ['transporting', 'Departed scene', /Transporting|Departed/i],
  ['at_hospital', 'Arrived at hospital', /At hospital|Arrived/i],
  ['handed_over', 'Handover complete', /Hand(ed)? ?over|Complete/i],
];

for (const [stage, buttonLabel, expectBand] of STAGES) {
  // Handover ENDS the trip: the crew screen deliberately stops showing a
  // dominant trip band and stands by with the receipt instead (checked below).
  // Walking it through the mid-trip assertions would assert against a screen
  // that is correct precisely because it no longer shows the trip.
  if (stage === 'handed_over') {
    const btn = page.getByRole('button', { name: /^Handover complete/i }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2500);
      const apiRow = await (await fetch(`${API}/incidents/${incidentId}`, { headers: H(dispatchTok) })).json();
      ok('advance to handed_over recorded server-side', apiRow.status === 'handed_over', apiRow.status);
    } else {
      ok('advance to handed_over recorded server-side', false, 'button "Handover complete" not found');
    }
    break;
  }
  if (buttonLabel) {
    const btn = page.getByRole('button', { name: new RegExp(`^${buttonLabel}`, 'i') }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2500);
      const apiRow = await (await fetch(`${API}/incidents/${incidentId}`, { headers: H(dispatchTok) })).json();
      ok(`advance to ${stage} recorded server-side`, apiRow.status === stage, apiRow.status);
      const after = await page.innerText('body');
      ok(`advance to ${stage} shown without refresh`, /This job/i.test(after) && expectBand.test(after), (after.match(/This job\s*\n([^\n]+)/i) || [])[1]);
    } else {
      ok(`advance to ${stage} recorded server-side`, false, `button "${buttonLabel}" not found`);
    }
  }

  // #11: kill and reopen the app at this stage.
  await page.goto(`${BASE}/crew`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const body = await page.innerText('body');
  ok(
    `refresh at ${stage}: trip is still on screen`,
    new RegExp(created.reference ?? 'TN-', 'i').test(body) || /This job/i.test(body),
  );
  // #13: the current state is the dominant thing on the screen.
  ok(
    `refresh at ${stage}: dominant state band reads correctly`,
    /This job/i.test(body) && expectBand.test(body),
    (body.match(/This job\s*\n([^\n]+)/i) || [])[1],
  );
}

await page.screenshot({ path: `${SHOTS}/98-crew-handover.png` }).catch(() => {});

/* ------------------------------------------------------- standby receipt -- */
await page.goto(`${BASE}/crew`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3200);
let body = await page.innerText('body');
ok('after handover the crew screen stands by', /Standing by/i.test(body));
ok(
  'standby carries the handover receipt',
  /Last trip — handover recorded/i.test(body) && new RegExp(created.reference ?? 'TN-', 'i').test(body),
  (body.match(/TN-\d{4}-[A-Z0-9]{3}/) || [])[0],
);
ok('receipt names the receiving hospital', /Handed over at \S+/i.test(body), (body.match(/Handed over at [^\n·]+/i) || [])[0]);
ok(
  'GPS limitation stays labelled on standby',
  /Live GPS while trip screen is active/i.test(body),
);
await page.screenshot({ path: `${SHOTS}/99-crew-standby-receipt.png` }).catch(() => {});

await ctx.close();
await browser.close();
console.log(problems.length ? `\n${problems.length} PROBLEM(S): ${problems.join('; ')}` : '\nALL CREW LIFECYCLE CHECKS PASSED');
process.exit(problems.length ? 1 : 0);
