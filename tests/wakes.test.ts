import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCronDate, nextFireFor, parseCron, parseLocalWallClock } from '@dora/runtime';
import { harness } from './helpers.ts';

test('cron fields are parsed without the cron() wrapper', () => {
  const parsed = parseCron('30 9 * * MON-FRI');
  assert.ok(parsed.minutes.has(30));
  assert.ok(parsed.hours.has(9));
  assert.deepEqual([...parsed.daysOfWeek].sort(), [1, 2, 3, 4, 5]);
  assert.throws(() => parseCron('not a cron'), /5 or 6 fields/);
});

test('nextCronDate finds the next matching minute', () => {
  const from = new Date(2026, 0, 5, 8, 0, 0); // Monday 08:00 local
  const next = nextCronDate('30 9 * * MON-FRI', from);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
  assert.equal(next.getDate(), 5);
});

test('clock wakes roll to tomorrow when the time has passed', () => {
  const at = parseLocalWallClock('2030-06-01T09:30:00');
  assert.equal(at.getMinutes(), 30);
  const next = nextFireFor({ style: 'clock', at: '2000-01-01T00:00:00' }, new Date(2026, 5, 1, 12, 0, 0));
  assert.ok(next > new Date(2026, 5, 1, 12, 0, 0).getTime());
  assert.throws(() => parseLocalWallClock('2030-06-01T09:30:00Z'), /without an offset or Z/);
});

test('cadence wakes respect the 5 to 10080 minute window', () => {
  const from = new Date(2026, 0, 1, 0, 0, 0);
  assert.equal(nextFireFor({ style: 'cadence', intervalMinutes: 5 }, from) - from.getTime(), 5 * 60_000);
  assert.throws(() => nextFireFor({ style: 'cadence', intervalMinutes: 1 }, from), /between 5 and 10080/);
  assert.throws(() => nextFireFor({ style: 'cadence', intervalMinutes: 99999 }, from), /between 5 and 10080/);
});

test('a clock wake requires a lateness threshold', async () => {
  const h = await harness('wakes-threshold');
  try {
    const missing = await h.run(['wake_schedule', 'create', '--at', '2030-01-01T09:00:00', '--prompt', 'x']);
    assert.notEqual(missing.exitCode, 0);
    assert.match(missing.stderr, /--schedule-threshold/);

    const twoTimings = await h.run(['wake_schedule', 'create', '--schedule-interval', '10', '--at', '2030-01-01T09:00:00', '--schedule-threshold', '5', '--prompt', 'x']);
    assert.notEqual(twoTimings.exitCode, 0);
    assert.match(twoTimings.stderr, /exactly one of/);
  } finally {
    await h.dispose();
  }
});

test('the scheduler fires due wakes, skips failed triggers and raises safety check-ins', async () => {
  const h = await harness('wakes-tick');
  try {
    const session = h.runtime.ensureMainSession();
    const created = await h.run(['wake_schedule', 'create', '--schedule-interval', '5', '--prompt', 'check the plan']);
    const wakeId = /scheduled (\S+)/.exec(created.stdout)![1];

    // Force the wake due, then tick with a model that refuses the trigger.
    h.runtime.db.prepare('UPDATE wakes SET next_fire_at = ? WHERE id = ?').run(Date.now() - 1000, wakeId);
    const falseModel = { name: 'no-trigger', async complete() { return { content: 'NO', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, meta: {} }; } };
    h.runtime.wakes['deps'].model = falseModel;
    h.runtime.db.prepare('UPDATE wakes SET trigger = ? WHERE id = ?').run('the member is awake', wakeId);
    const tickResult = await h.runtime.wakes.tick();
    assert.equal(tickResult.skipped, 1);
    const runnable = h.runtime.store.dueWakes(Date.now()).filter((w) => w.source === 'wake_schedule');
    assert.equal(runnable.length, 0);
    const skipEvent = h.runtime.store.events(session.id, { limit: 200 }).find((e) => e.data['kind'] === 'wake_skipped');
    assert.ok(skipEvent, 'the skipped wake is recorded');

    // A subscription with a silenced window raises the hosted safety check-in.
    const task = await h.run(['tasks', 'delegate', '--model-mode', 'fast', '--task', 'watch mail']);
    const taskId = /task agent started: (\S+)/.exec(task.stdout)![1];
    await h.run(['wake_subscription', 'subscribe', '--source', 'gmail', '--check-in-frequency-minutes', '60'], taskId);
    const queued = h.runtime.ingestEvent('gmail', { subject: 'planning update' });
    assert.equal(queued, 1);
    // Silence the subscription, then let time pass: the hosted check-in is due.
    h.runtime.db.prepare('UPDATE subscriptions SET last_wake_at = ?, created_at = ? WHERE session_id = ?').run(Date.now() - 3 * 3600_000, Date.now() - 3 * 3600_000, taskId);
    const tick = await h.runtime.wakes.tick();
    assert.ok(tick.checkIns >= 1, 'expected a safety check-in');
    const checkIn = h.runtime.store.dueWakes(Date.now()).find((w) => w.cause === 'safety_check_in');
    assert.ok(checkIn, 'safety check-in wake missing');
    assert.equal(checkIn!.sessionId, taskId);
    void session;
  } finally {
    await h.dispose();
  }
});
