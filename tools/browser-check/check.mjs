#!/usr/bin/env node
/**
 * Headless-browser smoke check for the Dora.ai web console.
 * Lives in tools/browser-check/ (private, not part of the pnpm workspace).
 *
 * Usage: node check.mjs [--origin http://127.0.0.1:8555] [--out /tmp/browser-check]
 * Prints one JSON document on stdout. Screenshots land in the output directory.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const ORIGIN = arg('origin', process.env.CONSOLE_ORIGIN || 'http://127.0.0.1:8555');
const OUT = arg('out', '/tmp/browser-check');
const TOKEN_FILE = arg('token-file', '/tmp/browser-check-data/admin.token');
const SETTLE_MS = Number(arg('settle-ms', '15000'));

const ROUTES = ['/overview', '/sessions', '/connectors', '/tools', '/skills', '/memory', '/observations', '/vault', '/channels'];

let TOKEN = process.env.DORA_TOKEN || '';
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
  catch (err) { console.error('cannot read token file ' + TOKEN_FILE + ': ' + err.message); }
}

fs.mkdirSync(OUT, { recursive: true });

const consoleUrl = ORIGIN + '/?token=' + encodeURIComponent(TOKEN);

/* ------------------------------------------------------------ collectors -- */
function newCollector() {
  return { consoleErrors: [], pageErrors: [], failedRequests: [], allRequests: [], dialogs: [] };
}

function attach(page, c) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location();
    c.consoleErrors.push({
      text: msg.text(),
      location: loc && loc.url ? loc.url + ':' + loc.lineNumber + ':' + loc.columnNumber : null
    });
  });
  page.on('pageerror', (err) => {
    c.pageErrors.push({ message: String(err && err.message ? err.message : err), stack: String((err && err.stack) || '') });
  });
  page.on('requestfailed', (req) => {
    const f = req.failure();
    c.failedRequests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType(), error: f ? f.errorText : 'unknown', kind: 'requestfailed' });
  });
  page.on('response', (res) => {
    const status = res.status();
    const req = res.request();
    c.allRequests.push({ url: res.url(), status, method: req.method(), resourceType: req.resourceType() });
    if (status >= 400) {
      c.failedRequests.push({ url: res.url(), status, method: req.method(), resourceType: req.resourceType(), kind: 'http-' + status });
    }
  });
  page.on('dialog', (d) => {
    c.dialogs.push({ type: d.type(), message: d.message() });
    d.dismiss().catch(() => {});
  });
}

function dedupe(list, keyFn) {
  const seen = new Set(); const out = [];
  for (const item of list) { const k = keyFn(item); if (seen.has(k)) continue; seen.add(k); out.push(item); }
  return out;
}

/* ---------------------------------------------------------------- settle -- */
async function settle(page, budgetMs) {
  const started = Date.now();
  let last = null; let stableSince = Date.now();
  let snap = { text: '', loading: true, html: 0 };
  while (Date.now() - started < budgetMs) {
    snap = await page.evaluate(() => {
      const v = document.getElementById('view');
      if (!v) return { text: '', loading: false, html: 0, missingView: true };
      return { text: (v.innerText || '').trim(), loading: !!v.querySelector('.loading'), html: v.innerHTML.length, missingView: false };
    });
    if (snap.text !== last) { last = snap.text; stableSince = Date.now(); }
    if (!snap.loading && Date.now() - stableSince > 600) return { settled: true, waitedMs: Date.now() - started };
    await page.waitForTimeout(120);
  }
  return { settled: false, waitedMs: Date.now() - started, timedOut: true };
}

async function snapshot(page) {
  return page.evaluate(() => {
    const v = document.getElementById('view');
    const nav = document.getElementById('nav');
    const txt = (el) => (el && el.innerText ? el.innerText.trim() : '');
    return {
      hash: location.hash,
      title: document.title,
      navLinks: nav ? nav.querySelectorAll('a').length : 0,
      activeNav: nav && nav.querySelector('a[aria-current="page"]') ? nav.querySelector('a[aria-current="page"]').textContent.trim() : null,
      viewTextLength: txt(v).length,
      viewTextPreview: txt(v).slice(0, 240),
      viewHtmlLength: v ? v.innerHTML.length : 0,
      viewTextAll: txt(v),
      counts: {
        h1: v ? v.querySelectorAll('h1').length : 0,
        h2: v ? v.querySelectorAll('h2').length : 0,
        tables: v ? v.querySelectorAll('table').length : 0,
        tableRows: v ? v.querySelectorAll('tbody tr').length : 0,
        cards: v ? v.querySelectorAll('.card').length : 0,
        tiles: v ? v.querySelectorAll('.tile').length : 0,
        buttons: v ? v.querySelectorAll('button').length : 0,
        panels: v ? v.querySelectorAll('.panel').length : 0
      },
      headings: v ? Array.from(v.querySelectorAll('h1,h2,h3')).map((e) => e.textContent.trim()).slice(0, 14) : [],
      hasFailurePanel: !!(v && Array.from(v.querySelectorAll('.section-title')).some((e) => /could not load/i.test(e.textContent))),
      failureText: v && Array.from(v.querySelectorAll('.section-title')).some((e) => /could not load/i.test(e.textContent))
        ? txt(v).slice(0, 400) : null,
      banner: (() => { const b = document.getElementById('banner'); return b && !b.hidden ? txt(document.getElementById('banner-text')) : null; })(),
      healthChip: txt(document.getElementById('health-chip')),
      streamChip: txt(document.getElementById('stream-chip'))
    };
  });
}

function classify(snap, c, extraNote) {
  const errs = c.consoleErrors.length + c.pageErrors.length;
  const fails = c.failedRequests.length;
  let status = 'renders';
  if (snap.viewTextLength < 120 || snap.hasFailurePanel) status = 'broken';
  else if (errs > 0 || fails > 0) status = 'partial';
  return status;
}

/* ------------------------------------------------------- interactions ---- */
async function step(name, fn, results, page, c) {
  const beforeErrs = c.consoleErrors.length + c.pageErrors.length;
  const beforeFails = c.failedRequests.length;
  const started = Date.now();
  const entry = { name, ok: false, detail: null, newConsoleErrors: [], newFailedRequests: [], ms: 0 };
  try {
    entry.detail = await fn();
    entry.ok = true;
  } catch (err) {
    entry.ok = false;
    entry.detail = 'STEP FAILED: ' + (err && err.message ? err.message : String(err));
  }
  entry.ms = Date.now() - started;
  entry.newConsoleErrors = c.consoleErrors.slice(beforeErrs).concat(c.pageErrors.slice(0).filter(() => false));
  entry.newFailedRequests = c.failedRequests.slice(beforeFails);
  results.push(entry);
  return entry;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const c = newCollector();
  attach(page, c);

  const report = {
    startedAt: new Date().toISOString(),
    origin: ORIGIN,
    consoleUrl: consoleUrl.replace(/token=[^&]+/, 'token=<redacted>'),
    tokenLoaded: !!TOKEN,
    playwright: null,
    browserVersion: browser.version(),
    boot: {},
    routes: [],
    interactions: {},
    uncaughtExceptions: [],
    notes: []
  };

  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./node_modules/playwright/package.json', import.meta.url), 'utf8'));
    report.playwright = pkg.version;
  } catch (err) { /* optional */ }

  // ---- boot -----------------------------------------------------------------
  const bootCollector = newCollector();
  attach(page, bootCollector);
  const bootResp = await page.goto(consoleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await settle(page, SETTLE_MS);
  const bootSnap = await snapshot(page);
  report.boot = {
    httpStatus: bootResp ? bootResp.status() : null,
    finalUrl: page.url().replace(/token=[^&]+/, 'token=<redacted>'),
    title: bootSnap.title,
    navLinks: bootSnap.navLinks,
    healthChip: bootSnap.healthChip,
    viewTextLength: bootSnap.viewTextLength,
    hash: bootSnap.hash,
    localStorageToken: await page.evaluate(() => { try { return !!localStorage.getItem('dora.token'); } catch (e) { return 'unavailable'; } }),
    consoleErrors: dedupe(bootCollector.consoleErrors, (e) => e.text + e.location),
    pageErrors: bootCollector.pageErrors,
    failedRequests: dedupe(bootCollector.failedRequests, (e) => e.url + e.status + e.kind)
  };
  await page.screenshot({ path: path.join(OUT, 'boot.png'), fullPage: true });

  // ---- routes ---------------------------------------------------------------
  for (const route of ROUTES) {
    const name = route.replace(/^\//, '');
    const c2 = newCollector();
    attach(page, c2);
    const entry = { route: '#' + route, name, status: 'unknown', textLength: 0, consoleErrors: [], pageErrors: [], failedRequests: [], screenshot: path.join(OUT, name + '.png') };
    try {
      await page.evaluate((r) => { location.hash = '#' + r; }, route);
      const st = await settle(page, SETTLE_MS);
      const snap = await snapshot(page);
      await page.screenshot({ path: entry.screenshot, fullPage: true });
      entry.settled = st.settled;
      entry.waitedMs = st.waitedMs;
      entry.textLength = snap.viewTextLength;
      entry.consoleErrors = dedupe(c2.consoleErrors, (e) => e.text + e.location);
      entry.pageErrors = c2.pageErrors;
      entry.failedRequests = dedupe(c2.failedRequests, (e) => e.url + e.status + e.kind);
      entry.status = classify(snap, c2);
      entry.snapshot = {
        hash: snap.hash, activeNav: snap.activeNav, headings: snap.headings, counts: snap.counts,
        banner: snap.banner, hasFailurePanel: snap.hasFailurePanel, failureText: snap.failureText,
        healthChip: snap.healthChip, textPreview: snap.viewTextPreview
      };
      entry.preview = snap.viewTextPreview;
      entry.text = snap.viewTextAll.slice(0, 1200);
      entry.requests = dedupe(c2.allRequests, (e) => e.url + e.status).slice(0, 60);
      entry.apiCalls = dedupe(c2.allRequests.filter((r) => r.url.includes('/api/')), (r) => r.url + r.status);
    } catch (err) {
      entry.status = 'broken';
      entry.error = 'ROUTE FAILED: ' + (err && err.message ? err.message : String(err));
      entry.pageErrors = [{ message: entry.error, stack: String((err && err.stack) || '') }];
    }
    report.routes.push(entry);
    report.uncaughtExceptions.push(...entry.pageErrors.map((e) => ({ route: entry.route, ...e })));
  }

  // ---- interactions ---------------------------------------------------------
  async function goRoute(route) {
    await page.evaluate((r) => { location.hash = '#' + r; }, route);
    await settle(page, SETTLE_MS);
  }

  // #/overview
  {
    const c3 = newCollector(); attach(page, c3);
    const steps = [];
    await goRoute('/overview');

    await step('toggle events stream chip (#stream-chip)', async () => {
      await page.click('#stream-chip');
      await page.waitForTimeout(1200);
      const label = await page.textContent('#stream-chip');
      await page.screenshot({ path: path.join(OUT, 'overview-stream-on.png'), fullPage: true });
      await page.click('#stream-chip'); // turn it back off
      await page.waitForTimeout(300);
      return 'chip after click: "' + label + '" -> back to "' + (await page.textContent('#stream-chip')) + '"';
    }, steps, page, c3);

    await step('open Token dialog (#token-button) then Escape', async () => {
      await page.click('#token-button');
      await page.waitForTimeout(500);
      const dialogText = await page.evaluate(() => { const d = document.querySelector('.modal-overlay'); return d ? (d.innerText || '').trim().slice(0, 200) : null; });
      const shot = path.join(OUT, 'overview-token-dialog.png');
      await page.screenshot({ path: shot, fullPage: true });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const stillOpen = await page.evaluate(() => !!document.querySelector('.modal-overlay'));
      return JSON.stringify({ dialogRendered: !!dialogText, dialogText, stillOpenAfterEscape: stillOpen, screenshot: shot });
    }, steps, page, c3);

    await step('click first "connect" button then Escape (no submit)', async () => {
      const btn = page.locator('#view button', { hasText: /^connect$/i }).first();
      const n = await btn.count();
      if (!n) return 'no "connect" button present on this overview render';
      await btn.click();
      await page.waitForTimeout(500);
      const dialogText = await page.evaluate(() => { const d = document.querySelector('.modal-overlay'); return d ? (d.innerText || '').trim().slice(0, 200) : null; });
      const shot = path.join(OUT, 'overview-connect-dialog.png');
      await page.screenshot({ path: shot, fullPage: true });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const stillOpen = await page.evaluate(() => !!document.querySelector('.modal-overlay'));
      return JSON.stringify({ dialogRendered: !!dialogText, dialogText, stillOpenAfterEscape: stillOpen, screenshot: shot });
    }, steps, page, c3);

    await step('click "manage" link -> expect #/connectors, then return', async () => {
      const link = page.locator('#view a', { hasText: /^manage$/i }).first();
      if (!(await link.count())) return 'no "manage" link present on this overview render';
      await link.click();
      await page.waitForTimeout(900);
      const hash = await page.evaluate(() => location.hash);
      const textLength = await page.evaluate(() => (document.getElementById('view').innerText || '').trim().length);
      await goRoute('/overview');
      return JSON.stringify({ hashAfterClick: hash, textLengthAfterClick: textLength });
    }, steps, page, c3);

    report.interactions['#/overview'] = { steps, consoleErrors: dedupe(c3.consoleErrors, (e) => e.text + e.location), pageErrors: c3.pageErrors, failedRequests: dedupe(c3.failedRequests, (e) => e.url + e.status + e.kind) };
  }

  // #/tools
  {
    const c4 = newCollector(); attach(page, c4);
    const steps = [];
    await goRoute('/tools');

    await step('click first family "help" button', async () => {
      const btn = page.locator('#view button', { hasText: /^help$/i }).first();
      if (!(await btn.count())) return 'no "help" button present';
      await btn.click();
      await page.waitForTimeout(1500);
      const helpText = await page.evaluate(() => {
        const pre = document.querySelector('#view pre.tall') || document.querySelector('#view pre');
        return pre ? (pre.innerText || '').trim() : null;
      });
      const crumbs = await page.evaluate(() => { const p = document.querySelector('#view .path-crumbs'); return p ? p.innerText.trim() : null; });
      const shot = path.join(OUT, 'tools-help.png');
      await page.screenshot({ path: shot, fullPage: true });
      return JSON.stringify({ crumbs, helpLength: helpText ? helpText.length : 0, helpHead: helpText ? helpText.slice(0, 200) : null, screenshot: shot });
    }, steps, page, c4);

    await step('type into action search box', async () => {
      const inputs = page.locator('#view input');
      const n = await inputs.count();
      if (!n) return 'no input on tools view';
      const search = inputs.first();
      await search.fill('git');
      await page.waitForTimeout(1200);
      const rows = await page.evaluate(() => document.querySelectorAll('#view tbody tr').length);
      const shot = path.join(OUT, 'tools-search-git.png');
      await page.screenshot({ path: shot, fullPage: true });
      return JSON.stringify({ inputCount: n, rowsAfterFilter: rows, screenshot: shot });
    }, steps, page, c4);

    await step('click "all actions" / last family help button', async () => {
      const btns = page.locator('#view button', { hasText: /^help$/i });
      const n = await btns.count();
      if (n < 2) return 'fewer than two help buttons (' + n + ')';
      await btns.nth(n - 1).click();
      await page.waitForTimeout(1500);
      const crumbs = await page.evaluate(() => { const p = document.querySelector('#view .path-crumbs'); return p ? p.innerText.trim() : null; });
      return JSON.stringify({ helpButtons: n, lastHelpCrumb: crumbs });
    }, steps, page, c4);

    report.interactions['#/tools'] = { steps, consoleErrors: dedupe(c4.consoleErrors, (e) => e.text + e.location), pageErrors: c4.pageErrors, failedRequests: dedupe(c4.failedRequests, (e) => e.url + e.status + e.kind) };
  }

  // #/connectors
  {
    const c5 = newCollector(); attach(page, c5);
    const steps = [];
    await goRoute('/connectors');

    await step('type "git" into the connector filter', async () => {
      const filter = page.locator('#view input[type="search"]').first();
      if (!(await filter.count())) return 'no filter input present';
      const before = await page.evaluate(() => document.querySelectorAll('#view .card').length);
      await filter.fill('git');
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => document.querySelectorAll('#view .card').length);
      await page.screenshot({ path: path.join(OUT, 'connectors-filter-git.png'), fullPage: true });
      await filter.fill('');
      await page.waitForTimeout(600);
      const restored = await page.evaluate(() => document.querySelectorAll('#view .card').length);
      return JSON.stringify({ cardsBefore: before, cardsAfterFilter: after, cardsAfterClear: restored });
    }, steps, page, c5);

    await step('type a nonsense filter (expect empty state)', async () => {
      const filter = page.locator('#view input[type="search"]').first();
      if (!(await filter.count())) return 'no filter input present';
      await filter.fill('zzzz-no-such-connector');
      await page.waitForTimeout(700);
      const empty = await page.evaluate(() => { const e = document.querySelector('#view .empty'); return e ? e.innerText.trim() : null; });
      await page.screenshot({ path: path.join(OUT, 'connectors-filter-empty.png'), fullPage: true });
      await filter.fill('');
      await page.waitForTimeout(500);
      return JSON.stringify({ emptyStateText: empty });
    }, steps, page, c5);

    await step('inspect account forms (report only, no submit)', async () => {
      const info = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#view .card'));
        return cards.slice(0, 4).map((card) => ({
          title: card.querySelector('.card-title') ? card.querySelector('.card-title').textContent.trim() : null,
          buttons: Array.from(card.querySelectorAll('button')).map((b) => b.textContent.trim()),
          inputs: Array.from(card.querySelectorAll('input')).map((i) => i.type + ':' + (i.placeholder || '')),
          text: (card.innerText || '').trim().slice(0, 120)
        }));
      });
      return JSON.stringify(info);
    }, steps, page, c5);

    report.interactions['#/connectors'] = { steps, consoleErrors: dedupe(c5.consoleErrors, (e) => e.text + e.location), pageErrors: c5.pageErrors, failedRequests: dedupe(c5.failedRequests, (e) => e.url + e.status + e.kind) };
  }

  report.finishedAt = new Date().toISOString();
  await context.close();
  await browser.close();
  return report;
}

run().then((report) => {
  const json = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(OUT, 'summary.json'), json);
  process.stdout.write(json + '\n');
}).catch((err) => {
  const failure = { fatal: true, message: String(err && err.message ? err.message : err), stack: String((err && err.stack) || '') };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(failure, null, 2));
  process.stdout.write(JSON.stringify(failure, null, 2) + '\n');
  process.exitCode = 1;
});
