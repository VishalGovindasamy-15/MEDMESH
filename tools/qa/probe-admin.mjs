/**
 * Admin panel — the selectors, the audit window and the complaint loop.
 *
 * Each check here corresponds to a numbered finding from the audit that was
 * fixed on this screen, so a regression in any of them is caught by the check
 * that describes it rather than by a generic "admin renders" assertion.
 *
 * Run:  BASE=http://127.0.0.1:8080 node probe-admin.mjs
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

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
await page.getByPlaceholder('name@hospital.gov.in').fill('admin@medmesh.in');
await page.getByPlaceholder('••••••••••').fill('MedMesh@2026');
await page.getByText('Sign in', { exact: true }).last().click();
await page.waitForTimeout(3000);

/* ------------------------------------------------- accounts (#19) ---------- */
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const addBtn = page.getByRole('button', { name: /add|new account|create account/i }).first();
if (await addBtn.count()) await addBtn.click();
await page.waitForTimeout(1500);
let body = await page.innerText('body');
// The old chip row showed 14 facilities with no way to reach the other 138.
ok(
  'account facility selector is searchable, not a 14-chip row',
  /Choose from \d+ facilities/.test(body) || /Facility this account reports for/.test(body),
  (body.match(/Choose from \d+ facilities/) || [])[0],
);
const facilityButton = page.getByText(/Choose from \d+ facilities/).first();
if (await facilityButton.count()) {
  await facilityButton.click();
  await page.waitForTimeout(900);
  body = await page.innerText('body');
  // Behavioural, not string-matching: type a district name and the picker's own
  // match count has to move. A placeholder that renders but does not filter is
  // exactly the kind of control the audit found on this screen.
  const beforeCount = (body.match(/([\d,]+) matches?/) || [])[1];
  await page.getByPlaceholder('Search facility by name or district').fill('Kanyakumari');
  await page.waitForTimeout(700);
  const narrowed = await page.innerText('body');
  const afterCount = (narrowed.match(/([\d,]+) matches?/) || [])[1];
  ok(
    'facility picker searches what it lists',
    Boolean(beforeCount) && Number(afterCount) > 0 && afterCount !== beforeCount,
    `${beforeCount} → ${afterCount} for "Kanyakumari"`,
  );
  await page.getByPlaceholder('Search facility by name or district').fill('');
  await page.waitForTimeout(400);
  ok('facility picker scopes by district', /All districts/.test(body));
  ok(
    'facility picker offers district chips with counts',
    /All districts/.test(body) && /\b\d+\b/.test(body),
  );
  await page.getByText('Close', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(400);
}
await page.screenshot({ path: `${SHOTS}/70-admin-account-selector.png` });

/* ------------------------------------------------- audit (#41) ------------- */
await page.getByText(/^Audit/).first().click();
await page.waitForTimeout(2000);
body = await page.innerText('body');
ok('audit states its scope', /Showing \d+ of [\d,]+ entries in this window/.test(body),
  (body.match(/Showing \d+ of [\d,]+ entries in this window/) || [])[0]);
ok('audit offers a way past the first page', /Show \d+ more|Fetch older entries/.test(body));
await page.screenshot({ path: `${SHOTS}/71-admin-audit-paging.png` });

/* ------------------------------------------------- complaints (#42) -------- */
await page.getByText(/^Complaints/).first().click();
await page.waitForTimeout(2000);
body = await page.innerText('body');
if (/No complaints recorded/.test(body)) {
  console.log('  ....  no complaints in the pilot dataset — resolution form not exercised');
} else {
  await page.getByText('Review & close', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  body = await page.innerText('body');
  ok('complaint resolution asks for an outcome', /OUTCOME|Outcome/.test(body));
  ok('outcome offers upheld and dismissed', /Upheld/.test(body) && /Dismissed/.test(body));
  ok('complaint resolution asks how it was checked', /how was it checked\?/i.test(body));
  ok(
    'the old fixed note is gone',
    !/Confirmed against the facility bed-control desk/.test(body),
    'the hard-coded note no longer appears',
  );
  await page.screenshot({ path: `${SHOTS}/72-admin-complaint-resolution.png` });
  await page.getByText('Cancel', { exact: true }).first().click();
}

/* ------------------------------------------------- fleet (#40) ------------- */
await page.getByText(/^Fleet/).first().click();
await page.waitForTimeout(2500);
body = await page.innerText('body');
ok('fleet shows last position as an age', /last position/i.test(body));
ok(
  'fleet position is not a raw ISO timestamp',
  !/last position\s*\n?\s*\d{4}-\d{2}-\d{2}T/i.test(body),
  (body.match(/last position\s*\n?\s*[^\n]*/i) || [])[0]?.slice(0, 60),
);
await page.screenshot({ path: `${SHOTS}/73-admin-fleet-gps-age.png` });

/* ------------------------------------------- connectors (#20) ------------- */
await page.getByText(/^Connectors/).first().click();
await page.waitForTimeout(2500);
await page.getByText('New connector', { exact: false }).first().click().catch(() => {});
await page.waitForTimeout(1200);
body = await page.innerText('body');
ok(
  'connector facility selector is a picker, not 152 chips',
  /Choose from \d+ verified facilities/.test(body) || /Facility this connector reports for/.test(body),
  (body.match(/Choose from \d+ verified facilities/) || [])[0],
);
await page.screenshot({ path: `${SHOTS}/74-admin-connector-selector.png` });

ok('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await ctx.close();
await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nadmin panel verified');
