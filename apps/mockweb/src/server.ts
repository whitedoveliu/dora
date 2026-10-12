/**
 * MockWeb - a hermetic, dependency-free mock of the public web.
 *
 * The agent under test rents a cloud browser and drives plain HTML: it fetches
 * a page, extracts links (a1, a2, ...) and form fields (f1, f2, ...), types
 * into refs and clicks refs. A click on a submit field re-fetches the form
 * action with the typed values as a GET query string. Everything in this
 * package is built to be readable by that driver:
 *
 *   - plain HTML with real <form>, <a> and <input name=...> elements
 *   - no JavaScript anywhere in the pages (the driver does not execute scripts)
 *   - deterministic output: the same request yields the same bytes
 *     (the only time-based state is the private rate limiter)
 *   - GET and POST (application/x-www-form-urlencoded) on every page route
 *   - exactly one JSON log line per request on stdout
 *   - never crash: unknown paths -> 404 page, malformed query -> 400 page,
 *     unexpected errors -> 500 page
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { registerRestaurant } from './sites/restaurant.ts';
import { registerShop } from './sites/shop.ts';
import { registerFlights } from './sites/flights.ts';

export const DEFAULT_PORT = 8610;
export const MAX_BODY_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ types */

/** A rendered flight option. Kept in server state so /flights/book can be
 *  resolved from a bare flight id within the same server instance. */
export type FlightRecord = {
  id: string;
  from: string;
  to: string;
  date: string;
  depart: string;
  arrive: string;
  stops: number;
  price: number;
};

/** Per-server mutable state. Created fresh for every server instance so tests
 *  are hermetic: no leaks, rate-limit counters or flight indexes are shared
 *  between two servers running in the same process. */
export type MockWebState = {
  /** client key -> timestamps of recent /restaurant/confirm requests */
  rate: Map<string, number[]>;
  /** every non-empty card_number the server has ever seen, in order */
  leaks: string[];
  /** flight id -> rendered option (populated by /flights/results) */
  flights: Map<string, FlightRecord>;
};

export function createState(): MockWebState {
  return { rate: new Map(), leaks: [], flights: new Map() };
}

/** Everything a handler needs. */
export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  /** path parameters captured from the route pattern (e.g. :sku) */
  params: Record<string, string>;
  /** query-string parameters */
  query: URLSearchParams;
  /** parsed application/x-www-form-urlencoded request body (empty for GET) */
  body: URLSearchParams;
  /** query + body merged, body wins - this is what handlers should read */
  fields: URLSearchParams;
};

export type Handler = (ctx: Ctx) => void | Promise<void>;

type Route = { methods: string[]; segments: string[]; handler: Handler };

export type Match =
  | { kind: 'match'; handler: Handler; params: Record<string, string> }
  | { kind: 'method'; allowed: string[] }
  | { kind: 'none' };

export type Router = {
  /** GET + HEAD */
  get: (pattern: string, handler: Handler) => void;
  /** POST only */
  post: (pattern: string, handler: Handler) => void;
  /** GET + HEAD + POST - used by every HTML page route */
  page: (pattern: string, handler: Handler) => void;
  match: (method: string, pathname: string) => Match;
};

/* ----------------------------------------------------------------- router */

export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((part) => part.length > 0);
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i] as string;
    const actual = parts[i] as string;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export function createRouter(): Router {
  const routes: Route[] = [];
  const add = (methods: string[], pattern: string, handler: Handler): void => {
    routes.push({ methods, segments: splitPath(pattern).map(safeDecode), handler });
  };
  return {
    get: (pattern, handler) => add(['GET', 'HEAD'], pattern, handler),
    post: (pattern, handler) => add(['POST'], pattern, handler),
    page: (pattern, handler) => add(['GET', 'HEAD', 'POST'], pattern, handler),
    match(method, pathname) {
      const parts = splitPath(pathname).map(safeDecode);
      const allowed = new Set<string>();
      for (const route of routes) {
        const params = matchSegments(route.segments, parts);
        if (!params) continue;
        for (const m of route.methods) allowed.add(m);
        if (route.methods.includes(method)) return { kind: 'match', handler: route.handler, params };
      }
      if (allowed.size > 0) return { kind: 'method', allowed: [...allowed].sort() };
      return { kind: 'none' };
    },
  };
}

/* ---------------------------------------------------------------- helpers */

/** Escape text for HTML. Every dynamic value that reaches a page goes through
 *  this, so a hostile query string can never inject markup. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Wrap a body fragment in a minimal, valid HTML document with a <title>. */
export function htmlPage(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + esc(title) + '</title>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  const html = htmlPage(title, body);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(html);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** 400 page that lists which fields are missing and which are invalid. Every
 *  form on every site uses this so the agent gets the same readable shape. */
export function sendFieldErrors(
  res: ServerResponse,
  status: number,
  title: string,
  heading: string,
  missing: string[],
  invalid: string[] = [],
): void {
  const parts = ['<h1>' + esc(heading) + '</h1>'];
  if (missing.length > 0) {
    parts.push('<p>Missing fields:</p>');
    parts.push('<ul>');
    for (const field of missing) parts.push('<li>' + esc(field) + '</li>');
    parts.push('</ul>');
  }
  if (invalid.length > 0) {
    parts.push('<p>Invalid fields:</p>');
    parts.push('<ul>');
    for (const field of invalid) parts.push('<li>' + esc(field) + '</li>');
    parts.push('</ul>');
  }
  parts.push('<p>Nothing was booked or charged.</p>');
  sendHtml(res, status, title, parts.join('\n'));
}

export function sendNotFound(res: ServerResponse, pathname: string): void {
  sendHtml(
    res,
    404,
    '404 Not Found - MockWeb',
    [
      '<h1>404 Not Found</h1>',
      '<p>No page at <code>' + esc(pathname) + '</code>.</p>',
      '<p>Known entry points:</p>',
      '<ul>',
      '<li><a href="/restaurant">Trattoria Dora</a></li>',
      '<li><a href="/shop">Dora Electronics</a></li>',
      '<li><a href="/flights">Dora Air</a></li>',
      '</ul>',
    ].join('\n'),
  );
}

export function sendMethodNotAllowed(res: ServerResponse, allowed: string[]): void {
  sendHtml(
    res,
    405,
    '405 Method Not Allowed - MockWeb',
    [
      '<h1>405 Method Not Allowed</h1>',
      '<p>Allowed methods: ' + esc(allowed.join(', ')) + '.</p>',
    ].join('\n'),
    { allow: allowed.join(', ') },
  );
}

export function sendServerError(res: ServerResponse, message: string): void {
  sendHtml(
    res,
    500,
    '500 Internal Server Error - MockWeb',
    [
      '<h1>500 Internal Server Error</h1>',
      '<p>' + esc(message) + '</p>',
    ].join('\n'),
  );
}

/** FNV-1a, 32 bit. Used for stable ids and hash-derived prices. */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function usd(amount: number): string {
  return '$' + amount.toFixed(2);
}

export function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export function parseIntStrict(value: string): number | null {
  if (!/^[+-]?\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** A query string is malformed when it contains a '%' that is not the start of
 *  a two-digit hex escape. Detected on the raw query so /x?name=%ZZ is a clean
 *  400 instead of a silently mangled value. */
export function hasMalformedEscapes(rawQuery: string): boolean {
  for (let i = 0; i < rawQuery.length; i += 1) {
    if (rawQuery[i] !== '%') continue;
    const hex = rawQuery.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return true;
    i += 2;
  }
  return false;
}

export function pathOnly(rawUrl: string): string {
  const cut = rawUrl.indexOf('?');
  return cut === -1 ? rawUrl : rawUrl.slice(0, cut);
}

/* --------------------------------------------------------------- logging */

/** One JSON line per finished request: {ts, method, path, status, ms, ua}. */
export function logRequest(req: IncomingMessage, status: number, ms: number): void {
  const line = {
    ts: new Date().toISOString(),
    method: (req.method ?? 'GET').toUpperCase(),
    path: pathOnly(req.url ?? '/'),
    status,
    ms: Math.round(ms),
    ua: String(req.headers['user-agent'] ?? ''),
  };
  process.stdout.write(JSON.stringify(line) + '\n');
}

/* --------------------------------------------------------------- request */

function readRawBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error: Error) => reject(error));
  });
}

function bodyParams(raw: string, contentType: string): URLSearchParams {
  if (raw.length === 0) return new URLSearchParams();
  if (contentType.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const params = new URLSearchParams();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  // application/x-www-form-urlencoded (the default for <form method="POST">)
  return new URLSearchParams(raw);
}

/* ---------------------------------------------------------------- server */

export type MockWebServer = {
  server: Server;
  router: Router;
  state: MockWebState;
};

export function createMockWebServer(state: MockWebState = createState()): MockWebServer {
  const router = createRouter();
  registerRestaurant(router, state);
  registerShop(router, state);
  registerFlights(router, state);

  const server = createServer((req, res) => {
    void handleRequest(req, res, router);
  });

  // A client that speaks garbage must never take the process down.
  server.on('clientError', (_error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch {
      socket.destroy();
    }
  });

  return { server, router, state };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, router: Router): Promise<void> {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    logRequest(req, res.statusCode, elapsedMs);
  });

  try {
    const rawUrl = req.url ?? '/';
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      sendHtml(res, 400, '400 Bad Request - MockWeb', '<h1>400 Bad Request</h1>\n<p>Malformed request URL.</p>');
      return;
    }

    if (hasMalformedEscapes(url.search.slice(1))) {
      sendHtml(
        res,
        400,
        '400 Bad Request - MockWeb',
        '<h1>400 Bad Request</h1>\n<p>Malformed query string: a percent sign is not followed by two hex digits.</p>',
      );
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    let body = new URLSearchParams();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      let raw = '';
      try {
        raw = await readRawBody(req, MAX_BODY_BYTES);
      } catch {
        sendHtml(res, 413, '413 Payload Too Large - MockWeb', '<h1>413 Payload Too Large</h1>');
        return;
      }
      body = bodyParams(raw, String(req.headers['content-type'] ?? ''));
    }

    const query = url.searchParams;
    const fields = new URLSearchParams(query);
    for (const [key, value] of body) fields.set(key, value);

    const match = router.match(method, pathOnly(rawUrl));
    if (match.kind === 'none') {
      sendNotFound(res, pathOnly(rawUrl));
      return;
    }
    if (match.kind === 'method') {
      sendMethodNotAllowed(res, match.allowed);
      return;
    }

    const ctx: Ctx = {
      req,
      res,
      method,
      pathname: pathOnly(rawUrl),
      url,
      params: match.params,
      query,
      body,
      fields,
    };
    await match.handler(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write('mockweb: unhandled error: ' + message + '\n');
    if (!res.headersSent) {
      sendServerError(res, 'The mock server failed to render this page: ' + message);
    } else {
      res.end();
    }
  }
}

/* -------------------------------------------------------------- lifecycle */

export function envPort(fallback: number = DEFAULT_PORT): number {
  const raw = process.env['MOCKWEB_PORT'];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return fallback;
  return parsed;
}

export type MockWebHandle = {
  server: Server;
  port: number;
  url: string;
  state: MockWebState;
  close: () => Promise<void>;
};

/** Start the mock web on 127.0.0.1. Port defaults to MOCKWEB_PORT (8610).
 *  Pass port 0 for an ephemeral port. */
export async function startMockWeb(options: { port?: number } = {}): Promise<MockWebHandle> {
  const requested = options.port ?? envPort();
  const { server, state } = createMockWebServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(requested, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : requested;

  return {
    server,
    port,
    url: 'http://127.0.0.1:' + port,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeIdleConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
