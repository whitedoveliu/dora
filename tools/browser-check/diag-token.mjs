import { chromium } from 'playwright';
const base = process.argv[2];
const token = process.argv[3];
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
await page.goto(base + '/?token=' + token, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const stored = await page.evaluate(() => { try { return localStorage.getItem('dora.token'); } catch { return 'ERR'; } });
const probe = await page.evaluate(async (t) => {
  const res = await fetch('/api/overview', { headers: { authorization: 'Bearer ' + t } });
  return { status: res.status, len: (await res.text()).length };
}, token);
console.log(JSON.stringify({ url: page.url(), stored: stored ? stored.slice(0, 10) + '…' : null, tokenArg: token.slice(0, 10) + '…', probe, errors: errors.slice(0, 3) }, null, 1));
await browser.close();
