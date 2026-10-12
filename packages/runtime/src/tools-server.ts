import { createServer, type Server } from 'node:net';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { executeArgv, type ExecuteOutput } from '@dora/tools';
import type { AccountRef, DoraConfig, DoraServices, FlagMap, SessionRecord } from '@dora/core';
import type { ToolRegistry } from '@dora/tools';
import type { Db } from '@dora/core';

/**
 * The session socket.
 *
 * Inside the sandbox the tools CLI is a separate process talking to the runtime over
 * a unix socket in the data directory, which the seatbelt profile hides from the
 * agent's own shell: the agent can run the CLI but cannot open the socket itself.
 */
export interface ToolsServerDeps {
  config: DoraConfig;
  db: Db;
  registry: ToolRegistry;
  servicesFor: (sessionId: string, accountId: string) => { services: DoraServices; session: SessionRecord; account: AccountRef; flags: FlagMap } | null;
  /**
   * A caller proves which agent it is with a token derived from the session id. The
   * token is injected into that session's bash environment only, so a task agent cannot
   * call an action as the main agent even though it can reach the same socket.
   */
  verifyToken: (sessionId: string, token: string) => boolean;
}

export class ToolsServer {
  private readonly deps: ToolsServerDeps;
  private server: Server | null = null;

  constructor(deps: ToolsServerDeps) {
    this.deps = deps;
  }

  async start(): Promise<string> {
    mkdirSync(dirname(this.deps.config.socketPath), { recursive: true, mode: 0o700 });
    try {
      rmSync(this.deps.config.socketPath, { force: true });
    } catch {
      /* a stale socket is replaced */
    }
    this.server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        void this.handle(line)
          .then((response) => socket.write(JSON.stringify(response) + '\n'))
          .catch((err: unknown) => socket.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) + '\n'))
          .finally(() => socket.end());
      });
      socket.on('error', () => socket.destroy());
    });
    await new Promise<void>((resolve) => this.server!.listen(this.deps.config.socketPath, () => resolve()));
    try {
      chmodSync(this.deps.config.socketPath, 0o600);
    } catch {
      /* best effort */
    }
    return this.deps.config.socketPath;
  }

  private async handle(line: string): Promise<ExecuteOutput & { error?: string }> {
    let payload: { argv?: string[]; sessionId?: string; accountId?: string; workspace?: string; stdin?: string; token?: string };
    try {
      payload = JSON.parse(line) as typeof payload;
    } catch {
      return { exitCode: 64, stdout: '', stderr: 'malformed request', attachments: [] };
    }
    const sessionId = payload.sessionId ?? '';
    if (!this.deps.verifyToken(sessionId, payload.token ?? '')) {
      return { exitCode: 70, stdout: '', stderr: 'tools socket: caller is not the session it claims to be', attachments: [] };
    }
    const session = this.deps.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as { account_id: string } | undefined;
    if (!session) {
      return { exitCode: 70, stdout: '', stderr: 'unknown session: ' + sessionId, attachments: [] };
    }
    const resolved = this.deps.servicesFor(sessionId, String(session.account_id));
    if (!resolved) {
      return { exitCode: 70, stdout: '', stderr: 'runtime has no services for account ' + session.account_id, attachments: [] };
    }
    return executeArgv({
      argv: payload.argv ?? [],
      session: resolved.session,
      account: resolved.account,
      flags: resolved.flags,
      services: resolved.services,
      config: this.deps.config,
      db: this.deps.db,
      registry: this.deps.registry,
      workspace: payload.workspace,
      stdin: payload.stdin
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // A CLI that is still connected (a long tool call, a wedged child) must not hold
    // shutdown open: drop the sockets, then stop accepting, and never wait forever.
    this.server.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((resolve) => this.server!.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())
    ]);
    try {
      rmSync(this.deps.config.socketPath, { force: true });
    } catch {
      /* best effort */
    }
    this.server = null;
  }
}
