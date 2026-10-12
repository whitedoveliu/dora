import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createLogger } from '@dora/core';
import { executeArgv, renderHelpPage } from '@dora/tools';
import type { AgentEvent, DoraServices, FlagMap } from '@dora/core';
import type { RuntimeBundle } from '@dora/runtime';

/**
 * The management API.
 *
 * The console SPA talks to one API and one API only. Conversation over the web is a
 * feature-flagged surface: with agent_chat off, /agent answers "Agent chat feature not
 * enabled" and the console stays a management surface.
 */
export interface ApiOptions {
  runtime: RuntimeBundle;
  adminToken: string;
  webRoot: string;
  version?: string;
}

export interface ApiServer {
  server: Server;
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8'
};

export function createApiServer(options: ApiOptions): ApiServer {
  const { runtime, adminToken, webRoot } = options;
  const version = options.version ?? '0.1.0';
  const started = Date.now();

  const json = (res: ServerResponse, status: number, payload: unknown) => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  const html = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  const authorised = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ') && header.slice(7) === adminToken) return true;
    return url.searchParams.get('token') === adminToken;
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const sse = (res: ServerResponse, subscribe: (send: (event: string, data: unknown) => void) => () => void) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    const send = (event: string, data: unknown) => {
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    };
    const unsubscribe = subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    heartbeat.unref?.();
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  };

  const httpLog = createLogger('http');
  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authed = authorised(req, url);
    res.on('finish', () => {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      httpLog[level]('request', {
        method: req.method ?? 'GET',
        path: url.pathname,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        authenticated: authed,
        query_force: url.searchParams.get('force') === '1'
      });
    });
    void handle(req, res).catch((err: unknown) => {
      httpLog.error('handler threw', {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null
      });
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // ---- member-facing vault form (no admin token: it is a one-time link) ----
    if (path.startsWith('/vault/fill/')) {
      const token = path.slice('/vault/fill/'.length);
      if (req.method === 'GET') return html(res, 200, vaultForm(token, false));
      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const values: Record<string, string> = {};
          for (const [k, v] of Object.entries(body)) if (typeof v === 'string') values[k] = v;
          const item = runtime.services.vault.submitFill(token, values);
          return html(res, 200, vaultForm(token, true, item.label));
        } catch (err) {
          return html(res, 400, vaultForm(token, false, undefined, err instanceof Error ? err.message : String(err)));
        }
      }
    }

    // ---- conversation surface, feature-flagged ----
    if (path === '/agent') {
      if (!runtime.flags['agent_chat']) return json(res, 403, { error: 'Agent chat feature not enabled' });
      return serveStatic(res, webRoot, 'agent.html');
    }

    if (!path.startsWith('/api/')) {
      return serveStatic(res, webRoot, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    }

    if (path === '/api/health') {
      return json(res, 200, { ok: true, version, uptime_ms: Date.now() - started, account: runtime.account.handle, data_dir: runtime.config.dataDir });
    }

    if (!authorised(req, url)) return json(res, 401, { error: 'missing or invalid admin token' });

    const services: DoraServices = runtime.services;

    // ---- overview ----
    if (path === '/api/overview') {
      const sessions = runtime.store.sessionsForAccount(runtime.account.id, 200);
      const sources = services.observations.sources();
      const leases = services.browser.leases();
      const todoList = services.runtime.todos.list(runtime.account.id);
      return json(res, 200, {
        account: runtime.account,
        flags: runtime.flags,
        sessions: sessions.length,
        main_session: runtime.ensureMainSession().id,
        events: runtime.db.prepare('SELECT COUNT(*) AS n FROM events').get(),
        observations: sources,
        observation_rows: sources.reduce((n, s) => n + s.rows, 0),
        connectors: services.connectors.list().map((c) => ({ ...c, connected: services.connectors.isConnected(c.name), accounts: services.connectors.accounts(c.name).length })),
        leases,
        todos: { open: todoList.filter((t) => t.status === 'open').length, total: todoList.length },
        budget: services.runtime.budget(runtime.account.id),
        memory: services.memory.recent(0) ? undefined : undefined,
        memory_files: services.memory.list().length,
        skills: services.skills.list().length,
        vault_items: services.vault.list().length,
        version,
        uptime_ms: Date.now() - started
      });
    }

    // ---- tool surface ----
    if (path === '/api/tools') {
      const index = runtime.registry.index((c) => services.connectors.isConnected(c));
      return json(res, 200, {
        families: index.families,
        singles: index.singles,
        total: index.totalActions,
        declared_total: index.declaredTotal,
        actions: runtime.registry.list().map((a) => ({ path: a.path, family: a.family, trait: a.trait, connector: a.connector ?? null, summary: a.summary, has_output_json: a.outputJson !== null }))
      });
    }

    const helpMatch = /^\/api\/tools\/(.+)\/help$/.exec(path);
    if (helpMatch) {
      const action = runtime.registry.get(decodeURIComponent(helpMatch[1]));
      if (!action) return json(res, 404, { error: 'no such action' });
      return json(res, 200, { path: action.path, page: renderHelpPage(action) });
    }

    if (path === '/api/tools/exec' && req.method === 'POST') {
      const body = await readBody(req);
      const argv = Array.isArray(body['argv']) ? (body['argv'] as string[]) : [];
      const session = body['session_id'] ? runtime.store.get(String(body['session_id'])) : runtime.ensureMainSession();
      if (!session) return json(res, 404, { error: 'no such session' });
      const result = await executeArgv({
        argv, session, account: runtime.account, flags: runtime.flags, services,
        config: runtime.config, db: runtime.db, registry: runtime.registry
      });
      return json(res, 200, result);
    }

    // ---- sessions ----
    if (path === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, { sessions: runtime.store.sessionsForAccount(runtime.account.id, Number(url.searchParams.get('limit') ?? 100)) });
    }
    if (path === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = body['kind'] === 'task' ? 'task' : 'main';
      const session = runtime.store.createSession({
        kind,
        role: kind === 'main' ? 'main_agent' : 'task_agent',
        accountId: runtime.account.id,
        channel: typeof body['channel'] === 'string' ? body['channel'] : 'console',
        title: typeof body['title'] === 'string' ? body['title'] : 'Console session',
        modelMode: body['model_mode'] === 'smart' ? 'smart' : 'fast'
      });
      return json(res, 201, { session });
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/messages|\/stream|\/events)?$/.exec(path);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const sub = sessionMatch[2];
      const session = runtime.store.get(sessionId);
      if (!session) return json(res, 404, { error: 'no such session' });

      if (!sub && req.method === 'GET') {
        const sinceSeq = Number(url.searchParams.get('since') ?? 0);
        return json(res, 200, { session, events: runtime.store.events(sessionId, { sinceSeq, limit: Number(url.searchParams.get('limit') ?? 500) }) });
      }
      if (sub === '/events') {
        return json(res, 200, { events: runtime.store.events(sessionId, { sinceSeq: Number(url.searchParams.get('since') ?? 0) }) });
      }
      if (sub === '/messages' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body['text'] ?? '').trim();
        if (!text) return json(res, 400, { error: 'text is required' });
        if (!runtime.flags['agent_chat'] && session.kind === 'main' && url.searchParams.get('force') !== '1') {
          return json(res, 403, { error: 'Agent chat feature not enabled' });
        }
        const result = await runtime.submitUserMessage(text, { sessionId, channel: session.channel });
        return json(res, 200, { result });
      }
      if (sub === '/stream') {
        return sse(res, (send) => {
          send('snapshot', { session, events: runtime.store.events(sessionId, { limit: 200 }) });
          return runtime.onEvent((event: AgentEvent) => {
            if (event.sessionId === sessionId) send('event', event);
          });
        });
      }
    }

    // ---- global event stream ----
    if (path === '/api/events/stream') {
      return sse(res, (send) => {
        send('hello', { account: runtime.account.handle });
        return runtime.onEvent((event) => send('event', event));
      });
    }

    // ---- connectors ----
    if (path === '/api/connectors' && req.method === 'GET') {
      return json(res, 200, {
        connectors: services.connectors.list().map((c) => ({
          ...c,
          connected: services.connectors.isConnected(c.name),
          accounts: services.connectors.accounts(c.name)
        }))
      });
    }
    if (path === '/api/connectors/accounts' && req.method === 'POST') {
      const body = await readBody(req);
      const connector = String(body['connector'] ?? '');
      const label = String(body['label'] ?? '');
      if (!connector || !label) return json(res, 400, { error: 'connector and label are required' });
      const account = services.connectors.addAccount(connector, label, typeof body['token'] === 'string' ? { token: body['token'] } : {});
      return json(res, 201, { account });
    }
    const accountMatch = /^\/api\/connectors\/accounts\/([^/]+)$/.exec(path);
    if (accountMatch && req.method === 'DELETE') {
      const ok = services.connectors.disconnectAccount(accountMatch[1]);
      return json(res, ok ? 200 : 404, { disconnected: ok });
    }

    // ---- skills ----
    if (path === '/api/skills') {
      return json(res, 200, {
        skills: services.skills.list().map((s) => {
          const read = services.skills.read(s.id, runtime.flags);
          return { ...s, body: read?.body ?? null };
        })
      });
    }

    // ---- memory ----
    if (path === '/api/memory') {
      return json(res, 200, { files: services.memory.list(), stats: (services.memory as unknown as { stats?: () => unknown }).stats?.() ?? null });
    }
    if (path === '/api/memory/file' && req.method === 'POST') {
      const body = await readBody(req);
      const filePath = String(body['path'] ?? '');
      const content = String(body['body'] ?? '');
      if (!filePath) return json(res, 400, { error: 'path is required' });
      const file = services.memory.write(filePath, content, typeof body['type'] === 'string' ? { type: body['type'] } : {});
      const commit = services.memory.commit('admin edit of ' + filePath);
      return json(res, 200, { file, commit });
    }

    // ---- observations ----
    if (path === '/api/observations') {
      return json(res, 200, { sources: services.observations.sources() });
    }
    if (path === '/api/observations/sql' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 200, services.observations.sql(String(body['query'] ?? '')));
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ---- vault ----
    if (path === '/api/vault') {
      return json(res, 200, { items: services.vault.list(), links: services.vault.pendingLinks() });
    }
    if (path === '/api/vault/links' && req.method === 'POST') {
      const body = await readBody(req);
      const link = services.vault.createFillLink({
        label: String(body['label'] ?? 'item'),
        kind: (String(body['kind'] ?? 'password') as 'password'),
        fields: Array.isArray(body['fields']) ? (body['fields'] as string[]) : ['password']
      });
      return json(res, 201, link);
    }

    // ---- wakes, subscriptions, todos, budget ----
    if (path === '/api/wakes') {
      const session = runtime.ensureMainSession();
      return json(res, 200, { wakes: runtime.wakes.list(session.id), subscriptions: runtime.wakes.listSubscriptions(session.id) });
    }
    if (path === '/api/todos') {
      return json(res, 200, { todos: services.runtime.todos.list(runtime.account.id) });
    }
    if (path === '/api/budget') {
      return json(res, 200, services.runtime.budget(runtime.account.id));
    }

    // ---- flags ----
    if (path === '/api/flags' && req.method === 'GET') {
      return json(res, 200, { flags: runtime.flags });
    }
    if (path === '/api/flags' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body['name'] ?? '');
      if (!(name in runtime.flags)) return json(res, 400, { error: 'unknown flag' });
      const enabled = body['enabled'] === true;
      runtime.flags[name] = enabled;
      runtime.db
        .prepare('INSERT INTO flags (account_id, name, enabled) VALUES (?, ?, ?) ON CONFLICT(account_id, name) DO UPDATE SET enabled = excluded.enabled')
        .run(runtime.account.id, name, enabled ? 1 : 0);
      const flags: FlagMap = { ...runtime.flags };
      return json(res, 200, { flags });
    }

    // ---- channels ----
    if (path === '/api/channels' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const only = url.searchParams.get('channel');
      const names = services.channels.list().map((c) => c.name).filter((n) => !only || n === only);
      const messages = names
        .flatMap((name) => services.channels.get(name)?.history(limit) ?? [])
        .sort((a, b) => a.ts - b.ts)
        .slice(-limit);
      return json(res, 200, { channels: services.channels.list().map((c) => c.name), messages });
    }
    if (path === '/api/channels/inbound' && req.method === 'POST') {
      const body = await readBody(req);
      const channelName = String(body['channel'] ?? 'console');
      const channel = services.channels.get(channelName);
      if (!channel) return json(res, 404, { error: 'no such channel' });
      const message = channel.recordInbound({
        channel: channelName,
        from: String(body['from'] ?? runtime.account.phone),
        to: String(body['to'] ?? 'dora'),
        body: String(body['body'] ?? ''),
        threadId: typeof body['thread_id'] === 'string' ? body['thread_id'] : undefined
      });
      let run: unknown = null;
      if (body['run'] === true) {
        run = await runtime.submitUserMessage(message.body, { channel: channelName });
      }
      return json(res, 201, { message, run });
    }

    // ---- subscription event injection (dev/demo helper) ----
    if (path === '/api/events' && req.method === 'POST') {
      const body = await readBody(req);
      const queued = runtime.ingestEvent(String(body['source'] ?? 'gmail'), (body['payload'] as Record<string, unknown>) ?? {});
      return json(res, 202, { queued });
    }

    return json(res, 404, { error: 'no such endpoint: ' + path });
  }

  function serveStatic(res: ServerResponse, root: string, relative: string): void {
    const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
    const full = resolve(root, safe);
    if (!full.startsWith(resolve(root)) || !existsSync(full) || statSync(full).isDirectory()) {
      const fallback = join(root, 'index.html');
      if (existsSync(fallback)) return html(res, 200, readFileSync(fallback, 'utf8'));
      return html(res, 404, '<h1>404</h1><p>Dora admin console is not built.</p>');
    }
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(readFileSync(full));
  }

  return {
    server,
    listen: (port: number, host = '127.0.0.1') =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          const actual = typeof address === 'object' && address ? address.port : port;
          resolve({ port: actual, url: 'http://' + host + ':' + actual });
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function vaultForm(token: string, done: boolean, label?: string, error?: string): string {
  if (done) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Dora vault</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>Stored</h1><p>' +
      (label ? 'Saved "' + escapeHtml(label) + '".' : 'Saved.') +
      '</p><p>You can close this page. Dora can place this value for you and can never read it back.</p></body></html>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><title>Dora vault</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto">' +
    '<h1>Secure entry</h1>' +
    (error ? '<p style="color:#b00">' + escapeHtml(error) + '</p>' : '') +
    '<p>This value is encrypted at rest and is never shown to the agent. It will only be placed into the page you asked for.</p>' +
    '<form method="post"><label>Label<br><input name="label" style="width:100%"></label><p></p>' +
    '<label>Secret value<br><input name="value" type="password" style="width:100%"></label><p></p>' +
    '<button type="submit">Store</button></form>' +
    '<p style="color:#666;font-size:.85rem">One-time link: ' + escapeHtml(token.slice(0, 12)) + '…</p></body></html>';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
