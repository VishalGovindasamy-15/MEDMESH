import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8080';
const OUT = '/home/user/medmesh/docs/shots';
const b = await chromium.launch();
const errs = [];
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));

await p.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
await p.getByPlaceholder('name@hospital.gov.in').fill('dispatch@medmesh.in');
await p.getByPlaceholder('••••••••••').fill('Dispatch@108');
await p.getByText('Sign in', { exact: true }).last().click();
await p.waitForTimeout(2500);

await p.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
await p.screenshot({ path: `${OUT}/41-console-queue-statewide.png` });

// Find an incident reference in the queue and open it
const refs = await p.evaluate(() =>
  [...document.querySelectorAll('*')]
    .map((n) => (n.children.length === 0 ? (n.textContent || '').trim() : ''))
    .filter((t) => /^TN-\d{4}-[A-Z0-9]{3}$/.test(t))
);
console.log('incident references on screen:', refs.length, refs.slice(0, 4));
if (refs.length) {
  await p.getByText(refs[0], { exact: true }).first().click();
  await p.waitForTimeout(3500);
  const body = await p.innerText('body');
  const line = body.split('\n').find((l) => /Ranked on /.test(l));
  console.log('routing disclosure:', line ? line.slice(0, 170) : 'NOT FOUND');
  console.log('candidate provenance shown:', /via road|direct/.test(body));
  console.log('shortlist size on screen:', (body.match(/\bkm\b/g) || []).length, 'distance mentions');
  await p.screenshot({ path: `${OUT}/42-console-routing-disclosure.png` });
}
console.log('errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
