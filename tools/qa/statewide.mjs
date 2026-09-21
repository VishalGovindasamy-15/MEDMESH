import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8080';
const OUT = '/home/user/medmesh/docs/shots';
const b = await chromium.launch();
const errs = [];

// Public directory with the full state
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(`dir: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && errs.push(`dir console: ${m.text()}`));
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
const text = await p.innerText('body');
const m = text.match(/(\d+)\s+of\s+(\d+)\s+shown/);
console.log('directory stats:', m ? m[0] : 'not found');
const districtsShown = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('button, [role="button"], div')];
  return btns.filter((b) => /^(Ariyalur|Chengalpattu|Chennai|Nilgiris|Kanyakumari|Tenkasi)$/.test((b.textContent||'').trim())).length;
});
console.log('statewide district chips present:', districtsShown);
await p.screenshot({ path: `${OUT}/40-directory-statewide.png` });
await ctx.close();

// Dispatcher console with routing disclosure
const dc = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const dp = await dc.newPage();
dp.on('pageerror', (e) => errs.push(`console: ${e.message}`));
await dp.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
await dp.getByPlaceholder('name@hospital.gov.in').fill('dispatch@medmesh.in');
await dp.getByPlaceholder('••••••••••').fill('Dispatch@108');
await dp.getByText('Sign in', { exact: true }).last().click();
await dp.waitForTimeout(2500);
await dp.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
await dp.waitForTimeout(2500);
const rows = dp.locator('a[href*="/console/"]');
const n = await rows.count();
console.log('incident queue rows:', n);
if (n > 0) {
  await rows.first().click();
  await dp.waitForTimeout(3000);
  const body = await dp.innerText('body');
  console.log('routing disclosure present:', /Ranked on|road drive time|straight-line estimates/.test(body));
  const line = body.split('\n').find((l) => /Ranked on/.test(l));
  console.log('disclosure reads:', line ? line.slice(0, 150) : '(none)');
  console.log('candidate provenance shown:', /via road|direct/.test(body));
  await dp.screenshot({ path: `${OUT}/41-console-routed.png` });
}
await dc.close();

console.log('page errors:', errs.length ? errs.slice(0, 4) : 'none');
await b.close();
