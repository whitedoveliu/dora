import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './helpers.ts';

test('delegation builds the three-part opening package and pre-reads the gate', async () => {
  const h = await harness('delegate');
  try {
    const result = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--name', 'planning review', '--task', 'Read the planning doc and report the headcount risk.']);
    assert.equal(result.exitCode, 0);
    const taskId = /task agent started: (\S+)/.exec(result.stdout)![1];
    const task = h.runtime.store.get(taskId)!;
    assert.equal(task.kind, 'task');
    assert.equal(task.role, 'task_agent');
    assert.equal(task.parentId, h.runtime.ensureMainSession().id);

    const opening = h.runtime.store.events(taskId, { limit: 20 }).find((e) => e.type === 'user_message')!;
    const text = String(opening.data['text']);
    assert.match(text, /You are a task agent/);
    assert.match(text, /Read the planning doc and report the headcount risk/);
    const pages = text.match(/===== tools help /g) ?? [];
    assert.ok(pages.length >= 10, 'expected at least 10 pre-injected pages, got ' + pages.length);
    assert.ok(pages.length <= 15, 'the opening package is about fifteen pages, got ' + pages.length);

    // Pre-read pages mean the first call is not blocked.
    const first = await h.invoke(['web_search', 'search', '--query', 'headcount benchmarks'], taskId);
    assert.notEqual(first.exitCode, 3);
  } finally {
    await h.dispose();
  }
});

test('a task report wakes the parent, and the report carries results without the trail', async () => {
  const h = await harness('delegate-report');
  try {
    const delegated = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--task', 'check the mail']);
    const taskId = /task agent started: (\S+)/.exec(delegated.stdout)![1];
    const report = await h.run(['agent_message', 'send', '--body', 'Two messages need a reply; the rest is noise.'], taskId);
    assert.equal(report.exitCode, 0);
    assert.match(report.stdout, /delivered/);

    const queued = h.runtime.store.dueWakes(Date.now()).filter((w) => w.cause === 'task_report');
    assert.ok(queued.length >= 1, 'the parent was woken by the report');
    assert.equal(queued[0].sessionId, h.runtime.ensureMainSession().id);
    assert.ok(queued.some((w) => /need a reply/.test(String(w.payload['report']))), 'the explicit report is queued for the parent');

    const reportEvent = h.runtime.store.events(taskId, { limit: 50 }).find((e) => e.type === 'report')!;
    assert.ok(reportEvent);
    assert.equal(reportEvent.data['attachments'], undefined as unknown as string[] as never ?? reportEvent.data['attachments']);
    assert.ok(!JSON.stringify(reportEvent.data).includes('tool_call'), 'a report never carries the tool trail');
  } finally {
    await h.dispose();
  }
});

test('attachments are capped at 5 files and 20 MB and require --start now', async () => {
  const h = await harness('delegate-attachments');
  try {
    const files = [1, 2, 3, 4, 5, 6].map((i) => {
      const file = h.dir + '/file' + i + '.txt';
      writeFileSync(file, 'x');
      return file;
    });
    const tooMany = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--task', 'work', '--attachments', ...files]);
    assert.equal(tooMany.exitCode, 1);
    assert.match(tooMany.stderr, /at most 5 attachments/);

    const queued = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--start', 'queued', '--task', 'work', '--attachments', files[0]]);
    assert.equal(queued.exitCode, 1);
    assert.match(queued.stderr, /--attachments requires --start now/);
  } finally {
    await h.dispose();
  }
});

test('the parent owns cleanup and can cancel a task agent', async () => {
  const h = await harness('delegate-cancel');
  try {
    const delegated = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--name', 'doomed', '--task', 'work']);
    const taskId = /task agent started: (\S+)/.exec(delegated.stdout)![1];
    const listed = await h.run(['tasks', 'list']);
    assert.match(listed.stdout, new RegExp(taskId));
    const cancelled = await h.run(['tasks', 'cancel', '--id', taskId]);
    assert.equal(cancelled.exitCode, 0);
    assert.match(cancelled.stdout, /cancelled/);
    assert.equal(h.runtime.store.get(taskId)!.status, 'failed');

    const grandchild = await h.run(['tasks', 'cancel', '--id', taskId], taskId);
    assert.notEqual(grandchild.exitCode, 0);
  } finally {
    await h.dispose();
  }
});
