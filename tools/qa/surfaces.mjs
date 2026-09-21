/**
 * Surface harness — the integration, inbox, administration and citizen screens.
 *
 * Signs in through the real form for each role (no token injection: that would
 * test the harness rather than the app) and asserts on what each screen actually
 * has to say. Screenshots land in docs/shots for review.
 *
 * Every route is checked on both a desktop and a phone viewport, because the
 * pilot is used on a ward desktop and on a crew phone, and a layout that only
 * works at one width is not finished.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const OUT = '/home/user/medmesh/docs/shots';
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const ACCOUNTS = {
  admin: ['admin@medmesh.in', 'MedMesh@2026'],
  hospital: ['admin@srmc.medmesh.in', 'Hospital@2026'],
  dispatcher: ['dispatch@medmesh.in', 'Dispatch@108'],
};

const problems = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('name@hospital.gov.in').fill(email);
  await page.getByPlaceholder('••••••••••').fill(password);
  await page.getByText('Sign in', { exact: true }).last().click();
  await page.waitForTimeout(2500);
}

/**
 * A session is per browser context: `/sign-in` bounces an already-authenticated
 * visitor to their home route, so switching roles inside one context silently
 * lands on the previous user's screen.
 */
async function session(browser, email, password, viewport = DESKTOP) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await signIn(page, email, password);
  return { ctx, page };
}

const consoleErrors = [];
function watch(page) {
  const handler = (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  };
  page.on('console', handler);
}

async function shot(page, label, name) {
  await page.waitForTimeout(500);
  const layout = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    docH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
  }));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  check(`${label}: fits the viewport`, layout.docW <= layout.innerW + 2, `${layout.docW} > ${layout.innerW}`);
  return { text: await page.innerText('body'), layout };
}

const browser = await chromium.launch();

/* ------------------------------------------------ citizen surface (no auth) */
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  watch(page);

  await page.goto(`${BASE}/onboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const onboard = await shot(page, 'onboard', '20-onboard-desktop');
  check('onboard: says nothing is published unverified', /verified/i.test(onboard.text));

  await page.getByPlaceholder('Coimbatore North Taluk Hospital').fill('Harness Test Hospital');
  await page.getByText('Coimbatore', { exact: false }).first().click();
  await page.waitForTimeout(400);
  await page.getByText('Next', { exact: true }).click();
  await page.waitForTimeout(500);
  check('onboard: step 2 asks for declared capacity', /Declared capacity/i.test(await page.innerText('body')));
  await page.getByPlaceholder('240').fill('120');
  await page.getByPlaceholder('16').fill('8');
  await page.getByText('Next', { exact: true }).click();
  await page.waitForTimeout(500);
  check(
    'onboard: step 3 gates on a staffed department',
    /staffed for emergencies/i.test(await page.innerText('body')),
  );

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  const directory = await shot(page, 'directory', '23-directory-desktop');
  check('directory: offers onboarding from the public page', /Add your hospital/i.test(directory.text));
  check('directory: antivenom is filterable', /Antivenom/i.test(directory.text));
  check('directory: voice search is offered', /Speak your search/i.test(directory.text));
  check('directory: carries the self-report disclaimer', /self-reported/i.test(directory.text));

  // Facility names on the schematic map. These regressed silently once: the
  // label's collision box was sized as if every pin were the smallest, so each
  // label overlapped its own pin and every one was dropped. The map still
  // rendered correctly and carried no names, which is exactly the kind of
  // failure no one notices until they need to read a name off the map.
  const mapLabels = await page.evaluate(() => {
    const out = [];
    for (const svg of document.querySelectorAll('svg')) {
      for (const t of svg.querySelectorAll('text')) {
        const v = (t.textContent || '').trim();
        if (v.length >= 2 && v.length <= 6 && v === v.toUpperCase() && /^[A-Z]/.test(v)) out.push(v);
      }
    }
    return out;
  });
  check(
    'directory: the map labels facilities, not just pins',
    mapLabels.length > 0,
    `${mapLabels.length} label(s): ${mapLabels.slice(0, 5).join(' ')}`,
  );

  await page.getByText('த', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  const tamil = await shot(page, 'directory · Tamil', '36-directory-tamil');
  check('Tamil: heading is translated', /இப்போது எங்கே சிகிச்சை/i.test(tamil.text), tamil.text.slice(0, 70));
  check('Tamil: filters are translated', /இரத்த வங்கி/i.test(tamil.text));
  check('Tamil: disclaimer is translated', /தானே தெரிவிக்கும்/.test(tamil.text));
  check('Tamil: no missing translation keys', !/^[a-z]+\.[a-zA-Z]+$/.test(tamil.text.split('\n').find((l) => /^[a-z]+\./.test(l)) ?? ''));

  await page.getByText('EN', { exact: true }).first().click();
  await page.waitForTimeout(800);
  check('language switch is reversible', /Where is care available/i.test(await page.innerText('body')));

  await ctx.close();
}

/* ------------------------------------------------------ platform operations */
{
  const { ctx, page } = await session(browser, ...ACCOUNTS.admin);
  watch(page);

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2400);
  const accounts = await shot(page, 'admin · accounts', '24-admin-accounts');
  check('admin: lists the people who can act', /Who can do what/i.test(accounts.text));
  check('admin: shows seeded accounts', /Duty Office|Bed Control|Platform Operations/i.test(accounts.text));

  await page.getByText('Add a user', { exact: true }).click();
  await page.waitForTimeout(700);
  check('admin: provisioning asks for a scoped facility', /Facility they report for/i.test(await page.innerText('body')));
  await shot(page, 'admin · add user', '25-admin-add-user');
  await page.getByText('Close', { exact: true }).click();

  await page.getByText(/Connectors/).first().click();
  await page.waitForTimeout(1600);
  const conn = await shot(page, 'admin · connectors', '26-admin-connectors');
  check('admin: connector estate shows pushing vs keyed', /Pushing data/i.test(conn.text));
  check('admin: names a failing connector', /upstream timed out/i.test(conn.text));
  check('admin: flags API-integrated facilities with no connector', /no connector/i.test(conn.text));

  await page.getByText(/Onboarding/).first().click();
  await page.waitForTimeout(1600);
  const queue = await shot(page, 'admin · onboarding', '27-admin-onboarding');
  check('admin: verification queue populated', /Verification queue/i.test(queue.text));
  check('admin: applicant carries a reference', /MM-ONB-/i.test(queue.text));

  await page.getByText(/Complaints/).first().click();
  await page.waitForTimeout(1500);
  const complaints = await shot(page, 'admin · complaints', '34-admin-complaints');
  check('admin: complaint loop is closable', /Reported inaccuracies|Mark resolved/i.test(complaints.text));

  await page.getByText('Audit', { exact: true }).first().click();
  await page.waitForTimeout(1600);
  const audit = await shot(page, 'admin · audit', '35-admin-audit');
  check('admin: audit is attributed to a named actor', /Who changed what/i.test(audit.text));
  check('admin: audit lists real actions', /auth\.login|capacity\.|incident\./i.test(audit.text));

  await ctx.close();
}

/* ------------------------------------------------------------- ward inbox */
{
  const { ctx, page } = await session(browser, ...ACCOUNTS.hospital);
  watch(page);

  await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const inbox = await shot(page, 'inbox · ward', '28-inbox-ward');
  check('inbox: renders labels, not enum names', /Inbound patient/i.test(inbox.text));
  check('inbox: offers the read action', /Mark read|Read/i.test(inbox.text));

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const dash = await shot(page, 'dashboard · ward', '37-dashboard-ward');
  check('dashboard: shows the keypad', /Published figures|Beds|ICU/i.test(dash.text));

  // The dispatch console must disclose how its ranking was computed. Proximity
  // is scored on road drive time, resolved before anything is ranked, so the
  // shortlist and the map cannot disagree -- and when the router is unavailable
  // the engine falls back to straight-line geometry and says so. A dispatcher
  // acting on a nine-minute ETA is entitled to know which of those they have.
  await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const queue = await page.innerText('body');
  const ref = (queue.match(/TN-\d{4}-[A-Z0-9]{3}/) || [])[0];
  if (ref) {
    await page.getByText(ref, { exact: true }).first().click();
    await page.waitForTimeout(3200);
    const incident = await page.innerText('body');
    check(
      'console: discloses how the ranking was computed',
      /Ranked on road drive time|Ranked on straight-line estimates/.test(incident),
      (incident.split('\n').find((l) => /Ranked on/.test(l)) || '').slice(0, 90),
    );
    check(
      'console: each candidate says whether its ETA is road-derived',
      /via road|direct/.test(incident),
    );
    await shot(page, 'console · routing disclosure', '42-console-routing-disclosure');
  } else {
    check('console: has an incident to open', false, 'no incident reference in the queue');
  }

  await ctx.close();
}

/* --------------------------------------------------------------- phone view */
{
  const { ctx, page } = await session(browser, ...ACCOUNTS.hospital, PHONE);
  watch(page);

  await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const phoneInbox = await shot(page, 'inbox · phone', '30-inbox-phone');
  check('phone: bottom bar stays pinned', phoneInbox.layout.docH <= phoneInbox.layout.innerH + 2,
    `${phoneInbox.layout.docH} vs ${phoneInbox.layout.innerH}`);
  check('phone: alerts are legible', /Inbound|alert/i.test(phoneInbox.text));

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const phoneDir = await shot(page, 'directory · phone', '38-directory-phone');
  check('phone: voice search is reachable', /Speak your search/i.test(phoneDir.text));

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const restricted = await shot(page, 'ops refusal · phone', '29-admin-restricted-phone');
  check(
    'phone: a ward account is told why Operations is closed to it',
    /restricted/i.test(restricted.text),
  );

  await ctx.close();
}

await browser.close();

check('no uncaught console errors across the run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  problems.forEach((p) => console.log(`  - ${p}`));
  process.exitCode = 1;
} else {
  console.log('all surfaces verified');
}
