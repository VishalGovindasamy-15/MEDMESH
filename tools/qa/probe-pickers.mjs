/**
 * Round-3 pickers — every district/vehicle/location selector the audit named.
 *
 * One check per numbered finding: the searchable DistrictPicker on onboarding,
 * admin create-user, admin edit-user, fleet filter, fleet create form, fleet
 * edit form, the doctors board (with clinician counts), the FacilityPicker's
 * district section, and the 108 location-source chooser including all four
 * sources end-to-end through the API record.
 *
 * Run:  BASE=http://127.0.0.1:8080 node probe-pickers.mjs
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

/* Sign in through the real form. Storage is cleared first: a token left over
   from a previous probe silently skips the form and every assertion after it
   runs against the wrong account. */
async function signIn(page, email, password) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.getByPlaceholder('name@hospital.gov.in').fill(email);
  await page.getByPlaceholder('••••••••••').fill(password);
  await page.getByText('Sign in', { exact: true }).last().click();
  await page.waitForTimeout(3000);
}


/* The pickers render inline, so "is X inside the picker" cannot be answered
   from body text — the page behind still contains its own "All districts"
   button. Scope to the ancestor box that holds the panel's own heading. */
function panel(page, anchor) {
  return page.getByText(anchor).first().locator('xpath=ancestor::div[3]');
}

async function tokenOf(page) {
  return page.evaluate(() => localStorage.getItem('medmesh.token'));
}

/* =================================================================== admin */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await signIn(page, 'admin@medmesh.in', 'MedMesh@2026');
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  /* ------------------------------------------- #2 create-user, per role ---- */
  await page.getByRole('button', { name: /add a user/i }).first().click();
  await page.waitForTimeout(1200);
  let body = await page.innerText('body');
  ok('create form is open', /Initial password/i.test(body));

  // hospital_admin: Facility only, no district jurisdiction field.
  await page.getByRole('tab', { name: /^Hospital$/i }).first().click();
  await page.waitForTimeout(700);
  body = await page.innerText('body');
  ok(
    'hospital_admin gets a facility picker, not a district one',
    /Facility/i.test(body) && !/Jurisdiction/i.test(body),
  );
  const facBtn = page.getByText(/Choose from \d+ facilities/i).first();
  if (await facBtn.count()) {
    await facBtn.click();
    await page.waitForTimeout(900);
    body = await page.innerText('body');
    // #8: the facility picker carries a real district section, not 8 chips.
    // Placeholders never appear in innerText — count the input itself.
    const searchInputs = await page.getByPlaceholder('Search facility by name or district').count();
    const facPanel = panel(page, 'Choose a facility|Facility this account reports for');
    const panelText = (await facPanel.innerText().catch(() => body));
    ok(
      'facility picker has a district filter section',
      searchInputs > 0 && /All districts/i.test(panelText) && /District/i.test(panelText),
      `inputs=${searchInputs}`,
    );
    await page.getByText('Close', { exact: true }).last().click().catch(() => {});
    await page.waitForTimeout(500);
  } else {
    ok('facility picker has a district filter section', false, 'picker button not found');
  }

  // dispatcher: Jurisdiction picker, no All row.
  await page.getByRole('tab', { name: /^Dispatcher$/i }).first().click();
  await page.waitForTimeout(700);
  body = await page.innerText('body');
  ok('dispatcher form says Jurisdiction', /Jurisdiction/i.test(body));
  await page.getByText(/Choose district/i).first().click();
  await page.waitForTimeout(900);
  body = await page.innerText('body');
  ok(
    'jurisdiction picker lists all 38, most facilities first',
    /38 of 38 shown, most facilities first/i.test(body),
  );
  ok(
    'jurisdiction picker has no "All districts" row (hideAll)',
    !/All districts/i.test(body),
  );
  await page.getByPlaceholder('District or headquarters').fill('salem');
  await page.waitForTimeout(600);
  body = await page.innerText('body');
  ok('jurisdiction picker searches', /1 of 38 shown/i.test(body), (body.match(/\d+ of 38 shown/i) || [])[0]);
  await page.getByText(/^Salem/i).first().click();
  await page.waitForTimeout(700);
  body = await page.innerText('body');
  ok('jurisdiction picker applies the choice', /Salem/i.test(body) && !/Choose a district/i.test(body));

  // driver: Reporting district + Vehicle picker.
  await page.getByRole('tab', { name: /^Crew$/i }).first().click();
  await page.waitForTimeout(700);
  body = await page.innerText('body');
  ok('driver form says Reporting district', /Reporting district/i.test(body));
  ok('driver form offers a vehicle picker', /uncrewed vehicles/i.test(body), (body.match(/Choose from \d+ uncrewed vehicles/i) || [])[0]);
  const vehBtn = page.getByText(/Choose from \d+ uncrewed vehicles/i).first();
  if (await vehBtn.count()) {
    await vehBtn.click();
    await page.waitForTimeout(900);
    body = await page.innerText('body');
    ok('vehicle picker lists units with capability and base district', /Vehicles without a crew/i.test(body));
    await page.getByText('Close', { exact: true }).last().click().catch(() => {});
    await page.waitForTimeout(400);
  } else {
    ok('vehicle picker lists units with capability and base district', false, 'button not found');
  }
  await page.screenshot({ path: `${SHOTS}/90-create-user-pickers.png` });
  await page.getByText('Close', { exact: true }).last().click().catch(() => {});
  await page.waitForTimeout(600);

  /* ------------------------------------------------- #3 edit-user form ----- */
  const editBtn = page.getByRole('button', { name: /^Edit$/i }).first();
  await editBtn.click();
  await page.waitForTimeout(1200);
  body = await page.innerText('body');
  ok('edit panel is open', /Save changes/i.test(body));
  // The first account is a platform admin — no district field. Pick a
  // dispatcher row instead: find an Edit button inside a row that says Dispatch.
  const rows = page.locator('div').filter({ hasText: /^Dispatch$/i });
  let editedDispatcher = false;
  const allEdits = page.getByRole('button', { name: /^Edit$/i });
  const n = await allEdits.count();
  for (let i = 0; i < n; i += 1) {
    const rowText = await allEdits.nth(i).locator('xpath=ancestor::div[2]').innerText().catch(() => '');
    if (/Dispatch/i.test(rowText) && !/Platform/i.test(rowText)) {
      await allEdits.nth(i).click();
      await page.waitForTimeout(1200);
      const t2 = await page.innerText('body');
      if (/Save changes/i.test(t2) && /Jurisdiction/i.test(t2)) {
        editedDispatcher = true;
        // open the jurisdiction picker inside the edit panel only — the user
        // list behind it also contains district names, and .first() hit that.
        // Open the jurisdiction picker inside the edit panel. The panel's
        // DistrictField button is the only control on the page carrying
        // aria-expanded, so that attribute is the locator — the user list
        // behind the panel also contains district names and .first() hit that.
        // The panel's DistrictField button reads "<District> · 12 facilities";
        // that shape is unique to the field while the panel is open.
        await page.getByRole('button', { name: /\d+ facilities/i }).first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(900);
        const t3 = await page.innerText('body');
        const pickerOpen = /Choose a district/i.test(t3) && /of 38 shown/i.test(t3);
        ok('edit-user district control is the searchable picker', pickerOpen);
        if (pickerOpen) {
          const dp = panel(page, 'Choose a district');
          const dpText = await dp.innerText().catch(() => '');
          ok('edit-user picker hides "All districts"', !/All districts/i.test(dpText));
        } else {
          ok('edit-user picker hides "All districts"', false, 'picker did not open');
        }
        await page.getByText('Close', { exact: true }).last().click().catch(() => {});
        await page.waitForTimeout(400);
      }
      break;
    }
  }
  ok('edit-user form reached for a dispatcher', editedDispatcher);
  await page.getByText('Cancel', { exact: true }).last().click().catch(() => {});
  await page.waitForTimeout(500);

  /* --------------------------------------- #5/#6 fleet filter and forms ---- */
  await page.getByText(/^Fleet \d+/i).first().click();
  await page.waitForTimeout(2500);
  body = await page.innerText('body');
  ok('fleet tab lists the units', /\d+ units|108-TN[A-Z]{3}/i.test(body));

  // #5: the filter is the All-supporting picker, counted in units.
  const filterField = page.getByText(/^All districts$/i).first();
  ok('fleet filter reads "All districts"', await filterField.count() > 0);
  await filterField.click();
  await page.waitForTimeout(900);
  body = await page.innerText('body');
  ok(
    'fleet filter picker counts units per district',
    /38 of 38 shown/i.test(body) && /units/i.test(body),
  );
  ok('fleet filter picker keeps the All row', /All districts/i.test(body));
  await page.getByPlaceholder('District or headquarters').fill('salem');
  await page.waitForTimeout(600);
  await page.getByText(/^Salem/i).first().click();
  await page.waitForTimeout(1200);
  body = await page.innerText('body');
  ok('fleet filter applies Salem', /Salem/i.test(body));
  const salemUnits = (body.match(/108-TN[A-Z]{3}-\d{4}/g) || []).length;
  // clear back through the picker's All row
  await page.getByText(/^Salem$/i).first().click();
  await page.waitForTimeout(800);
  await page.getByText(/^All districts$/i).first().click();
  await page.waitForTimeout(1200);
  body = await page.innerText('body');
  ok('fleet filter clears back to all', (body.match(/108-TN[A-Z]{3}-\d{4}/g) || []).length > salemUnits, `${salemUnits} → ${(body.match(/108-TN[A-Z]{3}-\d{4}/g) || []).length}`);
  await page.screenshot({ path: `${SHOTS}/91-fleet-filter.png` });

  // #4: the create form's base-district picker must NOT offer All.
  await page.getByRole('button', { name: /add a vehicle/i }).first().click();
  await page.waitForTimeout(1200);
  body = await page.innerText('body');
  ok('add-vehicle form is open', /Call sign/i.test(body));
  await page.getByText(/^Select district$/i).first().click();
  await page.waitForTimeout(900);
  body = await page.innerText('body');
  ok('vehicle form picker is searchable', /Choose a district/i.test(body) && /38 of 38 shown/i.test(body));
  {
    // The filter field behind the form says "All districts"; only the panel's
    // own text answers whether the FORM picker offers that row.
    const dp = panel(page, 'Choose a district');
    const dpText = await dp.innerText().catch(() => body);
    ok('vehicle form picker has no All row', !/All districts/i.test(dpText));
  }
  await page.getByText('Close', { exact: true }).last().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^Close$/i }).first().click().catch(() => {});
  await page.waitForTimeout(600);

  // #6: the edit form's district control.
  const firstEdit = page.getByRole('button', { name: /^Edit$/i }).first();
  await firstEdit.click();
  await page.waitForTimeout(1400);
  body = await page.innerText('body');
  const modalHead = (body.match(/Edit (108-[A-Z0-9-]+)/i) || [])[1];
  ok('edit-vehicle modal is open', Boolean(modalHead), modalHead ?? '');
  // The modal's district field has showCount off, so its button reads as the
  // unit's current base district with no count to match on. Anchor on the
  // field's own label instead: the modal's "Base district" is the last on the
  // page (the filter's is behind the overlay), and the field button is the
  // next role=button after it in document order.
  await page.getByText(/^Base district$/i).last()
    .locator('xpath=following::*[@role="button"][1]')
    .click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);
  body = await page.innerText('body');
  {
    const opened = /Choose a district/i.test(body);
    const dp = panel(page, 'Choose a district');
    const dpText = opened ? await dp.innerText().catch(() => '') : '';
    ok(
      'edit-vehicle district control is the searchable picker, no All row',
      opened && /38 of 38 shown/i.test(dpText) && !/All districts/i.test(dpText),
    );
  }
  await page.screenshot({ path: `${SHOTS}/92-fleet-edit.png` });
  await page.getByText('Close', { exact: true }).last().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^Cancel$/i }).first().click().catch(() => {});
  await ctx.close();
}

/* ================================================================= doctors */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/doctors`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  let body = await page.innerText('body');
  // #7: the field itself states the roster size behind "All districts".
  ok(
    'doctors district field offers All districts with a count',
    /All districts — \d+/i.test(body),
    (body.match(/All districts — \d+ [a-z ]+/i) || [])[0],
  );
  await page.getByText(/All districts — \d+/i).first().click();
  await page.waitForTimeout(1000);
  body = await page.innerText('body');
  ok('doctors picker is searchable', /Choose a district/i.test(body) && /38 of 38 shown/i.test(body));
  ok('doctors picker counts clinicians, not facilities', /clinicians/i.test(body));
  ok('doctors picker keeps the All row', /All districts/i.test(body));
  await page.getByPlaceholder('District or headquarters').fill('erode');
  await page.waitForTimeout(600);
  body = await page.innerText('body');
  ok('doctors picker searches', /1 of 38 shown/i.test(body));
  await page.screenshot({ path: `${SHOTS}/93-doctors-district.png` });
  await page.getByText(/^Erode/i).first().click();
  await page.waitForTimeout(1200);
  body = await page.innerText('body');
  ok('doctors filter applies', /Erode/i.test(body));
  await ctx.close();
}

/* ================================================================ onboard */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/onboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  // walk to the location step: the district field lives in step 2/3
  let body = await page.innerText('body');
  const nextBtn = page.getByRole('button', { name: /^Continue$|^Next$/i }).first();
  for (let i = 0; i < 3 && !(await page.getByText(/^Select district$/i).count()); i += 1) {
    if (await nextBtn.count()) await nextBtn.click().catch(() => {});
    await page.waitForTimeout(900);
  }
  body = await page.innerText('body');
  const districtBtn = page.getByText(/^Select district$/i).first();
  ok('#1 onboarding district control is a picker button', await districtBtn.count() > 0);
  ok('#1 onboarding no longer renders 38 district buttons', !(await page.getByRole('button', { name: /Kanyakumari/i }).count()));
  if (await districtBtn.count()) {
    await districtBtn.click();
    await page.waitForTimeout(900);
    body = await page.innerText('body');
    ok('onboarding picker is searchable, all 38', /Choose a district/i.test(body) && /38 of 38 shown/i.test(body));
    ok('onboarding picker has no All row (a facility is somewhere)', !/All districts/i.test(body));
    await page.getByPlaceholder('District or headquarters').fill('kanyakumari');
    await page.waitForTimeout(600);
    body = await page.innerText('body');
    ok('onboarding picker finds Kanyakumari by search', /1 of 38 shown/i.test(body), (body.match(/\d+ of 38 shown/i) || [])[0]);
    await page.screenshot({ path: `${SHOTS}/94-onboard-district.png` });
    await page.getByText('Close', { exact: true }).last().click().catch(() => {});
  }
  await ctx.close();
}

/* ================================================================= console */
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['geolocation'],
    geolocation: { latitude: 11.0168, longitude: 76.9558 },
  });
  const page = await ctx.newPage();
  await signIn(page, 'dispatch@medmesh.in', 'Dispatch@108');
  const token = await tokenOf(page);
  await page.goto(`${BASE}/console`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  // The intake is inline at 1440px.
  let body = await page.innerText('body');
  if (!/How do you know the location/i.test(body)) {
    await page.getByRole('button', { name: /new incident|raise|create/i }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
    body = await page.innerText('body');
  }
  ok('#14 intake asks "How do you know the location?"', /How do you know the location/i.test(body));
  ok('#14 four sources are offered', /Caller gave coordinates/i.test(body) && /Device location/i.test(body) && /Drop a pin on the map/i.test(body) && /District centre/i.test(body));
  ok('#14 exact sources are badged ● EXACT', (body.match(/● EXACT/g) || []).length >= 3, `${(body.match(/● EXACT/g) || []).length} badges`);
  ok('#14 the fallback is badged ○ APPROX', /○ APPROX/i.test(body));

  /* The simulator raises its own incidents, so "the newest incident" is not
     reliably the one this probe just created. Capture the reference the
     console shows after creation and fetch that record by reference. */
  let lastRef = null;
  const latestIncident = async (page) => {
    const body = await page.innerText('body').catch(() => '');
    const refs = [...body.matchAll(/TN-\d{4}-[A-Z0-9]{3}/g)].map((m) => m[0]);
    const ref = refs.length ? refs[refs.length - 1] : lastRef;
    const r = await fetch(`${API}/incidents?limit=25`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    const rows = j.results ?? [];
    const byRef = ref ? rows.find((x) => x.reference === ref) : null;
    if (byRef) lastRef = byRef.reference;
    return byRef ?? rows[0] ?? null;
  };

  /* ---- source 1: caller coordinates ---- */
  await page.getByText(/^Caller gave coordinates$/i).first().click();
  await page.waitForTimeout(800);
  await page.getByPlaceholder('11.01684').fill('11.02340');
  await page.getByPlaceholder('76.95583').fill('76.91230');
  await page.getByRole('button', { name: /use these/i }).first().click();
  await page.waitForTimeout(900);
  body = await page.innerText('body');
  ok('coordinates fix badged ● EXACT', /● EXACT/i.test(body) && /from the caller's coordinates/i.test(body));
  await page.getByRole('button', { name: /Create incident & find hospital/i }).first().click();
  await page.waitForTimeout(3500);
  let inc = await latestIncident(page);
  ok('incident created from caller coordinates', Boolean(inc) && inc.location_source === 'manual', inc ? inc.location_source : 'none');
  ok('coordinates record is not approximate', Boolean(inc) && inc.location_approximate === false);

  /* ---- reopen the intake for the next source ---- */
  await page.goto(`${BASE}/console`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  body = await page.innerText('body');
  if (!/How do you know the location/i.test(body)) {
    await page.getByRole('button', { name: /new incident|raise|create/i }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  /* ---- source 2: device location ---- */
  await page.getByText(/^Device location$/i).first().click();
  await page.waitForTimeout(2500);
  body = await page.innerText('body');
  ok('device fix badged ● EXACT and attributed', /● EXACT/i.test(body) && /from this device/i.test(body));
  await page.getByRole('button', { name: /Create incident & find hospital/i }).first().click();
  await page.waitForTimeout(3500);
  inc = await latestIncident(page);
  ok('incident created from device GPS', Boolean(inc) && inc.location_source === 'gps', inc ? inc.location_source : 'none');

  await page.goto(`${BASE}/console`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  body = await page.innerText('body');
  if (!/How do you know the location/i.test(body)) {
    await page.getByRole('button', { name: /new incident|raise|create/i }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  /* ---- source 3: map pin ---- */
  await page.getByText(/^Drop a pin on the map$/i).first().click();
  await page.waitForTimeout(1200);
  const pinLayer = page.getByLabel('Tap to place a point').first();
  ok('map offers a tap-to-place surface', await pinLayer.count() > 0);
  if (await pinLayer.count()) {
    const box = await pinLayer.boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.45);
    await page.waitForTimeout(1000);
    body = await page.innerText('body');
    ok('map pin badged ● EXACT and attributed', /● EXACT/i.test(body) && /dropped on the map/i.test(body));
    ok('map pin produced a real coordinate', /1[01]\.\d{5}, 7[67]\.\d{5}/.test(body), (body.match(/1[01]\.\d{5}, 7[67]\.\d{5}/) || [])[0]);
    await page.getByRole('button', { name: /Create incident & find hospital/i }).first().click();
    await page.waitForTimeout(3500);
    inc = await latestIncident(page);
    ok('incident created from map pin', Boolean(inc) && inc.location_source === 'map', inc ? inc.location_source : 'none');
  }

  await page.goto(`${BASE}/console`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  body = await page.innerText('body');
  if (!/How do you know the location/i.test(body)) {
    await page.getByRole('button', { name: /new incident|raise|create/i }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  /* ---- source 4: district centre (approximate) ---- */
  await page.getByText(/District centre —/i).first().click();
  await page.waitForTimeout(1000);
  body = await page.innerText('body');
  ok('district centre badged ○ APPROXIMATE', /○ APPROXIMATE/i.test(body));
  ok('district centre warns it is not the caller', /district centre, not the caller/i.test(body));
  await page.screenshot({ path: `${SHOTS}/95-location-approx.png` });
  await page.getByRole('button', { name: /Create incident & find hospital/i }).first().click();
  await page.waitForTimeout(3500);
  inc = await latestIncident(page);
  ok('incident created from district centre', Boolean(inc) && inc.location_source === 'district', inc ? inc.location_source : 'none');
  ok('district centre record IS flagged approximate', Boolean(inc) && inc.location_approximate === true);

  await ctx.close();
}

/* ============================================================ 360px sweep */
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const page = await ctx.newPage();
  for (const [route, who] of [['/', null], ['/doctors', null], ['/onboard', null], ['/console', 'dispatch@medmesh.in'], ['/admin', 'admin@medmesh.in']]) {
    if (who === 'admin@medmesh.in') await signIn(page, 'admin@medmesh.in', 'MedMesh@2026');
    if (who === 'dispatch@medmesh.in') await signIn(page, 'dispatch@medmesh.in', 'Dispatch@108');
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3200);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(`360px: ${route} does not overflow`, w <= 362, `scrollWidth ${w}`);
  }
  await ctx.close();
}

await browser.close();
console.log(problems.length ? `\n${problems.length} PROBLEM(S): ${problems.join('; ')}` : '\nALL PICKER CHECKS PASSED');
process.exit(problems.length ? 1 : 0);
