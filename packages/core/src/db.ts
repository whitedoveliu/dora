import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export interface Migration {
  name: string;
  sql: string;
}

/**
 * Core schema. Everything the runtime persists lives in one SQLite database so the
 * daemon and the tools CLI share one writer.
 */
export const CORE_SCHEMA: Migration[] = [
  {
    name: '001_core',
    sql: `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  account_id TEXT NOT NULL,
  parent_id TEXT,
  channel TEXT,
  status TEXT NOT NULL,
  model_mode TEXT NOT NULL DEFAULT 'fast',
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  held_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

CREATE TABLE IF NOT EXISTS contracts_read (
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, action)
);

CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_session_id TEXT,
  style TEXT NOT NULL,
  interval_minutes INTEGER,
  at TEXT,
  cron TEXT,
  threshold_minutes INTEGER NOT NULL DEFAULT 0,
  trigger TEXT,
  timezone TEXT,
  prompt TEXT,
  next_fire_at INTEGER,
  last_fire_at INTEGER,
  last_result TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'self',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wakes_due ON wakes(enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  filter TEXT,
  check_in_frequency_minutes INTEGER NOT NULL DEFAULT 1440,
  last_wake_at INTEGER,
  last_check_in_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_source ON subscriptions(source, enabled);

CREATE TABLE IF NOT EXISTS pending_wakes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  skip_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_wakes ON pending_wakes(state, due_at);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  due_at INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_account ON todos(account_id, status);

CREATE TABLE IF NOT EXISTS flags (
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (account_id, name)
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  units REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS connector_accounts (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  label TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  auth_kind TEXT NOT NULL DEFAULT 'fixture',
  created_at INTEGER NOT NULL,
  credentials TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_connector_accounts ON connector_accounts(connector);

CREATE TABLE IF NOT EXISTS connector_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE(account_id, connector, kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_connector_records ON connector_records(connector, kind, ts DESC);

CREATE TABLE IF NOT EXISTS browser_leases (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  site TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE TABLE IF NOT EXISTS browser_guidance (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  site TEXT NOT NULL,
  flow TEXT NOT NULL,
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  thread_id TEXT,
  template TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_messages ON channel_messages(account_id, channel, ts DESC);

CREATE TABLE IF NOT EXISTS channel_windows (
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  last_inbound_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, channel, address)
);
`
  }
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function migrate(db: Db, migrations: Migration[]): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);');
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name)
  );
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}


export function getKv(db: Db, key: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return row ? row.v : null;
}

export function setKv(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at'
  ).run(key, value, Date.now());
}
