/**
 * Cron and clock arithmetic for wake_schedule.
 *
 * Cron and wake_schedule take the fields without the cron(...) wrapper:
 *   minutes hours day-of-month month day-of-week [year]
 * with 0-7 or SUN-SAT for the day of week, and later rules winning.
 */
export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  years: Set<number> | null;
}

const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function parseField(field: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const out = new Set<number>();
  const normalise = (token: string): number => {
    const upper = token.toUpperCase();
    if (names && upper in names) return names[upper];
    const n = Number.parseInt(token, 10);
    if (!Number.isFinite(n)) throw new Error('invalid cron field token: ' + token);
    return n;
  };
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error('invalid cron step: ' + part);
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const [a, b] = rangePart.split('-');
      start = normalise(a);
      end = b === undefined ? (stepPart ? max : start) : normalise(b);
    }
    for (let v = start; v <= end; v += step) {
      const value = max === 7 && v === 7 ? 0 : v;
      if (value < min || value > max) throw new Error('cron value out of range: ' + v);
      out.add(value);
    }
  }
  return out;
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) throw new Error('cron needs 5 or 6 fields: minutes hours day-of-month month day-of-week [year]');
  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 6, DOW_NAMES),
    years: fields[5] ? parseField(fields[5], 1970, 2199) : null
  };
}

/** Next matching minute after `from`, searching at most 366 days ahead. */
export function nextCronDate(expression: string, from: Date = new Date()): Date {
  const cron = parseCron(expression);
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    const minute = cursor.getMinutes();
    const hour = cursor.getHours();
    const dom = cursor.getDate();
    const month = cursor.getMonth() + 1;
    const dow = cursor.getDay();
    const year = cursor.getFullYear();
    const match =
      cron.minutes.has(minute) &&
      cron.hours.has(hour) &&
      cron.months.has(month) &&
      cron.daysOfWeek.has(dow) &&
      (cron.years === null || cron.years.has(year)) &&
      // Standard cron semantics: when both day fields are restricted, either may match.
      (cron.daysOfMonth.has(dom) || cron.daysOfWeek.size === 7 ? cron.daysOfMonth.has(dom) : true);
    if (match) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error('cron expression never matches within a year: ' + expression);
}

/** Parse `yyyy-mm-ddThh:mm:ss` as a local wall-clock time (no offset, no Z). */
export function parseLocalWallClock(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) throw new Error('--at must look like yyyy-mm-ddThh:mm:ss, without an offset or Z');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'), 0);
}

export function nextFireFor(spec: { style: 'cadence' | 'clock' | 'cron'; intervalMinutes?: number; at?: string; cron?: string }, from: Date = new Date()): number {
  if (spec.style === 'cadence') {
    const minutes = spec.intervalMinutes ?? 60;
    if (minutes < 5 || minutes > 10080) throw new Error('--schedule-interval must be between 5 and 10080 minutes');
    return from.getTime() + minutes * 60_000;
  }
  if (spec.style === 'clock') {
    if (!spec.at) throw new Error('clock wake needs --at');
    const base = parseLocalWallClock(spec.at);
    // The wall clock carries a time of day (and optionally a date). Put it in the current
    // year, then move forward one day at a time until the fire is genuinely in the future.
    const at = new Date(from.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), base.getMinutes(), base.getSeconds(), 0);
    let guard = 0;
    while (at.getTime() <= from.getTime() && guard < 400) {
      at.setDate(at.getDate() + 1);
      guard += 1;
    }
    return at.getTime();
  }
  if (!spec.cron) throw new Error('cron wake needs --schedule-cron');
  return nextCronDate(spec.cron, from).getTime();
}
