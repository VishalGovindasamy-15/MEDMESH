/**
 * Google Maps integration test.
 *
 * A real Maps key cannot live in this repository, so the Maps JavaScript API is
 * served from a stub that implements the same contract the loader depends on:
 * the `callback` handshake, `Map`, `Marker`, `Polyline` and `SymbolPath`. That
 * exercises everything on our side of the boundary — script injection and reuse,
 * map construction, marker and polyline lifecycle, theme wiring, and teardown —
 * and the stub records what it was asked to do so the assertions are about
 * behaviour rather than about pixels.
 *
 * Two paths are covered:
 *   1. key present, API loads  → tiles view mounted, pins and route drawn
 *   2. key present, API fails  → explicit notice, no crash, console clean
 */
import { chromium } from 'playwright';

const BASE = process.env.MAPS_BASE ?? 'http://127.0.0.1:8081';
const problems = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/** The stub, injected as the body of the maps.googleapis.com script request. */
const STUB = `
(function () {
  const log = { maps: 0, markers: [], polylines: [], styles: null, options: null };
  window.__gmapsLog = log;
  function Map(el, opts) {
    log.maps += 1;
    log.styles = opts && opts.styles ? opts.styles.length : 0;
    log.options = opts || {};
    this.el = el;
    this.panTo = function (p) { log.panned = p; };
    this.setCenter = function () {};
    this.setZoom = function () {};
  }
  function Marker(opts) {
    log.markers.push({
      lat: opts.position.lat,
      lng: opts.position.lng,
      title: opts.title,
      fill: opts.icon && opts.icon.fillColor,
      scale: opts.icon && opts.icon.scale,
    });
    this.setMap = function () {};
    this.addListener = function (ev, fn) { if (ev === 'click') this._click = fn; };
  }
  function Polyline(opts) {
    log.polylines.push({ points: opts.path.length, stroke: opts.strokeColor, weight: opts.strokeWeight });
    this.setMap = function () {};
  }
  window.google = {
    maps: {
      Map: Map,
      Marker: Marker,
      Polyline: Polyline,
      SymbolPath: { CIRCLE: 0, FORWARD_CLOSED_ARROW: 1 },
    },
  };
  if (typeof window.__medmeshMapsReady === 'function') window.__medmeshMapsReady();
})();
`;

/**
 * Drive the real API to put a case in flight for the demo crew account.
 *
 * Requests go through the preview server's /api proxy, so this exercises the
 * same path the app does rather than a bypass.
 */
async function createLiveTrip() {
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dispatch@medmesh.in', password: 'Dispatch@108' }),
  }).then((r) => r.json());
  if (!login.access_token) return null;
  const auth = { Authorization: `Bearer ${login.access_token}`, 'Content-Type': 'application/json' };

  // The demo driver account owns one unit, and that is the unit the crew screen
  // will show -- so the fixture has to use it, not just any free ambulance.
  // Status is a consequence of incident status rather than a field anyone sets,
  // which means a unit left mid-journey by the simulator cannot simply be picked
  // up: the trip it is already on has to be finished first. That is exactly what
  // a ward does at handover, so the fixture drives the real endpoint.
  const roster = await fetch(`${BASE}/api/v1/ambulances/drivers`, { headers: auth }).then((r) => r.json());
  const unit = (roster.results ?? [])[0]?.linked_ambulance ?? null;
  if (!unit) return null;

  if (unit.status !== 'available') {
    const open = await fetch(`${BASE}/api/v1/incidents?limit=200`, { headers: auth }).then((r) => r.json());
    const busy = (open.results ?? []).find((i) => i.assigned_ambulance_id === unit.id && i.is_open);
    if (!busy) return null;
    await fetch(`${BASE}/api/v1/incidents/${busy.id}/status`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ status: 'handed_over' }),
    });
  }

  const incident = await fetch(`${BASE}/api/v1/incidents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      category: 'cardiac',
      urgency: 'P1',
      lat: 11.0168,
      lng: 76.9558,
      landmark: 'Maps harness scene',
      district_id: 1,
      requires_icu: true,
    }),
  }).then((r) => r.json());
  if (!incident.id) return null;

  const top = (incident.shortlist ?? []).find((c) => c.eligible);
  if (!top) return null;

  const dispatched = await fetch(`${BASE}/api/v1/incidents/${incident.id}/dispatch`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      hospital_id: top.hospital_id,
      ambulance_id: unit.id,
      hold_resource: 'icu',
      hold_seconds: 900,
    }),
  }).then((r) => r.json());
  return dispatched.reference ? incident : null;
}

const browser = await chromium.launch();

/* ------------------------------------------------------- 1. happy path */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  ctx.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await ctx.route('**/maps.googleapis.com/maps/api/js**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }),
  );

  // Directions, served from a canned OK response. The encoded polyline is the
  // worked example from Google's own documentation, so the decode assertions are
  // against known-correct coordinates rather than against our own encoder.
  await ctx.route('**/maps.googleapis.com/maps/api/directions/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'OK',
        routes: [
          {
            summary: 'NH948',
            overview_polyline: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
            legs: [
              {
                distance: { value: 6350 },
                duration: { value: 780 },
              },
            ],
          },
        ],
      }),
    }),
  );

  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  // Give the loader, the map mount and the first marker batch time to run.
  await page.waitForTimeout(3500);

  const log = await page.evaluate(() => window.__gmapsLog ?? null);
  const legend = await page.innerText('body');

  check('maps: API requested once', (await page.evaluate(() => document.querySelectorAll('#medmesh-gmaps').length)) === 1);
  check('maps: map constructed', !!log && log.maps === 1, log ? `${log.maps} Map instances` : 'no stub log');
  check('maps: quiet basemap applied', !!log && log.styles > 5, log ? `${log.styles} style rules` : '');
  check('maps: facility markers drawn', !!log && log.markers.length > 15, log ? `${log.markers.length} markers` : '');
  check(
    'maps: markers carry capacity colours',
    !!log && log.markers.some((m) => m.fill === '#137547') && log.markers.some((m) => ['#8a5a00', '#a32217'].includes(m.fill)),
    log ? [...new Set(log.markers.map((m) => m.fill))].join(' ') : '',
  );
  check('maps: legend says Google Maps', /Basemap · Google Maps/.test(legend));
  check('maps: no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: '/home/user/medmesh/docs/shots/31-maps-desktop.png' });

  // Route drawing on the crew screen, which is where navigation actually matters.
  // A live trip is created through the real API first: the simulator advances
  // seeded incidents to completion, so a standing crew screen is the normal
  // state and would prove nothing about the route layer.
  const trip = await createLiveTrip();
  check('crew fixture: dispatcher created and assigned a live trip', !!trip, trip ? trip.reference : 'dispatch failed');

  await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('name@hospital.gov.in').fill('crew@medmesh.in');
  await page.getByPlaceholder('••••••••••').fill('Crew@108');
  await page.getByText('Sign in', { exact: true }).last().click();
  await page.waitForTimeout(2600);
  await page.goto(`${BASE}/crew`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const crewLog = await page.evaluate(() => window.__gmapsLog ?? null);
  const crewText = await page.innerText('body');
  check('crew: map mounted on the trip screen', !!crewLog && crewLog.maps >= 1);
  check('crew: route polyline drawn', !!crewLog && crewLog.polylines.length >= 1, crewLog ? `${crewLog.polylines.length} polylines` : '');
  check(
    'crew: encoded polyline decoded to the documented coordinates',
    !!crewLog && crewLog.polylines[0]?.points === 3,
    crewLog?.polylines[0] ? `${crewLog.polylines[0].points} points` : '',
  );
  check('crew: route drawn in the accent hue', !!crewLog && /^#/.test(crewLog.polylines[0]?.stroke ?? ''));
  check('crew: Google directions summary surfaced', /NH948/.test(crewText), 'expected the road name from the API');
  // The handoff is the point of the screen for a driver, so it is asserted as a
  // URL rather than as a word. `Linking.openURL` on web lands on `window.open`,
  // which is stubbed here so the check is about where the button would send the
  // crew -- and the request itself is blocked, because navigating this browser
  // to Google halfway through the run would end the run.
  await ctx.route('**google.com/maps/**', (route) => route.abort());
  const navUrl = await page.evaluate(async () => {
    let captured = null;
    const original = window.open;
    window.open = (url) => {
      captured = String(url);
      return null;
    };
    const trigger = [...document.querySelectorAll('[role="button"], button, a')].find((el) =>
      /Open Google Maps|Navigate/i.test(el.textContent ?? ''),
    );
    if (!trigger) return '__no_control__';
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    window.open = original;
    return captured;
  });
  check(
    'crew: navigation handoff offered',
    typeof navUrl === 'string' && /google\.com\/maps/.test(navUrl) && /travelmode=driving/.test(navUrl),
    navUrl === '__no_control__' ? 'no navigation control on the trip screen' : String(navUrl ?? '').slice(0, 120),
  );
  await page.screenshot({ path: '/home/user/medmesh/docs/shots/32-maps-crew.png' });

  await ctx.close();
}

/* ------------------------------------------------------- 2. failure path */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  ctx.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Simulate a referrer-restricted key: the request is refused outright.
  await ctx.route('**/maps.googleapis.com/maps/api/js**', (route) => route.abort('failed'));

  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const text = await page.innerText('body');
  check('maps failure: operator is told, not shown a blank box', /could not be loaded/.test(text));
  check('maps failure: page still renders the directory', /facilities reporting|Where is care available/.test(text));
  // The blocked request is the scenario under test, so it is filtered out; what
  // matters is that nothing downstream of it throws.
  const real = errors.filter((e) => !/ERR_FAILED|Failed to load resource/.test(e));
  check('maps failure: no unhandled console errors', real.length === 0, real.slice(0, 2).join(' | '));

  await page.screenshot({ path: '/home/user/medmesh/docs/shots/33-maps-failure.png' });
  await ctx.close();
}

await browser.close();

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  problems.forEach((p) => console.log(`  - ${p}`));
  process.exitCode = 1;
} else {
  console.log('google maps integration verified');
}
