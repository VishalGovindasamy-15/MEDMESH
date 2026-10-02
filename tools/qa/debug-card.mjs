import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
await page.goto('http://127.0.0.1:8080/sign-in', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.getByPlaceholder('name@hospital.gov.in').fill('admin@medmesh.in');
await page.getByPlaceholder('••••••••••').fill('MedMesh@2026');
await page.getByText('Sign in', { exact: true }).last().click();
await page.waitForTimeout(2500);
await page.goto('http://127.0.0.1:8080/admin', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const out = await page.evaluate(() => {
  const all = [...document.querySelectorAll('div')];
  const card = all.find(el => (el.innerText || '').startsWith('WHO CAN DO WHAT') && el.getBoundingClientRect().width > 500);
  if (!card) return 'no wide card';
  const st = getComputedStyle(card);
  const r = card.getBoundingClientRect();
  const lines = [];
  lines.push(`CARD ${Math.round(r.width)}w cls="${card.className}" inline="${(card.getAttribute('style')||'').slice(0,120)}"`);
  lines.push(`  computed: flex=${st.flex} width=${st.width} minWidth=${st.minWidth} maxWidth=${st.maxWidth} padding=${st.padding} display=${st.display}`);
  // every direct child with full detail
  for (const c of card.children) {
    const cs = getComputedStyle(c);
    const cr = c.getBoundingClientRect();
    lines.push(`  CHILD ${c.tagName} ${Math.round(cr.width)}w flex=${cs.flex} minW=${cs.minWidth} wrap=${cs.flexWrap} ovf=${cs.overflowX} disp=${cs.display} "${(c.innerText||'').slice(0,40).replace(/\n/g,'|')}"`);
    for (const g of c.children) {
      const gs = getComputedStyle(g);
      const gr = g.getBoundingClientRect();
      if (gr.width > 200) lines.push(`    GRAND ${g.tagName} ${Math.round(gr.width)}w flex=${gs.flex} minW=${gs.minWidth} wrap=${gs.flexWrap} ovf=${gs.overflowX} "${(g.innerText||'').slice(0,40).replace(/\n/g,'|')}"`);
    }
  }
  // parent + siblings
  const p = card.parentElement;
  const ps = getComputedStyle(p);
  lines.push(`PARENT ${p.tagName} ${Math.round(p.getBoundingClientRect().width)}w flex=${ps.flex} wrap=${ps.flexWrap} align=${ps.alignItems}`);
  for (const s of p.children) {
    if (s === card) continue;
    lines.push(`  SIB ${s.tagName} ${Math.round(s.getBoundingClientRect().width)}w "${(s.innerText||'').slice(0,30).replace(/\n/g,'|')}"`);
  }
  return lines.join('\n');
});
console.log(out);
await browser.close();
