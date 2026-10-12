import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { loadConfig } from '@dora/core';
import { MemoryStore } from '@dora/memory';
import { ObservationsStore, referencedRelations } from '@dora/observations';
import { openDb, migrate, CORE_SCHEMA } from '@dora/core';
import { harness } from './helpers.ts';

/**
 * Regressions found by running the bench against the live model. Each one is a bug that
 * a unit test would not have caught on its own, so each gets a test that would have.
 */

test('a relative data directory is normalised, so stores never see a relative root', () => {
  const config = loadConfig({ dataDir: 'var/relative-probe' });
  assert.equal(config.dataDir, resolve('var/relative-probe'));
  assert.ok(config.dbPath.startsWith('/'), 'db path must be absolute');
  assert.ok(config.logDir.startsWith('/'), 'log dir must be absolute');
  assert.ok(config.socketPath.startsWith('/'), 'socket path must be absolute');
});

test('the memory repo works when it is handed a relative root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dora-mem-rel-'));
  try {
    const rel = relative(process.cwd(), join(dir, 'accounts', 'a', 'memory')) || '.';
    const store = new MemoryStore({ root: rel, noGit: true });
    const file = store.write('knowledge/facts/probe.md', 'hello\n', { id: 'probe', type: 'fact' });
    assert.equal(file.id, 'probe');
    assert.equal(store.read('knowledge/facts/probe.md')!.body.trim(), 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observations.sql cannot reach the control plane', () => {
  const db = openDb(':memory:');
  migrate(db, CORE_SCHEMA);
  const store = new ObservationsStore({ db, accountId: 'acct_test' });
  store.ingest('gmail', [{ path: 'gmail/1', title: 'hi', body: 'hello', ts: Date.now() }]);
  db.prepare('INSERT INTO connector_accounts (id, connector, label, is_default, auth_kind, created_at, credentials) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .run('acct_x', 'gmail', 'me@example.com', 'token', Date.now(), JSON.stringify({ token: 'super-secret-token' }));

  assert.ok(store.sql('SELECT path FROM gmail WHERE ts > 0').rows.length === 1);
  for (const forbidden of ['connector_accounts', 'connector_records', 'sessions', 'events', 'kv', 'wake_schedule', 'flags', 'budget']) {
    assert.throws(
      () => store.sql('SELECT * FROM ' + forbidden + ' WHERE ts > 0'),
      /cannot read/,
      forbidden + ' must not be queryable'
    );
  }
  // A credential must not be reachable through any allowed relation either.
  const dump = JSON.stringify(store.sql('SELECT * FROM observations WHERE ts > 0').rows);
  assert.ok(!dump.includes('super-secret-token'));
});

test('relation extraction sees FROM and JOIN targets only', () => {
  assert.deepEqual(referencedRelations('SELECT a FROM gmail g JOIN observations o ON 1=1').sort(), ['gmail', 'observations']);
  assert.deepEqual(referencedRelations("SELECT 'from x' AS t FROM gmail WHERE ts > 0"), ['gmail']);
});

test('a help target that names a real family but no action suggests the family', async () => {
  const h = await harness('help-near-miss');
  try {
    const result = await h.invoke(['help', 'todos.read']);
    assert.equal(result.attachments.length, 1);
    const page = result.attachments[0].content;
    assert.match(page, /No action named todos\.read/);
    assert.match(page, /todos\.<action>/);
    assert.match(page, /list/);
  } finally {
    await h.dispose();
  }
});

test('the prompt advertises this session\'s workspace, not a preview path', async () => {
  const h = await harness('paths');
  try {
    const session = h.runtime.ensureMainSession();
    const paths = h.runtime.runner['deps'].workspacePaths(session.id);
    assert.ok(paths['workspace'].includes(session.id), 'the workspace path must carry the real session id');
    assert.ok(paths['memory'].startsWith(paths['workspace']), 'memory lives under the workspace');
    assert.ok(!JSON.stringify(paths).includes('sess_preview'));
  } finally {
    await h.dispose();
  }
});

test('log records are written for a run and secrets never appear in them', async () => {
  const h = await harness('logging');
  try {
    const session = h.runtime.ensureMainSession();
    await h.runtime.submitUserMessage('run: tools time now', { sessionId: session.id });
    const { readLog } = await import('@dora/core');
    const records = readLog({ dir: join(h.runtime.config.logDir), limit: 200 });
    assert.ok(records.length > 0, 'a run must produce log records');
    const channels = new Set(records.map((r) => r.channel));
    assert.ok(channels.has('runtime') || channels.has('tools'), 'expected runtime or tools records, saw ' + [...channels].join(','));
    const dump = JSON.stringify(records);
    assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(dump), 'no raw API key may reach a log line');
    assert.ok(!dump.includes('hunter2'), 'no vault value may reach a log line');
  } finally {
    await h.dispose();
  }
});
