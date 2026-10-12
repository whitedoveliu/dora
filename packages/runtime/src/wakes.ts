import { ulid, type Db, type DoraConfig, type ModelProvider, type SubscriptionSpec, type WakeSpec } from '@dora/core';
import { nextFireFor } from './cron.ts';
import type { SessionStore } from './store.ts';

/**
 * Wake management.
 *
 * Two mechanisms, one queue:
 *   wake_schedule     — a time signal: cadence, clock or cron, each carrying a lateness
 *                       threshold and an optional natural-language trigger condition.
 *   wake_subscription — an event signal: mail, calendar, documents, location, iMessage,
 *                       each carrying a platform-hosted safety check-in that fires after
 *                       a long silence and bypasses the trigger filter.
 *
 * A trigger that does not hold skips the run; it does not fail it.
 */
export interface WakeManagerDeps {
  db: Db;
  store: SessionStore;
  config: DoraConfig;
  model: ModelProvider;
  now?: () => number;
}

export interface WakeRow {
  id: string;
  sessionId: string;
  style: 'cadence' | 'clock' | 'cron';
  intervalMinutes: number | null;
  at: string | null;
  cron: string | null;
  thresholdMinutes: number;
  trigger: string | null;
  prompt: string | null;
  nextFireAt: number | null;
  enabled: boolean;
}

export class WakeManager {
  private readonly deps: WakeManagerDeps;

  constructor(deps: WakeManagerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  create(sessionId: string, spec: WakeSpec): { id: string; nextFireAt: number } {
    const nextFireAt = nextFireFor(spec, new Date(this.now()));
    const id = ulid('wake');
    this.deps.db
      .prepare(
        'INSERT INTO wakes (id, session_id, owner_session_id, style, interval_minutes, at, cron, threshold_minutes, trigger, timezone, prompt, next_fire_at, enabled, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
      )
      .run(
        id, sessionId, sessionId, spec.style, spec.intervalMinutes ?? null, spec.at ?? null, spec.cron ?? null,
        spec.thresholdMinutes ?? 0, spec.trigger ?? null, spec.timezone ?? null, spec.prompt, nextFireAt, 'self', this.now()
      );
    return { id, nextFireAt };
  }

  list(sessionId: string): WakeRow[] {
    const rows = this.deps.db.prepare('SELECT * FROM wakes WHERE session_id = ? ORDER BY created_at').all(sessionId) as Record<string, unknown>[];
    return rows.map(mapWake);
  }

  cancel(sessionId: string, wakeId: string): boolean {
    const result = this.deps.db.prepare('DELETE FROM wakes WHERE id = ? AND session_id = ?').run(wakeId, sessionId);
    return Number(result.changes) > 0;
  }

  update(sessionId: string, wakeId: string, patch: { enabled?: boolean; intervalMinutes?: number }): boolean {
    const row = this.deps.db.prepare('SELECT * FROM wakes WHERE id = ? AND session_id = ?').get(wakeId, sessionId) as Record<string, unknown> | undefined;
    if (!row) return false;
    const wake = mapWake(row);
    const interval = patch.intervalMinutes ?? wake.intervalMinutes;
    const nextFireAt =
      patch.intervalMinutes !== undefined
        ? this.now() + patch.intervalMinutes * 60_000
        : wake.nextFireAt;
    this.deps.db
      .prepare('UPDATE wakes SET enabled = ?, interval_minutes = ?, next_fire_at = ?, style = ? WHERE id = ?')
      .run((patch.enabled ?? wake.enabled) ? 1 : 0, interval, nextFireAt, patch.intervalMinutes !== undefined ? 'cadence' : wake.style, wakeId);
    return true;
  }

  subscribe(sessionId: string, spec: SubscriptionSpec): { id: string; source: string; checkInFrequencyMinutes: number } {
    const existing = this.deps.db
      .prepare('SELECT id FROM subscriptions WHERE session_id = ? AND source = ? AND COALESCE(filter, \'\') = COALESCE(?, \'\')')
      .get(sessionId, spec.source, spec.filter ?? null) as { id: string } | undefined;
    if (existing) throw new Error('already subscribed to ' + spec.source + ' with that filter; do not stack subscriptions');
    const id = ulid('sub');
    const checkIn = spec.checkInFrequencyMinutes ?? 1440;
    this.deps.db
      .prepare('INSERT INTO subscriptions (id, session_id, source, filter, check_in_frequency_minutes, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(id, sessionId, spec.source, spec.filter ?? null, checkIn, this.now());
    return { id, source: spec.source, checkInFrequencyMinutes: checkIn };
  }

  listSubscriptions(sessionId: string): { id: string; source: string; filter: string | null; enabled: boolean; lastWakeAt: number | null }[] {
    const rows = this.deps.db.prepare('SELECT * FROM subscriptions WHERE session_id = ? ORDER BY created_at').all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r['id']),
      source: String(r['source']),
      filter: r['filter'] === null ? null : String(r['filter']),
      enabled: Number(r['enabled']) === 1,
      lastWakeAt: r['last_wake_at'] === null ? null : Number(r['last_wake_at'])
    }));
  }

  unsubscribe(sessionId: string, id: string): boolean {
    const result = this.deps.db.prepare('DELETE FROM subscriptions WHERE id = ? AND session_id = ?').run(id, sessionId);
    return Number(result.changes) > 0;
  }

  /** External event -> queued wakes for every matching subscription. */
  ingestEvent(source: string, payload: Record<string, unknown>): number {
    const rows = this.deps.db.prepare('SELECT * FROM subscriptions WHERE source = ? AND enabled = 1').all(source) as Record<string, unknown>[];
    let queued = 0;
    for (const row of rows) {
      const filter = row['filter'] === null ? null : String(row['filter']);
      if (filter && !JSON.stringify(payload).toLowerCase().includes(filter.toLowerCase())) continue;
      this.deps.store.enqueueWake({ sessionId: String(row['session_id']), cause: 'subscription', source, payload });
      this.deps.db.prepare('UPDATE subscriptions SET last_wake_at = ? WHERE id = ?').run(this.now(), String(row['id']));
      queued += 1;
    }
    return queued;
  }

  /** Trigger evaluation before a scheduled wake fires. */
  async evaluateTrigger(trigger: string | null, context: string): Promise<boolean> {
    if (!trigger || trigger.trim() === '') return true;
    try {
      const response = await this.deps.model.complete({
        model: this.deps.config.model.fast,
        messages: [
          { role: 'system', content: 'You evaluate a wake condition. Answer with exactly YES or NO.' },
          { role: 'user', content: 'Condition: ' + trigger + '\nContext:\n' + context.slice(0, 4000) + '\n\nDoes the condition hold? Answer YES or NO.' }
        ],
        purpose: 'trigger',
        maxTokens: 4,
        temperature: 0
      });
      return /\byes\b/i.test(response.content);
    } catch {
      // A failed evaluation must not silently drop the wake.
      return true;
    }
  }

  /**
   * One scheduler tick: fire due wakes into the queue, raise safety check-ins, and
   * return what is ready to run.
   */
  async tick(options: { contextFor?: (sessionId: string) => string } = {}): Promise<{ fired: number; skipped: number; checkIns: number; queued: number }> {
    const now = this.now();
    let fired = 0;
    let skipped = 0;
    let checkIns = 0;
    const dueWakes = this.deps.db
      .prepare('SELECT * FROM wakes WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?')
      .all(now) as Record<string, unknown>[];

    for (const row of dueWakes) {
      const wake = mapWake(row);
      const context = options.contextFor ? options.contextFor(wake.sessionId) : '';
      const holds = await this.evaluateTrigger(wake.trigger, context);
      if (holds) {
        this.deps.store.enqueueWake({
          sessionId: wake.sessionId,
          cause: 'schedule',
          source: 'wake_schedule',
          payload: { wake_id: wake.id, prompt: wake.prompt ?? '', style: wake.style }
        });
        fired += 1;
      } else {
        // The condition did not hold: record the skip and do not run the session.
        this.deps.db.prepare('UPDATE wakes SET last_result = ? WHERE id = ?').run('skipped: trigger did not hold', wake.id);
        this.deps.store.append(wake.sessionId, 'system', {
          kind: 'wake_skipped',
          wake_id: wake.id,
          trigger: wake.trigger,
          reason: 'trigger did not hold'
        });
        skipped += 1;
      }
      const next =
        wake.style === 'cadence'
          ? now + (wake.intervalMinutes ?? 60) * 60_000
          : nextFireFor({ style: wake.style, at: wake.at ?? undefined, cron: wake.cron ?? undefined }, new Date(now + Math.max(1, wake.thresholdMinutes) * 60_000));
      this.deps.db.prepare('UPDATE wakes SET last_fire_at = ?, next_fire_at = ? WHERE id = ?').run(now, next, wake.id);
    }

    // Safety check-in: hosted by the platform, unaffected by the trigger filter.
    const subs = this.deps.db.prepare('SELECT * FROM subscriptions WHERE enabled = 1').all() as Record<string, unknown>[];
    for (const row of subs) {
      const frequency = Number(row['check_in_frequency_minutes'] ?? 1440) * 60_000;
      const last = Number(row['last_wake_at'] ?? row['created_at']);
      if (now - last >= frequency) {
        this.deps.store.enqueueWake({
          sessionId: String(row['session_id']),
          cause: 'safety_check_in',
          source: String(row['source']),
          payload: { subscription_id: String(row['id']), source: String(row['source']), silent_for_ms: now - last }
        });
        this.deps.db.prepare('UPDATE subscriptions SET last_check_in_at = ? WHERE id = ?').run(now, String(row['id']));
        checkIns += 1;
      }
    }

    const queued = this.deps.store.dueWakes(now).length;
    return { fired, skipped, checkIns, queued };
  }
}

function mapWake(row: Record<string, unknown>): WakeRow {
  return {
    id: String(row['id']),
    sessionId: String(row['session_id']),
    style: String(row['style']) as WakeRow['style'],
    intervalMinutes: row['interval_minutes'] === null ? null : Number(row['interval_minutes']),
    at: row['at'] === null ? null : String(row['at']),
    cron: row['cron'] === null ? null : String(row['cron']),
    thresholdMinutes: Number(row['threshold_minutes'] ?? 0),
    trigger: row['trigger'] === null ? null : String(row['trigger']),
    prompt: row['prompt'] === null ? null : String(row['prompt']),
    nextFireAt: row['next_fire_at'] === null ? null : Number(row['next_fire_at']),
    enabled: Number(row['enabled']) === 1
  };
}
