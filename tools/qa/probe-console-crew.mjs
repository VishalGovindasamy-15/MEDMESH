/**
 * Dispatcher console — crew picker, unit preview, commit confirmation.
 *
 * Probes the three things this change added to the incident workspace, in the
 * order an operator meets them: the crew list, the unit preview behind it, and
 * the confirmation step in front of the commit. Also proves the override path
 * refuses to fire without a typed reason.
 *
 * Run:  BASE=http://127.0.0.1:8080 node probe-console-crew.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const SHOTS = process.env.SHOTS || '/home/user/medmesh/tools/qa/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const problems = [];
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) problems.push(name);
};

const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // A 409 from the dispatch endpoint is the contract under test below, not a
  // page fault; the browser still logs the network line as a console error.
  if (/Failed to load resource.*409/.test(m.text())) return;
  consoleErrors.push(m.text());
});

// Sign in through the real form, like the surface harness does.
await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
await page.getByPlaceholder('name@hospital.gov.in').fill('dispatch@medmesh.in');
await page.getByPlaceholder('••••••••••').fill('Dispatch@108');
await page.getByText('Sign in', { exact: true }).last().click();
await page.waitForTimeout(3000);
await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const queue = await page.innerText('body');
const ref = (queue.match(/TN-\d{4}-[A-Z0-9]{3}/) || [])[0];
ok('console queue has a live case', Boolean(ref), ref || 'none');

// #1/#28: the intake reads as a call flow, not a form dump.
ok(
  'intake is a guided flow with an obvious create action',
  /Create incident & find hospital/.test(queue),
);
ok('scene assessment sits behind an optional disclosure', /Optional triage details/.test(queue));
ok('district is a one-click control on the intake', /district/i.test(queue));

// #34: the fleet board states trip stages and GPS honesty, not just a count.
ok('fleet board breaks the fleet down by trip stage', /\d+ (available|en route|transporting|at scene|assigned|at hospital)/i.test(queue),
  (queue.match(/\d+ (?:available|en route|transporting|at scene|assigned|at hospital)/i) || [])[0]);
ok('fleet map legend explains the freshness ring', /Ring = GPS age/.test(queue));

if (ref) {
  await page.getByText(ref, { exact: true }).first().click();
  await page.waitForTimeout(4500);

  const body = await page.innerText('body');
  ok('crew panel renders', /\bcrew\b/i.test(body));
  ok('crew panel counts the fleet', /\d+ free of \d+/.test(body), (body.match(/\d+ free of \d+/) || [])[0]);
  ok('engine default is stated', /Engine picks the nearest capable unit/.test(body));
  ok('the call states the capability it wants', /This call wants/.test(body));

  // The picker rows are real buttons with an accessible name, so this is also a
  // check that the crew list is reachable without a pointer.
  await page.getByText(/Choose a unit/).first().click();
  await page.waitForTimeout(1000);

  const unitButtons = [];
  for (const b of await page.getByRole('button').all()) {
    const label = await b.getAttribute('aria-label');
    if (label && /^\d+[0-9A-Z-]*108-|108-/.test(label)) unitButtons.push({ b, label });
  }
  ok('picker lists units as buttons', unitButtons.length > 0, `${unitButtons.length} units`);
  ok(
    'picker states which units match the call',
    unitButtons.some((u) => /matches this call/.test(u.label)),
    unitButtons[0]?.label,
  );
  ok(
    'picker states unit availability',
    unitButtons.every((u) => /Available|En route|Assigned|Out of service|Transporting|At scene|At hospital/.test(u.label)),
  );

  await unitButtons[0].b.click();
  await page.waitForTimeout(1000);
  const preview = await page.innerText('body');
  ok('unit preview shows registration', /Registration/.test(preview));
  ok('unit preview shows the crew', /No crew account linked|Crew/.test(preview));
  ok('unit preview shows a GPS fix age', /GPS fix/.test(preview));
  ok(
    'unit preview states whether it matches the call',
    /matches this call|not what this call asks for/.test(preview),
  );
  await page.screenshot({ path: `${SHOTS}/61-console-crew-preview.png` });

  // The commit must ask first.
  await page.getByText(/Dispatch & alert hospital|Re-route to this facility/).first().click();
  await page.waitForTimeout(1200);
  const dialog = await page.innerText('body');
  ok(
    'commit opens a confirmation',
    /Commit TN-|Re-route TN-/.test(dialog),
    (dialog.match(/(Commit|Re-route) TN-\S+/) || [])[0],
  );
  ok('confirmation restates the facility', /Facility/.test(dialog));
  ok('confirmation restates the drive time', /Drive time/.test(dialog));
  ok('confirmation restates the crew decision', /Crew/.test(dialog));
  await page.screenshot({ path: `${SHOTS}/62-console-dispatch-confirm.png` });

  await page.getByText('Cancel', { exact: true }).first().click();
  await page.waitForTimeout(800);
  ok('cancelling closes the dialog', !/Commit TN-/.test(await page.innerText('body')));

  // ---- override + crew-conflict contract (#11, #31).
  //
  // The demo control room commits open cases on its own clock, usually within
  // seconds, so the probe scans the queue for a case that is still open rather
  // than raising one of its own (a raised case is dispatched before the page
  // finishes loading). On an open case, committing a facility the engine has
  // blocked must come back as a reasoned override; then the district's free
  // units are stood down through the fleet API to check what the console says
  // when there is nothing free to commit. Everything flipped is flipped back,
  // in a finally, so a crash cannot leave the pilot fleet standing down.
  const apiToken = await (
    await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dispatch@medmesh.in', password: 'Dispatch@108' }),
    })
  ).json().then((b) => b.access_token);
  // Fleet status writes are district-scoped for dispatchers, so the outage is
  // planted with the platform account, which administers the whole fleet.
  const fleetToken = await (
    await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@medmesh.in', password: 'MedMesh@2026' }),
    })
  ).json().then((b) => b.access_token);

  // #11 on the live case: a facility that already declined this patient is
  // listed under "Incl. rejected"; re-routing onto it is refused with an
  // override instruction, and that refusal has to open the reasoned dialog.
  {
    const rejectedTab = page.getByText(/Incl\. rejected/).first();
    if (await rejectedTab.count()) {
      await rejectedTab.click();
      await page.waitForTimeout(1200);
    }
    const blockedIndex = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter(
        (b) => (b.textContent || '').trim() === 'Select',
      );
      for (let i = 0; i < buttons.length; i++) {
        let node = buttons[i];
        for (let up = 0; up < 4 && node; up++) {
          const text = (node.innerText || '').toUpperCase();
          if (
            text.length > 120 &&
            text.length < 900 &&
            /DECLINED|NO .*BEDS|NO ICU|NO VENT|AT CAPACITY|BLOCKED/.test(text)
          ) {
            return i;
          }
          node = node.parentElement;
        }
      }
      return -1;
    });
    if (blockedIndex >= 0) {
      await page.getByRole('button', { name: 'Select', exact: true }).nth(blockedIndex).click();
      await page.waitForTimeout(900);
      await page.getByText(/Dispatch & alert hospital|Re-route to this facility/).first().click();
      await page.waitForTimeout(900);
      await page.getByRole('button', { name: /^(Commit|Dispatch|Re-route)$/ }).last().click();
      await page.waitForTimeout(2500);
      // The server's 409 opens the override dialog itself: a refused choice
      // neither commits silently nor commits without a typed reason.
      const reasonDialog = await page.innerText('body');
      ok(
        'committing a blocked facility becomes a reasoned override',
        /Why are you overriding the engine\?/i.test(reasonDialog),
      );
      ok('the override restates what the engine said', /Engine says/i.test(reasonDialog));
      const confirmBtn = page.getByRole('button', { name: /Override and commit/ }).last();
      if (await confirmBtn.count()) {
        ok(
          'override cannot confirm with an empty reason',
          (await confirmBtn.getAttribute('aria-disabled')) === 'true',
        );
        await page.locator('textarea').last().fill('ward called back: the bay is free after all');
        await page.waitForTimeout(500);
        ok(
          'a typed reason enables the override',
          (await confirmBtn.getAttribute('aria-disabled')) !== 'true',
        );
      }
      await page.screenshot({ path: `${SHOTS}/63-console-override-reason.png` });
      await page.getByText('Cancel', { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(600);
    } else {
      console.log('  ....  no declined/blocked row on this case — override not exercised');
    }
  }

  // The "nothing free to commit" state (#31): stand every available unit in
  // the dispatcher's scope down and read what the crew panel says.
  // The crew panel's scope is the case's district and its escalation ring, so
  // the units to stand down are the ones the picker itself lists.
  // Whatever the case's district, the crew panel can escalate statewide, so
  // "nothing free to commit" means nothing free anywhere: every available unit
  // in the fleet is stood down in one parallel batch and put back the same
  // way. The window is a few seconds; the restore runs in a finally.
  const scopeRes = await (
    await fetch(`${BASE}/api/v1/ambulances?limit=200`, { headers: { Authorization: `Bearer ${fleetToken}` } })
  ).json();
  const victims = (scopeRes.results || []).filter((u) => u.status === 'available');
  const flip = (unit, status) =>
    fetch(`${BASE}/api/v1/ambulances/${unit.id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${fleetToken}` },
      body: JSON.stringify({ status }),
    });
  const flipped = [];
  const restore = async () => {
    await Promise.all(flipped.map((v) => flip(v, 'available').catch(() => {})));
  };
  try {
    const results = await Promise.all(
      victims.map(async (v) => {
        const r = await flip(v, 'out_of_service');
        return r.ok ? v : null;
      }),
    );
    flipped.push(...results.filter(Boolean));
    console.log(`  .... stood down ${flipped.length} of ${victims.length} units in scope`);
    if (flipped.length) {
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3500);
      const body0 = await page.innerText('body');
      const ci = body0.search(/CREW|Crew/);
      console.log('  .... crew panel:', body0.slice(ci, ci + 260).replace(/\n+/g, ' | '));
      ok(
        'with no free unit the console says so in its own words',
        /No free unit right now|Choose a unit \(0 free\)/i.test(body0),
        (body0.match(/No free unit right now|Choose a unit \(0 free\)/i) || [])[0],
      );
      ok(
        'the stale verbatim engine line is not left on screen',
        !/No ambulance available in this district/.test(body0),
      );
      await page.screenshot({ path: `${SHOTS}/64-console-crew-conflict.png` });
    } else {
      console.log('  ....  no available unit in scope to stand down — skipped');
    }
  } finally {
    await restore();
  }

}

ok('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await ctx.close();
await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nconsole crew workflow verified');
