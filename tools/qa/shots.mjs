import { chromium } from 'playwright';
const b = await chromium.launch();
const errs = [];

// Tamil directory — verify the corrected stat label and translated strings
const t = await b.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ta-IN' });
const tp = await t.newPage();
tp.on('pageerror', (e) => errs.push(`tamil: ${e.message}`));
await tp.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
await tp.evaluate(() => window.localStorage.setItem('medmesh.lang', 'ta'));
await tp.reload({ waitUntil: 'networkidle' });
await tp.waitForTimeout(1200);
const body = await tp.innerText('body');
console.log('reportingLive label present:', body.includes('நேரடி தகவல்'));
console.log('mislabel gone:', !/தெரிவித்த நேரம்[\s\S]{0,40}\d+\/\d+/.test(body));
await tp.screenshot({ path: '../../docs/shots/36-directory-tamil.png', fullPage: false });
await t.close();

// Crew — the screen that was crashing
const c = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const cp = await c.newPage();
cp.on('pageerror', (e) => errs.push(`crew: ${e.message}`));
await cp.goto('http://127.0.0.1:8080/sign-in', { waitUntil: 'networkidle' });
await cp.getByPlaceholder('name@hospital.gov.in').fill('crew@medmesh.in');
await cp.getByPlaceholder('••••••••••').fill('Crew@108');
await cp.getByText('Sign in', { exact: true }).last().click();
await cp.waitForTimeout(2500);
await cp.goto('http://127.0.0.1:8080/crew', { waitUntil: 'networkidle' });
await cp.waitForTimeout(2500);
const crewText = await cp.innerText('body');
console.log('crew renders:', crewText.length > 300, '| chars:', crewText.length);
await cp.screenshot({ path: '../../docs/shots/39-crew-trip.png' });
await c.close();

console.log('page errors:', errs.length ? errs : 'none');
await b.close();
