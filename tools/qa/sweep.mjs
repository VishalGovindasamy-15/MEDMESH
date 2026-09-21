/**
 * Full-surface sweep.
 *
 * Visits every route in the app at both a desktop and a phone viewport, as the
 * role that owns it, and reports console errors, horizontal overflow and any
 * route that fails to render its distinguishing content. This is the "is every
 * page working" check — it is deliberately dumb and exhaustive rather than
 * clever, because the failures worth catching here are always the ones nobody
 * thought to look at.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const OUT = '/home/user/medmesh/docs/shots';
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const PEOPLE = {
  anon: null,
  dispatcher: ['dispatch@medmesh.in', 'Dispatch@108'],
  hospital: ['admin@srmc.medmesh.in', 'Hospital@2026'],
  driver: ['crew@medmesh.in', 'Crew@108'],
  gov: ['gov@medmesh.in', 'District@2026'],
  admin: ['admin@medmesh.in', 'MedMesh@2026'],
};

/** route, who, what must appear, what the screenshot is called */
const ROUTES = [
  ['/', 'anon', /facilities reporting|Where is care available/i, 'directory'],
  ['/doctors', 'anon', /doctor|on duty/i, 'doctors'],
  ['/facility/2', 'anon', /beds|capacity|ICU/i, 'facility'],
  ['/onboard', 'anon', /Add your hospital|Register a facility/i, 'onboard'],
  ['/sign-in', 'anon', /Sign in|password/i, 'signin'],
  ['/console', 'dispatcher', /dispatch|incident|shortlist/i, 'console'],
  ['/console/2', 'dispatcher', /case|incident|hospital/i, 'case'],
  ['/inbox', 'dispatcher', /Inbox|alert/i, 'inbox-dispatcher'],
  ['/dashboard', 'hospital', /My facility|published figures|capacity/i, 'dashboard'],
  ['/inbox', 'hospital', /Inbox|alert/i, 'inbox-hospital'],
  ['/crew', 'driver', /trip|destination|crew/i, 'crew'],
  ['/analytics', 'gov', /district|occupancy|analytics/i, 'analytics'],
  ['/analytics/1', 'gov', /Coimbatore|occupancy|ICU/i, 'analytics-district'],
  ['/account', 'admin', /account|session|role/i, 'account'],
  ['/admin', 'admin', /Who can do what|Platform operations/i, 'admin'],
  ['/facility/2', 'anon', /antivenom|blood|beds/i, 'facility-anon'],
];

const problems = [];
const browser = await chromium.launch();

async function signIn(page, email, password) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('name@hospital.gov.in').fill(email);
  await page.getByPlaceholder('••••••••••').fill(password);
  await page.getByText('Sign in', { exact: true }).last().click();
  await page.waitForTimeout(2400);
}

async function visit(page, route, expectation, label, viewportName, shot) {
  const errors = [];
  const handler = (m) => {
    if (m.type() === 'error') errors.push(m.text());
  };
  page.on('console', handler);

  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1800);

  const text = await page.innerText('body').catch(() => '');
  const metrics = await page.evaluate(() => ({
    docScrollH: document.documentElement.scrollHeight,
    docScrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    nodes: document.querySelectorAll('body *').length,
  }));
  await page.screenshot({ path: `${OUT}/${shot}-${viewportName}.png`, fullPage: false });
  page.off('console', handler);

  const tag = `${route} [${viewportName}]`;
  const overflow = metrics.docScrollW > metrics.innerW + 2;
  const blank = metrics.nodes < 40;
  const matched = expectation.test(text);

  if (overflow) problems.push(`${tag} overflows horizontally (${metrics.docScrollW} > ${metrics.innerW})`);
  if (blank) problems.push(`${tag} rendered almost nothing (${metrics.nodes} nodes)`);
  if (!matched) problems.push(`${tag} missing expected content ${expectation}`);
  if (errors.length) problems.push(`${tag} console errors: ${errors.slice(0, 2).join(' | ')}`);

  const status = overflow || blank || !matched || errors.length ? ' FAIL ' : '  ok  ';
  console.log(
    `${status} ${tag.padEnd(28)} nodes=${String(metrics.nodes).padEnd(5)} w=${metrics.docScrollW}` +
      `${errors.length ? ` err=${errors.length}` : ''}${!matched ? ' (no match)' : ''}`,
  );
}

for (const [who, creds] of Object.entries(PEOPLE)) {
  if (!creds) continue;
  for (const viewportName of ['desktop', 'phone']) {
    const ctx = await browser.newContext({ viewport: viewportName === 'desktop' ? DESKTOP : PHONE });
    const page = await ctx.newPage();
    await signIn(page, ...creds);
    const routes = ROUTES.filter(([, role]) => role === who);
    for (const [route, , exp, shot] of routes) {
      await visit(page, route, exp, who, viewportName, shot);
    }
    await ctx.close();
  }
}

// The anonymous routes are the ones a member of the public hits with no session.
for (const viewportName of ['desktop', 'phone']) {
  const ctx = await browser.newContext({ viewport: viewportName === 'desktop' ? DESKTOP : PHONE });
  const page = await ctx.newPage();
  for (const [route, who, exp, shot] of ROUTES.filter(([, r]) => r === 'anon')) {
    await visit(page, route, exp, 'anon', viewportName, shot);
  }
  await ctx.close();
}

await browser.close();

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  problems.forEach((p) => console.log(`  - ${p}`));
  process.exitCode = 1;
} else {
  console.log('all routes clean on both viewports');
}
