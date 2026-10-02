/**
 * Small-phone layout sweep — 360 / 390 / 430 px.
 *
 * #19/#20: every surface at the three widths real handsets ship, plus the
 * Tamil directory at 360px (the longest strings in the app). The check is
 * behavioural: nothing may be wider than the viewport, with one exemption —
 * elements inside a genuine horizontal scroller (the segmented strips) are
 * allowed to exceed it, because that is what a scroller is for.
 *
 * Run:  BASE=http://127.0.0.1:8080 node probe-mobile-widths.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const SHOTS = process.env.SHOTS || '/home/user/medmesh/tools/qa/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [360, 390, 430];

/** route, who signs in, what must render */
const SURFACES = [
  ['/', null, /Where is care available|facilities reporting/i],
  ['/doctors', null, /on duty|clinician/i],
  ['/facility/2', null, /beds|capacity|ICU/i],
  ['/onboard', null, /Register a facility|Add your hospital/i],
  ['/sign-in', null, /Sign in|password/i],
  ['/console', 'dispatch', /incident|dispatch|fleet/i],
  ['/console/2', 'dispatch', /case|incident|hospital/i],
  ['/inbox', 'dispatch', /inbox|alert/i],
  ['/dashboard', 'hospital', /published figures|capacity|quick update/i],
  ['/crew', 'driver', /trip|standing by|destination/i],
  ['/analytics', 'gov', /district|occupancy/i],
  ['/admin', 'admin', /who can do what|platform/i],
];

const PEOPLE = {
  dispatch: ['dispatch@medmesh.in', 'Dispatch@108'],
  hospital: ['admin@kgch.medmesh.in', 'Hospital@2026'],
  driver: ['crew@medmesh.in', 'Crew@108'],
  gov: ['gov@medmesh.in', 'District@2026'],
  admin: ['admin@medmesh.in', 'MedMesh@2026'],
};

const browser = await chromium.launch();
const problems = [];
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) problems.push(name);
};

async function signIn(page, email, password) {
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

/**
 * Widest offending element, ignoring anything inside a real horizontal
 * scroller. Returns {w, tag, text} of the worst offender or null.
 */
async function worstOverflow(page, viewportW) {
  return page.evaluate((vw) => {
    const inScroller = (el) => {
      let p = el.parentElement;
      while (p) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
        p = p.parentElement;
      }
      return false;
    };
    let worst = null;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const over = r.right - vw;
      if (over <= 2) continue;
      if (inScroller(el)) continue;
      const w = Math.round(r.right);
      if (!worst || w > worst.w) {
        worst = {
          w,
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 40),
        };
      }
    }
    return worst;
  }, viewportW);
}

for (const width of WIDTHS) {
  console.log(`\n== ${width}px ==`);
  for (const [route, who, expect] of SURFACES) {
    const ctx = await browser.newContext({
      viewport: { width, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    });
    const page = await ctx.newPage();
    if (who) await signIn(page, ...PEOPLE[who]);
    // The crew screen holds a live socket: networkidle never fires there.
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3200);
    const text = await page.innerText('body').catch(() => '');
    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    const worst = await worstOverflow(page, width);
    const renders = expect.test(text);
    const pass = docW <= width + 2 && !worst && renders;
    ok(
      `${route} @${width}`,
      pass,
      [
        docW > width + 2 ? `doc ${docW}` : '',
        worst ? `worst ${worst.w}px <${worst.tag}> "${worst.text}"` : '',
        renders ? '' : 'missing content',
      ].filter(Boolean).join(' · '),
    );
    if (width === 360 && !pass) {
      await page.screenshot({ path: `${SHOTS}/96-fail-${route.replace(/\W/g, '_')}-360.png` }).catch(() => {});
    }
    await ctx.close();
  }
}

/* ------------------------------------------------------- Tamil @360 (#20) */
console.log('\n== Tamil @360 ==');
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800, isMobile: true, hasTouch: true } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.getByText('த', { exact: true }).first().click();
  await page.waitForTimeout(1400);
  const text = await page.innerText('body');
  ok('Tamil directory renders translated strings', /இப்போது எங்கே சிகிச்சை|சிகிச்சை/.test(text));
  const docW = await page.evaluate(() => document.documentElement.scrollWidth);
  const worst = await worstOverflow(page, 360);
  ok('Tamil @360 does not overflow', docW <= 362 && !worst, worst ? `worst ${worst.w}px "${worst.text}"` : `doc ${docW}`);
  await page.screenshot({ path: `${SHOTS}/97-tamil-360.png` }).catch(() => {});
  await ctx.close();
}

await browser.close();
console.log(problems.length ? `\n${problems.length} PROBLEM(S): ${problems.join('; ')}` : '\nALL WIDTH CHECKS PASSED');
process.exit(problems.length ? 1 : 0);
