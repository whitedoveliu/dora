import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

/**
 * Console render check: every route, real browser, real API.
 * Usage: node check-console.mjs <baseUrl> <token> <outDir>
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8555';
const token = process.argv[3] ?? readFileSync('/tmp/browser-check-data/admin.token', 'utf8').trim();
const outDir = process.argv[4] ?? '/tmp/browser-check';
mkdirSync(outDir, { recursive: true });

const routes = ['/overview', '/sessions', '/connectors', '/tools', '/skills', '/memory', '/observations', '/vault', '/channels'];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
page.on('pageerror', (err) => consoleErrors.push('uncaught: ' + String(err.message).slice(0, 200)));
page.on('requestfailed', (req) => failedRequests.push(req.url() + ' :: ' + (req.failure()?.errorText ?? '')));
page.on('response', (res) => { if (res.status() >= 400) failedRequests.push(res.status() + ' ' + res.url()); });

// Establish the token once; the console persists it in localStorage.
await page.goto(base + '/?token=' + token, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const results = [];
for (const route of routes) {
  const before = { console: consoleErrors.length, failed: failedRequests.length };
  await page.goto(base + '/?token=' + token + '#' + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const text = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const shot = outDir + '/' + route.replace(/\//g, '') + '.png';
  await page.screenshot({ path: shot });
  results.push({
    route,
    textLength: text.length,
    heading: text.slice(0, 90),
    consoleErrors: consoleErrors.slice(before.console),
    failedRequests: failedRequests.slice(before.failed),
    screenshot: shot,
    verdict: text.length > 60 && consoleErrors.length === before.console ? 'renders' : text.length > 60 ? 'renders-with-errors' : 'empty'
  });
}

// One interaction per page that must not mutate data.
await page.goto(base + '/?token=' + token + '#/tools', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
const toolSearch = page.locator('input[type="search"], input[placeholder*="earch"], input[placeholder*="filter"]').first();
let interaction = 'no search box found';
if (await toolSearch.count() > 0) {
  await toolSearch.fill('gmail');
  await page.waitForTimeout(600);
  interaction = 'typed into the tools filter: ' + ((await page.locator('main').innerText()).match(/gmail\.[a-z-]+/g) ?? []).slice(0, 3).join(', ');
}
await page.screenshot({ path: outDir + '/tools-filtered.png' });

await browser.close();
console.log(JSON.stringify({ base, routes: results, interaction, consoleErrorTotal: consoleErrors.length, failedRequestTotal: failedRequests.length }, null, 2));
