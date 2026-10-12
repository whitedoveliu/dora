import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalSandboxAdapter, inspectCommand, redirectsStdoutToFile, invokesToolsCli } from '@dora/sandbox';
import { harness } from './helpers.ts';

test('a host without a sandbox refuses to run commands unless explicitly allowed', async () => {
  const spec = { command: 'echo hi', cwd: process.cwd(), env: {}, timeoutMs: 5_000, fs: { writable: [], readable: [], hidden: [] } };
  const refused = await new LocalSandboxAdapter({ profileBuilder: () => null, isolation: 'none' }).exec(spec);
  assert.equal(refused.exitCode, 126);
  assert.equal(refused.isolation, 'none');
  assert.match(refused.stderr, /DORA_ALLOW_UNSANDBOXED/);

  const allowed = await new LocalSandboxAdapter({ profileBuilder: () => null, isolation: 'none', requireIsolation: false }).exec(spec);
  assert.equal(allowed.exitCode, 0);
  assert.match(allowed.stdout, /hi/);
});

test('the two content filters match the documented rule', () => {
  const amount = inspectCommand('tools payments pay --amount $12.50');
  assert.equal(amount.blocked, true);
  assert.equal(amount.kind, 'dollar_amount');
  assert.match(amount.hint!, /stdin|file/);

  const multiline = inspectCommand('tools x y --body "line one\nline two"');
  assert.equal(multiline.blocked, true);
  assert.equal(multiline.kind, 'multiline_quote');
  assert.match(multiline.hint!, /--<option>-stdin/);

  assert.equal(inspectCommand('echo hello').blocked, false);
  assert.equal(inspectCommand("echo 'cost is 12 dollars'").blocked, false);
});

test('the CLI detector and the redirection detector are conservative', () => {
  assert.equal(invokesToolsCli('tools gmail search --query x'), true);
  assert.equal(invokesToolsCli('echo tools'), false);
  assert.equal(invokesToolsCli('cd /tmp && tools time now'), true);
  assert.equal(redirectsStdoutToFile('tools help x > out.txt'), true);
  assert.equal(redirectsStdoutToFile('echo hello'), false);
  assert.equal(redirectsStdoutToFile('echo 2>&1'), false);
});

test('a blocked command never reaches the shell', async () => {
  const h = await harness('sandbox-filters');
  try {
    const blocked = await h.bash('tools payments pay --amount $12.50');
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.stderr, /shell-expandable amount/);
  } finally {
    await h.dispose();
  }
});

test('the workspace has the sandbox layout and a tools shim on PATH', async () => {
  const h = await harness('sandbox-layout');
  try {
    const session = h.runtime.ensureMainSession();
    const workspaceRoot = join(h.runtime.config.dataDir, 'workspaces', session.id);
    await h.bash('mkdir -p probe');
    for (const dir of ['memory', 'skills', 'observations', 'downloads', 'tmp', 'work', 'bin']) {
      assert.ok(existsSync(join(workspaceRoot, dir)), 'missing ' + dir);
    }
    const shim = readFileSync(join(workspaceRoot, 'bin', 'tools'), 'utf8');
    // The sandbox cannot read the source tree, so the CLI travels as a bundle.
    assert.match(shim, /dora-tools\.mjs/);
    assert.ok(readFileSync(join(workspaceRoot, 'bin', 'dora-tools.mjs'), 'utf8').length > 1000, 'the bundled CLI must be copied into the workspace');
    const which = await h.bash('command -v tools');
    assert.match(which.stdout, /bin\/tools/);
    const write = await h.bash('echo probe > work/probe.txt && cat work/probe.txt');
    assert.match(write.stdout, /probe/);
  } finally {
    await h.dispose();
  }
});

test('the kernel fences off memory, the vault and the database', async () => {
  const h = await harness('sandbox-fence');
  try {
    const session = h.runtime.ensureMainSession();
    const accountDir = join(h.runtime.config.dataDir, 'accounts', h.runtime.account.id);
    const before = readFileSync(join(accountDir, 'memory', 'entities/people/alex.md'), 'utf8');

    const memoryWrite = await h.bash('echo tampered > memory/entities/people/alex.md 2>&1; echo rc=$?');
    assert.match(memoryWrite.stdout + memoryWrite.stderr, /Operation not permitted|rc=1/);
    assert.equal(readFileSync(join(accountDir, 'memory', 'entities/people/alex.md'), 'utf8'), before);

    const memoryRead = await h.bash('cat memory/knowledge/preferences/communication-style.md');
    assert.match(memoryRead.stdout, /member prefers short messages/);

    const db = await h.bash('cat ' + h.runtime.config.dbPath + ' 2>&1');
    assert.match(db.stdout + db.stderr, /Operation not permitted/);

    const vault = await h.bash('ls ' + join(h.runtime.config.dataDir, 'vault') + ' 2>&1');
    assert.match(vault.stdout + vault.stderr, /Operation not permitted/);

    const outside = await h.bash('echo nope > /tmp/dora-should-not-exist 2>&1; echo rc=$?');
    assert.match(outside.stdout + outside.stderr, /Operation not permitted|rc=1/);
  } finally {
    await h.dispose();
  }
});

test('a 45 second command is killed and reports an interrupt', async () => {
  const h = await harness('sandbox-timeout');
  try {
    const session = h.runtime.ensureMainSession();
    const started = Date.now();
    const result = await h.runtime.bash(session.id, 'sleep 30', { timeoutMs: 1000 });
    assert.equal(result.exitCode, 124);
    assert.equal(result.interrupt?.cause, 'timeout');
    assert.match(result.stdout, /<interrupt_cause>timeout<\/interrupt_cause>/);
    assert.ok(Date.now() - started < 10_000, 'the kill happened promptly');
  } finally {
    await h.dispose();
  }
});

test('over-budget output is written to a file with a preview', async () => {
  const h = await harness('sandbox-overflow');
  try {
    const session = h.runtime.ensureMainSession();
    const result = await h.runtime.bash(session.id, 'for i in $(seq 1 5000); do echo "line $i of a chatty command"; done', { timeoutMs: 20_000 });
    assert.ok(result.overflowPath, 'expected an overflow path');
    assert.match(result.stdout, /output over budget/);
    const full = readFileSync(result.overflowPath!, 'utf8');
    assert.ok(full.length > result.stdout.length);
    assert.match(full, /line 5000/);
  } finally {
    await h.dispose();
  }
});
