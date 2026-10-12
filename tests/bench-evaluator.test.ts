import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsInvocations } from '@dora/bench';

/**
 * The bench judges a run from the event stream, so extracting "which action ran" has to be
 * right for every shape of shell line the agent writes. Getting this wrong made three
 * tasks look like failures when they had actually done the work.
 */
test('tools invocations are found in every command shape', () => {
  assert.deepEqual(toolsInvocations('tools todos list --status open'), ['tools todos list --status open']);
  assert.deepEqual(toolsInvocations('cd /tmp && tools wake_schedule create --schedule-interval 10 --prompt "x"'), [
    'tools wake_schedule create --schedule-interval 10 --prompt "x"'
  ]);
  assert.deepEqual(
    toolsInvocations('echo "=== GMAIL ==="; tools gmail search --query "in:inbox" --json 2>&1; echo done'),
    ['tools gmail search --query "in:inbox" --json 2>']
  );
  assert.deepEqual(toolsInvocations('date +%s'), []);
  assert.deepEqual(toolsInvocations('echo tools are nice'), []);
});

test('the resolver recognises family/action pairs with or without the tools prefix', async () => {
  const { createRuntime } = await import('@dora/runtime');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dora-eval-'));
  process.env.DORA_MODEL_PROVIDER = 'mock';
  process.env.DORA_LOG_ECHO = '0';
  const runtime = await createRuntime({ config: { dataDir: dir }, offlineSearch: true, seed: false, listen: false });
  try {
    const { selectTasks } = await import('@dora/bench');
    assert.ok(selectTasks({ only: ['e3-todos'] }).length === 1);
    const { executeArgv } = await import('@dora/tools');
    const session = runtime.ensureMainSession();
    const result = await executeArgv({
      argv: ['help', 'todos.list'],
      session,
      account: runtime.account,
      flags: runtime.flags,
      services: runtime.services,
      config: runtime.config,
      db: runtime.db,
      registry: runtime.registry
    });
    assert.equal(result.attachments[0].name, 'help:todos.list');
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
