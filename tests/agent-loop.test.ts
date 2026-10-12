import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockModelProvider } from '@dora/providers';
import { COMPACTION_SECTIONS } from '@dora/core';
import { harness } from './helpers.ts';

test('a run is wake → recall → model turn → bash → hold, and every step is an event', async () => {
  const h = await harness('loop');
  try {
    const session = h.runtime.ensureMainSession();
    const result = await h.runtime.submitUserMessage('run: echo dora-loop', { sessionId: session.id });
    assert.equal(result.status, 'held');
    assert.ok(result.turns >= 2);

    const events = h.runtime.events(session.id);
    const types = events.map((e) => e.type);
    for (const expected of ['session_started', 'user_message', 'wake', 'recall', 'assistant_message', 'tool_call', 'tool_result', 'hold']) {
      assert.ok(types.includes(expected as never), 'missing event: ' + expected);
    }

    const call = events.find((e) => e.type === 'tool_call')!;
    assert.match(String(call.data['command']), /echo dora-loop/);
    const toolResult = events.find((e) => e.type === 'tool_result')!;
    assert.equal(toolResult.data['exit_code'], 0);
    assert.match(String(toolResult.data['stdout']), /dora-loop/);

    const recall = events.find((e) => e.type === 'recall')!;
    assert.ok(Array.isArray(recall.data['paths']));
  } finally {
    await h.dispose();
  }
});

test('the recall block is what the model actually sees', async () => {
  const h = await harness('loop-recall');
  try {
    const scripted = new MockModelProvider({ script: [{ content: 'noted', toolCall: { name: 'hold', arguments: { reason: 'nothing to do' } } }], heuristics: false });
    h.runtime.runner['deps'].model = scripted;
    const session = h.runtime.ensureMainSession();
    await h.runtime.submitUserMessage('what do I know about Alex', { sessionId: session.id });

    const messages = scripted.calls[0].messages.map((m) => m.content).join('\n');
    assert.match(messages, /<memory_recall>/);
    assert.match(messages, /Recalled memory snippets: verbatim excerpts/);
    assert.match(messages, /do not re-read these files or sweep memory/);
    assert.ok(messages.includes('alex.md'), 'the newest memory files are selected');
    assert.match(messages, /== Your action space ==/);
    assert.equal(scripted.calls[0].tools.length, 2, 'exactly two base commands');
    assert.deepEqual(scripted.calls[0].tools.sort(), ['bash', 'hold']);
  } finally {
    await h.dispose();
  }
});

test('a session over the context budget is compacted into the eight sections', async () => {
  const h = await harness('loop-compaction');
  try {
    h.runtime.runner['deps'].config.model.contextBudgetTokens = 1;
    const scripted = new MockModelProvider({
      script: [
        { content: 'working', toolCall: { name: 'bash', arguments: { command: 'echo one' } } },
        { content: 'working', toolCall: { name: 'bash', arguments: { command: 'echo two' } } },
        { content: 'done', toolCall: { name: 'hold', arguments: { reason: 'done' } } }
      ],
      heuristics: false
    });
    h.runtime.runner['deps'].model = scripted;
    const session = h.runtime.ensureMainSession();
    await h.runtime.submitUserMessage('run: echo compact me', { sessionId: session.id });
    // After compaction the system prompt must still lead the context.
    const afterCompaction = scripted.calls.at(-1)!;
    assert.equal(afterCompaction.messages[0].role, 'system');
    assert.match(afterCompaction.messages[0].content, /You are the main agent/);
    assert.ok(afterCompaction.messages.some((m) => m.content.includes('<session_compaction>')));
    const compaction = h.runtime.store.latestCompaction(session.id);
    assert.ok(compaction, 'expected a compaction event');
    const summary = String(compaction!.data['summary']);
    for (const section of COMPACTION_SECTIONS) assert.ok(summary.includes(section), 'missing ' + section);
    assert.equal(compaction!.data['sections'], 8);
  } finally {
    await h.dispose();
  }
});

test('a blocked bash call is reported to the model instead of throwing', async () => {
  const h = await harness('loop-blocked');
  try {
    const scripted = new MockModelProvider({
      script: [
        { content: 'trying', toolCall: { name: 'bash', arguments: { command: 'tools pay --amount $99.00' } } },
        { content: 'understood', toolCall: { name: 'hold', arguments: { reason: 'blocked' } } }
      ],
      heuristics: false
    });
    h.runtime.runner['deps'].model = scripted;
    const session = h.runtime.ensureMainSession();
    await h.runtime.submitUserMessage('pay for it', { sessionId: session.id });

    const toolResult = h.runtime.events(session.id).find((e) => e.type === 'tool_result')!;
    assert.equal(toolResult.data['exit_code'], 2);
    assert.match(String(toolResult.data['stderr']), /shell-expandable amount/);
    const secondTurn = scripted.calls[1].messages.at(-1)!;
    assert.match(secondTurn.content, /exit_code: 2/);
  } finally {
    await h.dispose();
  }
});

test('starting a wake for a task agent hands the report to the parent', async () => {
  const h = await harness('loop-task');
  try {
    const scripted = new MockModelProvider({
      script: [
        { content: 'reporting', toolCall: { name: 'bash', arguments: { command: 'echo work done' } } },
        { content: 'Work is done: the plan needs three hires.', toolCall: { name: 'hold', arguments: { reason: 'job done' } } }
      ],
      heuristics: false
    });
    h.runtime.runner['deps'].model = scripted;
    const delegated = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--task', 'check the plan']);
    const taskId = /task agent started: (\S+)/.exec(delegated.stdout)![1];
    await h.runtime.runDUEWakesForTest?.();
    // The delegate path runs the task agent asynchronously; drive the queue explicitly.
    await h.runtime.runDueWakes();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const reports = h.runtime.store.events(taskId, { limit: 100 }).filter((e) => e.type === 'report');
    assert.ok(reports.length >= 1, 'the task agent reported back');
    const wakes = h.runtime.store.dueWakes(Date.now()).filter((w) => w.cause === 'task_report');
    assert.ok(wakes.length >= 1, 'the parent has a task_report wake queued');
    void scripted;
  } finally {
    await h.dispose();
  }
});
