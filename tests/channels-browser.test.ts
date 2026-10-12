import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockWeb } from '@dora/mockweb';
import { LocalBrowserService } from '@dora/integrations';
import { CORE_SCHEMA, migrate, openDb } from '@dora/core';
import { harness } from './helpers.ts';

test('the browser driver submits a real form to the form action, not the page URL', async () => {
  const web = await startMockWeb({ port: 0, log: false });
  try {
    const db = openDb(':memory:');
    migrate(db, CORE_SCHEMA);
    const browser = new LocalBrowserService({ db, accountId: 'acct_form' });
    const lease = browser.acquire({ sessionId: 'sess_form', kind: 'write', site: 'localhost' });

    await browser.drive(lease.id, { op: 'open', url: web.url + '/restaurant/book' });
    const snapshot = await browser.drive(lease.id, { op: 'snapshot' });
    const fieldLines = snapshot.stdout.split('\n').filter((l) => /^ {2}f\d+/.test(l));
    const refOf = (name: string) => {
      const hit = fieldLines.find((l) => new RegExp('\\s' + name + '\\s').test(l));
      return hit ? hit.trim().split(/\s+/)[0] : null;
    };
    assert.ok(refOf('name') && refOf('party'), 'the form fields are addressable by ref');

    for (const [name, value] of [['name', 'Ada'], ['date', '2026-10-15'], ['time', '19:00'], ['party', '4']]) {
      const ref = refOf(name);
      assert.ok(ref, 'missing field ' + name);
      await browser.drive(lease.id, { op: 'type', ref, text: value });
    }
    const submitRef = fieldLines.find((l) => /submit/.test(l))!.trim().split(/\s+/)[0];
    const submitted = await browser.drive(lease.id, { op: 'click', ref: submitRef });
    assert.match(submitted.stdout, /Booking confirmed/);
    assert.match(submitted.stdout, /TRV-\d+/);
    const url = await browser.drive(lease.id, { op: 'current-url' });
    assert.match(url.stdout, /\/restaurant\/confirm\?/);

    // A party of six needs a deposit: the site refuses, and the driver reports the status.
    await browser.drive(lease.id, { op: 'open', url: web.url + '/restaurant/book' });
    const snap2 = await browser.drive(lease.id, { op: 'snapshot' });
    const lines2 = snap2.stdout.split('\n').filter((l) => /^ {2}f\d+/.test(l));
    const ref2 = (name: string) => lines2.find((l) => new RegExp('\\s' + name + '\\s').test(l))!.trim().split(/\s+/)[0];
    for (const [name, value] of [['name', 'Ada'], ['date', '2026-10-15'], ['time', '19:00'], ['party', '6']]) {
      await browser.drive(lease.id, { op: 'type', ref: ref2(name), text: value });
    }
    const refused = await browser.drive(lease.id, { op: 'click', ref: lines2.find((l) => /submit/.test(l))!.trim().split(/\s+/)[0] });
    assert.equal(refused.ok, false);
    assert.match(refused.stdout, /refused the submission \(HTTP 409\)/);
    assert.match(refused.stdout, /Deposit required/);
  } finally {
    await web.close();
  }
});

test('the WhatsApp 24-hour window closes free-form sends and reopens on inbound', async () => {
  const h = await harness('whatsapp');
  try {
    const channels = h.runtime.services.channels;
    const whatsapp = channels.get('whatsapp')!;
    const to = h.runtime.account.phone;
    assert.equal(whatsapp.windowOpen(to), false);

    const refused = await h.run(['whatsappbot', 'send', '--to', to, '--body', 'hi']);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.stderr, /window is closed/);

    const notify = await h.run(['whatsappbot', 'notify', '--to', to, '--template', 'time_sensitive', '--var', 'the deposit', '18:00']);
    assert.equal(notify.exitCode, 0);
    assert.match(notify.stdout, /notify sent/);
    const last = whatsapp.history(5).at(-1)!;
    assert.equal(last.template, 'time_sensitive');
    assert.match(last.body, /needs your attention before 18:00/);

    whatsapp.recordInbound({ channel: 'whatsapp', from: to, to: 'dora', body: 'ok go ahead' });
    assert.equal(whatsapp.windowOpen(to), true);
    const sent = await h.run(['whatsappbot', 'send', '--to', to, '--body', 'booked it']);
    assert.equal(sent.exitCode, 0);
  } finally {
    await h.dispose();
  }
});

test('a notify rejects templates that are not pre-approved', async () => {
  const h = await harness('whatsapp-template');
  try {
    const bad = await h.run(['whatsappbot', 'notify', '--to', '+15550000000', '--template', 'freeform']);
    assert.notEqual(bad.exitCode, 0);
    assert.match(bad.stderr, /unknown template|Values:/);
  } finally {
    await h.dispose();
  }
});

test('browser leases: write contention, read freedom, and the guidance token constraint', async () => {
  const h = await harness('browser');
  try {
    const main = h.runtime.ensureMainSession();
    const task = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--task', 'book a table']);
    const taskId = /task agent started: (\S+)/.exec(task.stdout)![1];

    const readLease = await h.run(['cloud_browser_scheduler', 'acquire', '--kind', 'read', '--site', 'restaurant.example'], taskId);
    assert.equal(readLease.exitCode, 0);
    const readLeaseId = /lease (\S+) until/.exec(readLease.stdout)![1];

    const writeLease = await h.run(['cloud_browser_scheduler', 'acquire', '--kind', 'write', '--site', 'restaurant.example'], taskId);
    const writeLeaseId = /lease (\S+) until/.exec(writeLease.stdout)![1];

    const contender = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--task', 'another job']);
    const contenderId = /task agent started: (\S+)/.exec(contender.stdout)![1];
    const conflict = await h.run(['cloud_browser_scheduler', 'acquire', '--kind', 'write', '--site', 'restaurant.example'], contenderId);
    assert.notEqual(conflict.exitCode, 0);
    assert.match(conflict.stderr, /write lease is held by session/);

    // The main agent may release any lease even though it cannot drive one.
    const released = await h.run(['cloud_browser_scheduler', 'release', '--lease-id', writeLeaseId]);
    assert.equal(released.exitCode, 0);
    assert.equal(h.runtime.services.browser.status(writeLeaseId), null);

    const drive = await h.run(['cloud_browser', 'list', '--lease-id', readLeaseId], taskId);
    assert.equal(drive.exitCode, 0);
    const deniedDrive = await h.run(['cloud_browser', 'list', '--lease-id', readLeaseId]);
    assert.equal(deniedDrive.exitCode, 4);

    // Driving without a lease fails as a connection problem, not as a permission problem.
    const noLease = await h.run(['cloud_browser', 'list', '--lease-id', 'lease_missing'], taskId);
    assert.notEqual(noLease.exitCode, 0);
    assert.match(noLease.stderr, /no active session/);

    // A site with field notes requires a guidance token when enforcement is on.
    h.runtime.services.browser.guidance.record({ site: 'shop.example', flow: 'checkout', outcome: 'success', notes: 'card form needs the billing zip first' });
    const enforced = h.runtime.services.browser as unknown as { enforceGuidance: boolean };
    enforced.enforceGuidance = true;
    const noToken = await h.run(['cloud_browser_scheduler', 'acquire', '--kind', 'read', '--site', 'shop.example'], taskId);
    assert.notEqual(noToken.exitCode, 0);
    assert.match(noToken.stderr, /guidance exists for shop\.example/);
    const guidance = await h.run(['browser_guidance', 'search', '--site', 'shop.example', '--json'], taskId);
    const token = JSON.parse(guidance.stdout) as { token: string };
    const withToken = await h.run(['cloud_browser_scheduler', 'acquire', '--kind', 'read', '--site', 'shop.example', '--guidance-token', token.token], taskId);
    assert.equal(withToken.exitCode, 0);
    void main;
  } finally {
    await h.dispose();
  }
});
