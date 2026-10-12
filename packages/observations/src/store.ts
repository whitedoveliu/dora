import type { Db, ObservationRow, ObservationsService } from '@dora/core';

/**
 * The observation index.
 *
 * External connector data — mail, messages, calendar, documents — is written into one
 * indexed table per account and reached through exactly two actions: a guarded SQL query
 * and a fetch by path. The raw directory is never browsable with shell commands.
 *
 * Query limits are enforced here rather than trusted to the caller: SELECT/WITH only,
 * 3 second budget, 10000 row cap, no OFFSET, and a timestamp condition on any query that
 * touches a month-partitioned view.
 */
export interface ObservationsOptions {
  db: Db;
  accountId: string;
  timeoutMs?: number;
  maxRows?: number;
  /** Directory holding attachment bodies referenced by path. */
  filesDir?: string;
}

export interface SourceStat {
  source: string;
  rows: number;
  lastIngest: number | null;
}

const MONTH_PARTITIONED = new Set(['messaging', 'phone_messages', 'chat-sessions', 'gmail', 'calendar_events']);

/** Relations a statement touches: the token after FROM/JOIN, ignoring subqueries and CTEs. */
export function referencedRelations(query: string): string[] {
  const found = new Set<string>();
  const withoutStrings = query.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  for (const match of withoutStrings.matchAll(/\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_-]*)/gi)) {
    found.add(match[1]);
  }
  return [...found];
}

export class ObservationsStore implements ObservationsService {
  private readonly db: Db;
  private readonly accountId: string;
  private readonly timeoutMs: number;
  private readonly maxRows: number;

  constructor(options: ObservationsOptions) {
    this.db = options.db;
    this.accountId = options.accountId;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maxRows = options.maxRows ?? 10000;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT 'text/plain',
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(account_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_observations_source ON observations(account_id, source, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_observations_path ON observations(account_id, path);
      CREATE TABLE IF NOT EXISTS observations_ingest (
        account_id TEXT NOT NULL,
        source TEXT NOT NULL,
        last_ingest INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        PRIMARY KEY (account_id, source)
      );
    `);
    // Convenience views, one per source, over the single observations table.
    for (const source of ['gmail', 'calendar_events', 'drive_files', 'docs', 'messaging', 'phone_messages', 'chat-sessions', 'meetings', 'notes']) {
      this.db.exec(`CREATE VIEW IF NOT EXISTS "v_${source}" AS SELECT path, title, body, ts, metadata FROM observations WHERE account_id = '${this.accountId}' AND source = '${source}';`);
    }
    // Same views under their bare names for the SQL surface the model sees.
    for (const source of ['gmail', 'calendar_events', 'messaging', 'phone_messages', 'gmail_messages']) {
      try {
        this.db.exec(`CREATE VIEW IF NOT EXISTS "${source}" AS SELECT path, title, body, ts, metadata FROM observations WHERE account_id = '${this.accountId}' AND source = '${source === 'gmail_messages' ? 'gmail' : source}';`);
      } catch {
        /* a pre-existing table with that name wins */
      }
    }
  }

  /**
   * Tables the SQL surface is allowed to see. Everything else in this database belongs to
   * the control plane — sessions, events, flags, connector accounts with their credentials
   * — and is never reachable from an agent-facing query.
   */
  static readonly ALLOWED_RELATIONS = new Set([
    'observations',
    'observations_ingest',
    'gmail',
    'gmail_messages',
    'calendar_events',
    'drive_files',
    'docs',
    'messaging',
    'phone_messages',
    'chat-sessions',
    'meetings',
    'notes',
    'v_gmail',
    'v_calendar_events',
    'v_drive_files',
    'v_docs',
    'v_messaging',
    'v_phone_messages',
    'v_chat-sessions',
    'v_meetings',
    'v_notes'
  ]);

  /** Guard the statement before it reaches SQLite. */
  assertAllowed(query: string): void {
    const trimmed = query.trim().replace(/;+$/, '');
    if (!/^(select|with)\b/i.test(trimmed)) {
      throw new Error('observations.sql only accepts SELECT or WITH statements');
    }
    for (const relation of referencedRelations(trimmed)) {
      if (!ObservationsStore.ALLOWED_RELATIONS.has(relation.toLowerCase())) {
        throw new Error(
          'observations.sql cannot read "' + relation + '"; the observation surface is ' +
            [...ObservationsStore.ALLOWED_RELATIONS].filter((r) => !r.startsWith('v_')).join(', ')
        );
      }
    }
    if (/\b(insert|update|delete|drop|alter|create|attach|pragma|vacuum|replace)\b/i.test(trimmed)) {
      throw new Error('observations.sql rejects write or DDL keywords');
    }
    if (/\boffset\b/i.test(trimmed)) {
      throw new Error('observations.sql does not use OFFSET; page with a timestamp condition instead');
    }
    const touchesPartition = [...MONTH_PARTITIONED].some((t) => new RegExp('\\b' + t + '\\b', 'i').test(trimmed));
    const hasTimestamp = /\b(ts|timestamp|date|day|month)\b\s*(=|>|<|>=|<=|between|like|in)/i.test(trimmed) || /strftime\s*\(/i.test(trimmed);
    if (touchesPartition && !hasTimestamp) {
      throw new Error('a query over a month-partitioned table must carry a timestamp condition');
    }
    const semicolons = trimmed.split(';').length - 1;
    if (semicolons > 0) throw new Error('observations.sql accepts a single statement');
  }

  sql(query: string): { columns: string[]; rows: ObservationRow[]; truncated: boolean; ms: number } {
    this.assertAllowed(query);
    const started = Date.now();
    const stmt = this.db.prepare(query);
    const rows: ObservationRow[] = [];
    let truncated = false;
    // node:sqlite iterates synchronously; the budget is checked as rows stream in.
    for (const row of stmt.iterate() as Iterable<ObservationRow>) {
      if (Date.now() - started > this.timeoutMs) {
        throw new Error('observations.sql exceeded the ' + this.timeoutMs + ' ms budget');
      }
      if (rows.length >= this.maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    const columns = rows.length > 0 ? Object.keys(rows[0]) : (stmt.columns?.().map((c: { name: string }) => c.name) ?? []);
    return { columns, rows, truncated, ms: Date.now() - started };
  }

  fetch(path: string): { path: string; content: string; mime: string } | null {
    const row = this.db
      .prepare('SELECT path, body, mime FROM observations WHERE account_id = ? AND path = ?')
      .get(this.accountId, path) as { path: string; body: string; mime: string } | undefined;
    return row ? { path: row.path, content: row.body, mime: row.mime } : null;
  }

  ingest(source: string, records: Record<string, unknown>[]): number {
    const stmt = this.db.prepare(
      'INSERT INTO observations (id, account_id, source, path, mime, title, body, ts, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(account_id, path) DO UPDATE SET title = excluded.title, body = excluded.body, ts = excluded.ts, metadata = excluded.metadata'
    );
    let count = 0;
    for (const record of records) {
      const path = String(record['path'] ?? record['id'] ?? source + '/' + count);
      stmt.run(
        this.accountId + ':' + path,
        this.accountId,
        source,
        path,
        String(record['mime'] ?? 'text/plain'),
        String(record['title'] ?? ''),
        String(record['body'] ?? ''),
        Number(record['ts'] ?? Date.now()),
        JSON.stringify(record['metadata'] ?? {})
      );
      count += 1;
    }
    this.db
      .prepare('INSERT INTO observations_ingest (account_id, source, last_ingest, rows) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, source) DO UPDATE SET last_ingest = excluded.last_ingest, rows = excluded.rows')
      .run(this.accountId, source, Date.now(), count);
    return count;
  }

  sources(): SourceStat[] {
    const rows = this.db
      .prepare('SELECT source, COUNT(*) AS rows FROM observations WHERE account_id = ? GROUP BY source ORDER BY source')
      .all(this.accountId) as { source: string; rows: number }[];
    const ingest = this.db
      .prepare('SELECT source, last_ingest FROM observations_ingest WHERE account_id = ?')
      .all(this.accountId) as { source: string; last_ingest: number }[];
    const lastBySource = new Map(ingest.map((i) => [i.source, i.last_ingest]));
    return rows.map((r) => ({ source: r.source, rows: Number(r.rows), lastIngest: lastBySource.get(r.source) ?? null }));
  }
}
