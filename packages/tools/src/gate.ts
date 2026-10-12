import type { Attachment, Db } from '@dora/core';

/** Built-ins do not need their contract read first. */
export const BUILTIN_PATHS = new Set(['help', 'async.wait', 'async.list']);

/**
 * The Help gate.
 *
 * First call to an action without its contract read is blocked with exit code 3 and the
 * full help page attached; the call is allowed from the next turn. The gate is per
 * session, so a task agent that was handed pre-injected pages starts unblocked for
 * exactly those pages.
 */
export class HelpGate {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  isRead(sessionId: string, path: string): boolean {
    if (BUILTIN_PATHS.has(path)) return true;
    const row = this.db
      .prepare('SELECT 1 AS ok FROM contracts_read WHERE session_id = ? AND action = ?')
      .get(sessionId, path) as { ok: number } | undefined;
    return row !== undefined;
  }

  markRead(sessionId: string, paths: string[]): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO contracts_read (session_id, action, read_at) VALUES (?, ?, ?)');
    const now = Date.now();
    for (const p of paths) stmt.run(sessionId, p, now);
  }

  readPaths(sessionId: string): string[] {
    return (this.db.prepare('SELECT action FROM contracts_read WHERE session_id = ? ORDER BY read_at').all(sessionId) as { action: string }[]).map(
      (r) => r.action
    );
  }

  /** Pre-inject pages for a task agent opening package. */
  preload(sessionId: string, paths: string[], render: (path: string) => string | null): Attachment[] {
    const attachments: Attachment[] = [];
    for (const path of paths) {
      const page = render(path);
      if (!page) continue;
      attachments.push({ name: 'help:' + path, kind: 'help_page', mime: 'text/plain', content: page, truncated: false });
    }
    this.markRead(sessionId, attachments.map((a) => a.name.replace(/^help:/, '')));
    return attachments;
  }
}

export function blockedMessage(paths: string[]): string {
  const list = paths.map((p) => '`' + p.replace(/\./g, '_') + '`').join(', ');
  return (
    'Blocked: ' +
    list +
    " didn't run — an action's help usage contract must be read before it's called. The contracts are below; you can call them from your next turn."
  );
}
