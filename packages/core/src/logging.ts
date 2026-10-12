import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Server-side logging.
 *
 * Every subsystem writes structured JSON lines to <dataDir>/logs/dora-YYYY-MM-DD.jsonl,
 * one file per day, pruned after the retention window. Logs are the evidence trail:
 * a run can be reconstructed from the session id alone.
 *
 * Two rules are enforced here rather than trusted to callers:
 *   - secrets never reach a log line (redactSecrets + redactArgv),
 *   - a record always carries ts, level and channel, so tooling can rely on the shape.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  channel: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
  /** Bind fields (session id, account, request id) to every record from this logger. */
  bind(fields: Record<string, unknown>): Logger;
}

export interface LoggingOptions {
  dir?: string;
  level?: LogLevel;
  retentionDays?: number;
  /** Mirror to stderr; tests set this to false. */
  echo?: boolean;
  now?: () => Date;
}

interface LoggingState {
  dir: string | null;
  level: LogLevel;
  retentionDays: number;
  echo: boolean;
  now: () => Date;
  count: number;
}

const state: LoggingState = {
  dir: process.env.DORA_LOG_DIR ?? null,
  level: (process.env.DORA_LOG_LEVEL as LogLevel) ?? 'info',
  retentionDays: Number.parseInt(process.env.DORA_LOG_RETENTION_DAYS ?? '14', 10),
  echo: process.env.DORA_LOG_ECHO !== '0',
  now: () => new Date(),
  count: 0
};

export function configureLogging(options: LoggingOptions = {}): void {
  if (options.dir !== undefined) state.dir = options.dir;
  if (options.level) state.level = options.level;
  if (options.retentionDays !== undefined) state.retentionDays = options.retentionDays;
  if (options.echo !== undefined) state.echo = options.echo;
  if (options.now) state.now = options.now;
  if (state.dir) {
    mkdirSync(state.dir, { recursive: true });
    prune();
  }
}

export function loggingStatus(): { dir: string | null; level: LogLevel; retentionDays: number; files: string[] } {
  const files = state.dir && existsSync(state.dir) ? readdirSync(state.dir).filter((f) => f.endsWith('.jsonl')).sort() : [];
  return { dir: state.dir, level: state.level, retentionDays: state.retentionDays, files };
}

function prune(): void {
  if (!state.dir || state.retentionDays <= 0) return;
  const cutoff = state.now().getTime() - state.retentionDays * 86_400_000;
  for (const file of readdirSync(state.dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const full = join(state.dir, file);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
    } catch {
      /* a file that vanished is already pruned */
    }
  }
}

export function currentLogFile(now: Date = new Date()): string | null {
  if (!state.dir) return null;
  return join(state.dir, 'dora-' + now.toISOString().slice(0, 10) + '.jsonl');
}

export function readLog(options: { dir?: string; date?: string; level?: LogLevel; channel?: string; session?: string; limit?: number } = {}): LogRecord[] {
  const dir = options.dir ?? state.dir;
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => (options.date ? f.includes(options.date) : true))
    .sort();
  const records: LogRecord[] = [];
  for (const file of files) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line) as LogRecord;
        if (options.level && ORDER[record.level] < ORDER[options.level]) continue;
        if (options.channel && record.channel !== options.channel && !String(record.channel).startsWith(options.channel + ':')) continue;
        if (options.session && record['session'] !== options.session && record['sessionId'] !== options.session) continue;
        records.push(record);
      } catch {
        /* skip a torn line */
      }
    }
  }
  const limit = options.limit ?? 200;
  return records.slice(-limit);
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /("?(?:api[_-]?key|token|secret|password|authorization|card_number|cvc)"?\s*[:=]\s*"?)([^"\s,}]{4,})/gi,
  /(Bearer\s+)[A-Za-z0-9._-]{12,}/g
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (prefix ? prefix + '<redacted>' : '<redacted>'));
  }
  return out;
}

/** A tools CLI argument list with secret-bearing option values masked. */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const token of argv) {
    if (maskNext) {
      out.push('<redacted>');
      maskNext = false;
      continue;
    }
    if (/^--(token|password|secret|api-key|card-number|cvc|key)$/i.test(token)) {
      out.push(token);
      maskNext = true;
      continue;
    }
    const inline = /^(--(?:token|password|secret|api-key|card-number|cvc|key)=)(.*)$/i.exec(token);
    if (inline) {
      out.push(inline[1] + '<redacted>');
      continue;
    }
    out.push(redactSecrets(token));
  }
  return out;
}

function emit(level: LogLevel, channel: string, bound: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[state.level]) return;
  const record: LogRecord = {
    ts: state.now().toISOString(),
    level,
    channel,
    msg: redactSecrets(msg),
    ...bound,
    ...(fields ?? {})
  };
  const line = JSON.stringify(record, (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value));
  state.count += 1;
  const file = currentLogFile(state.now());
  if (file) {
    try {
      appendFileSync(file, line + '\n', 'utf8');
    } catch {
      /* logging must never break the runtime */
    }
  }
  if (state.echo) process.stderr.write(line + '\n');
}

export function createLogger(channel: string, bound: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', channel, bound, msg, fields),
    info: (msg, fields) => emit('info', channel, bound, msg, fields),
    warn: (msg, fields) => emit('warn', channel, bound, msg, fields),
    error: (msg, fields) => emit('error', channel, bound, msg, fields),
    child: (scope: string) => createLogger(channel + ':' + scope, bound),
    bind: (fields: Record<string, unknown>) => createLogger(channel, { ...bound, ...fields })
  };
}

/** Count of records written in this process — used by tests and `dora doctor`. */
export function logRecordCount(): number {
  return state.count;
}
