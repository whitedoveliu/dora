import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid, type AgentEvent, type Db, type EventType, type PendingWake, type SessionRecord, type SessionStatus, type Todo, type WakeCause } from '@dora/core';

/**
 * Event-sourced session state.
 *
 * Everything durable is an event: the main session is queried as a conversation, a task
 * session as an event stream, and a tool's full return content is stored — so the event
 * log is the complete window into runtime behaviour.
 *
 * Raw transcripts are also written as JSONL under the account directory. They are build
 * artefacts: they never cross the IM boundary and they are never summarised into a
 * compaction.
 */
export class SessionStore {
  private readonly db: Db;
  private readonly transcriptsDir: string;

  constructor(options: { db: Db; transcriptsDir: string }) {
    this.db = options.db;
    this.transcriptsDir = options.transcriptsDir;
    mkdirSync(this.transcriptsDir, { recursive: true });
  }

  createSession(input: {
    kind: 'main' | 'task';
    role: 'main_agent' | 'task_agent';
    accountId: string;
    parentId?: string | null;
    channel?: string | null;
    title?: string;
    modelMode?: 'fast' | 'smart';
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    const id = ulid(input.kind === 'main' ? 'sess' : 'task');
    const now = Date.now();
    const session: SessionRecord = {
      id,
      kind: input.kind,
      role: input.role,
      accountId: input.accountId,
      parentId: input.parentId ?? null,
      channel: input.channel ?? null,
      status: 'held',
      modelMode: input.modelMode ?? 'fast',
      title: input.title ?? '',
      createdAt: now,
      updatedAt: now,
      heldReason: null,
      metadata: input.metadata ?? {}
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, kind, role, account_id, parent_id, channel, status, model_mode, title, created_at, updated_at, held_reason, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        session.id, session.kind, session.role, session.accountId, session.parentId, session.channel,
        session.status, session.modelMode, session.title, session.createdAt, session.updatedAt, session.heldReason,
        JSON.stringify(session.metadata)
      );
    this.append(session.id, 'session_started', { kind: session.kind, role: session.role, channel: session.channel, parent: session.parentId });
    return session;
  }

  get(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  private map(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row['id']),
      kind: String(row['kind']) as 'main' | 'task',
      role: String(row['role']) as 'main_agent' | 'task_agent',
      accountId: String(row['account_id']),
      parentId: row['parent_id'] === null ? null : String(row['parent_id']),
      channel: row['channel'] === null ? null : String(row['channel']),
      status: String(row['status']) as SessionStatus,
      modelMode: String(row['model_mode']) as 'fast' | 'smart',
      title: String(row['title'] ?? ''),
      createdAt: Number(row['created_at']),
      updatedAt: Number(row['updated_at']),
      heldReason: row['held_reason'] === null ? null : String(row['held_reason']),
      metadata: JSON.parse(String(row['metadata'] ?? '{}')) as Record<string, unknown>
    };
  }

  update(id: string, patch: { status?: SessionStatus; heldReason?: string | null; title?: string; metadata?: Record<string, unknown>; modelMode?: 'fast' | 'smart' }): void {
    const current = this.get(id);
    if (!current) return;
    this.db
      .prepare('UPDATE sessions SET status = ?, held_reason = ?, title = ?, metadata = ?, model_mode = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.status ?? current.status,
        patch.heldReason === undefined ? current.heldReason : patch.heldReason,
        patch.title ?? current.title,
        JSON.stringify(patch.metadata ?? current.metadata),
        patch.modelMode ?? current.modelMode,
        Date.now(),
        id
      );
  }

  append(sessionId: string, type: EventType, data: Record<string, unknown>): AgentEvent {
    const seqRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?').get(sessionId) as { seq: number };
    const seq = Number(seqRow.seq) + 1;
    const event: AgentEvent = { id: ulid('ev'), sessionId, seq, ts: Date.now(), type, data };
    this.db.prepare('INSERT INTO events (id, session_id, seq, ts, type, data) VALUES (?, ?, ?, ?, ?, ?)').run(event.id, sessionId, seq, event.ts, type, JSON.stringify(data));
    this.transcript(sessionId, event);
    return event;
  }

  private transcript(sessionId: string, event: AgentEvent): void {
    try {
      const file = this.transcriptsDir + '/' + sessionId + '.jsonl';
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      /* transcripts are best effort; the database is authoritative */
    }
  }

  events(sessionId: string, options: { sinceSeq?: number; limit?: number } = {}): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(sessionId, options.sinceSeq ?? 0, options.limit ?? 5000) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r['id']),
      sessionId: String(r['session_id']),
      seq: Number(r['seq']),
      ts: Number(r['ts']),
      type: String(r['type']) as EventType,
      data: JSON.parse(String(r['data'])) as Record<string, unknown>
    }));
  }

  latestCompaction(sessionId: string): AgentEvent | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 1")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      sessionId: String(row['session_id']),
      seq: Number(row['seq']),
      ts: Number(row['ts']),
      type: 'compaction',
      data: JSON.parse(String(row['data'])) as Record<string, unknown>
    };
  }

  children(parentId: string): SessionRecord[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at').all(parentId) as Record<string, unknown>[];
    return rows.map((r) => this.map(r));
  }

  sessionsForAccount(accountId: string, limit = 100): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(accountId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.map(r));
  }

  // ---- pending wakes (the delivery queue) -----------------------------------
  enqueueWake(input: { sessionId: string; cause: WakeCause; source: string; payload?: Record<string, unknown>; dueAt?: number }): PendingWake {
    const wake: PendingWake = {
      id: ulid('wake'),
      sessionId: input.sessionId,
      cause: input.cause,
      source: input.source,
      payload: input.payload ?? {},
      dueAt: input.dueAt ?? Date.now(),
      state: 'pending',
      createdAt: Date.now(),
      deliveredAt: null,
      skipReason: null
    };
    this.db
      .prepare('INSERT INTO pending_wakes (id, session_id, cause, source, payload, due_at, state, created_at, delivered_at, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(wake.id, wake.sessionId, wake.cause, wake.source, JSON.stringify(wake.payload), wake.dueAt, wake.state, wake.createdAt, null, null);
    return wake;
  }

  dueWakes(now = Date.now(), limit = 50): PendingWake[] {
    const rows = this.db
      .prepare("SELECT * FROM pending_wakes WHERE state = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?")
      .all(now, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r['id']),
      sessionId: String(r['session_id']),
      cause: String(r['cause']) as WakeCause,
      source: String(r['source']),
      payload: JSON.parse(String(r['payload'])) as Record<string, unknown>,
      dueAt: Number(r['due_at']),
      state: String(r['state']) as PendingWake['state'],
      createdAt: Number(r['created_at']),
      deliveredAt: r['delivered_at'] === null ? null : Number(r['delivered_at']),
      skipReason: r['skip_reason'] === null ? null : String(r['skip_reason'])
    }));
  }

  markWake(id: string, state: 'delivered' | 'skipped' | 'expired', reason?: string): void {
    this.db.prepare('UPDATE pending_wakes SET state = ?, delivered_at = ?, skip_reason = ? WHERE id = ?').run(state, Date.now(), reason ?? null, id);
  }

  pendingWakesFor(sessionId: string): PendingWake[] {
    const rows = this.db.prepare("SELECT * FROM pending_wakes WHERE session_id = ? AND state = 'pending' ORDER BY due_at").all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r['id']),
      sessionId: String(r['session_id']),
      cause: String(r['cause']) as WakeCause,
      source: String(r['source']),
      payload: JSON.parse(String(r['payload'])) as Record<string, unknown>,
      dueAt: Number(r['due_at']),
      state: String(r['state']) as PendingWake['state'],
      createdAt: Number(r['created_at']),
      deliveredAt: null,
      skipReason: null
    }));
  }

  // ---- todos ----------------------------------------------------------------
  listTodos(accountId: string): Todo[] {
    const rows = this.db.prepare('SELECT * FROM todos WHERE account_id = ? ORDER BY COALESCE(due_at, 9223372036854775807), created_at').all(accountId) as Record<string, unknown>[];
    return rows.map(mapTodo);
  }

  createTodo(accountId: string, input: { title: string; dueAt?: number | null; notes?: string; sessionId?: string }): Todo {
    const todo: Todo = {
      id: ulid('todo'),
      accountId,
      sessionId: input.sessionId ?? null,
      title: input.title,
      status: 'open',
      dueAt: input.dueAt ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      notes: input.notes ?? ''
    };
    this.db
      .prepare('INSERT INTO todos (id, account_id, session_id, title, status, due_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(todo.id, todo.accountId, todo.sessionId, todo.title, todo.status, todo.dueAt, todo.notes, todo.createdAt, todo.updatedAt);
    return todo;
  }

  updateTodo(id: string, patch: { title?: string; status?: Todo['status']; dueAt?: number | null; notes?: string }): Todo | null {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const current = mapTodo(row);
    const next: Todo = {
      ...current,
      title: patch.title ?? current.title,
      status: patch.status ?? current.status,
      dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
      notes: patch.notes ?? current.notes,
      updatedAt: Date.now()
    };
    this.db
      .prepare('UPDATE todos SET title = ?, status = ?, due_at = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.status, next.dueAt, next.notes, next.updatedAt, id);
    return next;
  }

  getTodo(id: string): Todo | null {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapTodo(row) : null;
  }

  // ---- budget ---------------------------------------------------------------
  budget(accountId: string, limitUnits = 100): { day: string; units: number; calls: number; limitUnits: number; percent: number } {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.db.prepare('SELECT units, calls FROM budget WHERE account_id = ? AND day = ?').get(accountId, day) as { units: number; calls: number } | undefined;
    const units = row ? Number(row.units) : 0;
    const calls = row ? Number(row.calls) : 0;
    return { day, units, calls, limitUnits, percent: (units / limitUnits) * 100 };
  }

  recordUsage(accountId: string, units: number): void {
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare('INSERT INTO budget (account_id, day, units, calls) VALUES (?, ?, ?, 1) ON CONFLICT(account_id, day) DO UPDATE SET units = units + excluded.units, calls = calls + 1')
      .run(accountId, day, units);
  }
}

function mapTodo(row: Record<string, unknown>): Todo {
  return {
    id: String(row['id']),
    accountId: String(row['account_id']),
    sessionId: row['session_id'] === null ? null : String(row['session_id']),
    title: String(row['title']),
    status: String(row['status']) as Todo['status'],
    dueAt: row['due_at'] === null ? null : Number(row['due_at']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    notes: String(row['notes'] ?? '')
  };
}
