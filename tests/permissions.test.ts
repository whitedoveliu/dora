import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionSpaceWord, buildActionSpace, defaultFlags, denialFor } from '@dora/core';
import { harness } from './helpers.ts';

test('the capability matrix uses the four-word action space', () => {
  const rows = buildActionSpace('main_agent', defaultFlags());
  const byTrait = new Map(rows.map((r) => [r.trait, r.mode]));
  assert.equal(actionSpaceWord(byTrait.get('channel.write')!), 'EXECUTABLE');
  assert.equal(actionSpaceWord(byTrait.get('work')!), 'DELEGATED');
  assert.equal(actionSpaceWord(byTrait.get('resource.lifecycle')!), 'PARTIAL');
  assert.equal(actionSpaceWord(byTrait.get('browser.drive')!), 'UNAVAILABLE');
  // Subscriptions are task-agent work; the supervisor flag opens a partial path.
  assert.equal(actionSpaceWord(byTrait.get('wake.subscription')!), 'PARTIAL');
  const withoutSupervisor = new Map(buildActionSpace('main_agent', { ...defaultFlags(), supervisor_subscription_wakes: false }).map((r) => [r.trait, r.mode]));
  assert.equal(actionSpaceWord(withoutSupervisor.get('wake.subscription')!), 'UNAVAILABLE');

  const taskRows = buildActionSpace('task_agent', defaultFlags());
  const taskByTrait = new Map(taskRows.map((r) => [r.trait, r.mode]));
  assert.equal(actionSpaceWord(taskByTrait.get('work')!), 'EXECUTABLE');
  assert.equal(actionSpaceWord(taskByTrait.get('channel.write')!), 'UNAVAILABLE');
  assert.equal(actionSpaceWord(taskByTrait.get('todos.write')!), 'UNAVAILABLE');
  assert.equal(actionSpaceWord(taskByTrait.get('wake.subscription')!), 'EXECUTABLE');
});

test('delegated and unavailable actions are refused with the right mode', () => {
  const delegated = denialFor('main_agent', 'work', 'gmail.search');
  assert.equal(delegated?.mode, 'delegated');
  assert.match(delegated!.message, /ACCESS delegated/);

  const unavailable = denialFor('task_agent', 'channel.write', 'whatsappbot.send');
  assert.equal(unavailable?.mode, 'unavailable');
  assert.match(unavailable!.message, /ACCESS unavailable/);

  assert.equal(denialFor('main_agent', 'channel.write', 'whatsappbot.send'), null);
});

test('the runtime enforces the matrix for both roles', async () => {
  const h = await harness('permissions');
  try {
    const mainDenied = await h.run(['gmail', 'search', '--query', 'planning']);
    assert.equal(mainDenied.exitCode, 4);
    assert.match(mainDenied.stdout, /ACCESS delegated/);

    const delegated = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--task', 'check the planning doc']);
    assert.equal(delegated.exitCode, 0);
    const taskId = /task agent started: (\S+)/.exec(delegated.stdout)![1];

    const taskAllowed = await h.run(['gmail', 'search', '--query', 'planning'], taskId);
    assert.notEqual(taskAllowed.exitCode, 4);

    const taskDeniedWrite = await h.run(['whatsappbot', 'send', '--to', '+15550000000', '--body', 'hi'], taskId);
    assert.equal(taskDeniedWrite.exitCode, 4);
    assert.match(taskDeniedWrite.stdout, /ACCESS unavailable/);

    const taskDeniedTodos = await h.run(['todos', 'create', '--title', 'x'], taskId);
    assert.equal(taskDeniedTodos.exitCode, 4);

    const mainDeniedSubscribe = await h.run(['wake_subscription', 'subscribe', '--source', 'gmail']);
    assert.equal(mainDeniedSubscribe.exitCode, 4);
  } finally {
    await h.dispose();
  }
});
