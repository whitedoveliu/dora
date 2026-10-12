import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  DEFAULT_PORT, MAX_BODY_BYTES, createRouter, createState, sendMethodNotAllowed, sendNotFound, splitPath, safeDecode,
  type Ctx, type MockWebState, type Router
} from './server.ts';
import { registerRestaurant } from './sites/restaurant.ts';
import { registerShop } from './sites/shop.ts';
import { registerFlights } from './sites/flights.ts';

/**
 * The mock web environment.
 *
 * Three deterministic sites (restaurant, shop, flights) that the agent under test drives
 * through the rented-browser path. Everything is inert HTML — no JavaScript, no external
 * calls — so a browser task is reproducible and a failure is the agent's, not the site's.
 */
export interface MockWebHandle {
  url: string;
  port: number;
  state: MockWebState;
  close(): Promise<void>;
}

export interface MockWebOptions {
  port?: number;
  host?: string;
  /** Set false in tests that do not want request logs on stdout. */
  log?: boolean;
  now?: () => number;
}

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(new URLSearchParams());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

export function createMockWeb(options: MockWebOptions = {}): { server: Server; state: MockWebState; router: Router; now: () => number } {
  const router = createRouter();
  const state = createState();
  const now = options.now ?? Date.now;
  registerRestaurant(router, state);
  registerShop(router, state);
  registerFlights(router, state);

  const log = options.log ?? true;
  const server = createServer((req, res) => {
    const started = now();
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      const pathname = safeDecode(url.pathname);
      const body = method === 'POST' ? await readBody(req) : new URLSearchParams();
      const fields = new URLSearchParams(url.searchParams);
      for (const [k, v] of body) fields.set(k, v);
      const ctx: Ctx = { req, res, method, pathname, url, params: {}, query: url.searchParams, body, fields };

      const matched = router.match(method === 'HEAD' ? 'GET' : method, pathname);
      if (matched.kind === 'match') {
        ctx.params = matched.params;
        try {
          await matched.handler(ctx);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<h1>500</h1><p>mock site error</p>');
          }
          if (log) process.stdout.write(JSON.stringify({ ts: now(), method, path: pathname, status: 500, ms: now() - started, error: err instanceof Error ? err.message : String(err) }) + '\n');
          return;
        }
      } else if (matched.kind === 'method') {
        sendMethodNotAllowed(res, matched.allowed);
      } else {
        sendNotFound(res, pathname);
      }

      if (log) {
        process.stdout.write(JSON.stringify({ ts: now(), method, path: pathname, status: res.statusCode, ms: now() - started, ua: String(req.headers['user-agent'] ?? '').slice(0, 40) }) + '\n');
      }
    })();
  });

  return { server, state, router, now };
}

export async function startMockWeb(options: MockWebOptions = {}): Promise<MockWebHandle> {
  const port = options.port ?? Number.parseInt(process.env.MOCKWEB_PORT ?? String(DEFAULT_PORT), 10);
  const host = options.host ?? '127.0.0.1';
  const { server, state } = createMockWeb(options);
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  return {
    url: 'http://' + host + ':' + actual,
    port: actual,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

export { DEFAULT_PORT };
export * from './server.ts';

const entry = process.argv[1] ?? '';
if (entry.endsWith('index.ts') || entry.endsWith('mockweb.mjs')) {
  const handle = await startMockWeb();
  process.stdout.write('mock web listening on ' + handle.url + '\n');
  process.stdout.write('  ' + handle.url + '/restaurant\n  ' + handle.url + '/shop\n  ' + handle.url + '/flights\n');
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
