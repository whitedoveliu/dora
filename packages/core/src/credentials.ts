import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Model credential discovery.
 *
 * A key the machine already has beats asking the operator to paste one, but the runtime
 * should not guess where that key lives. Order of precedence:
 *
 *   1. DORA_API_KEY / DEEPSEEK_API_KEY in the environment
 *   2. every file listed in DORA_CREDENTIAL_FILES (colon-separated, `~/` expanded)
 *   3. ~/.config/dora/credentials.json
 *
 * Each file is read as whichever of these shapes it looks like:
 *   - JSON: {"apiKey": "…", "baseUrl": "…"} or {"<provider>": {"key": "…"}}
 *   - an env-style file with an `*_API_KEY="…"` line
 *   - YAML with a `refs:` section holding an `*_API_KEY` entry
 *
 * A secret is never logged: callers log `fingerprint()` instead.
 */
export interface CredentialHit {
  apiKey: string;
  source: string;
  baseUrl: string;
}

export interface CredentialProbe {
  hit: CredentialHit | null;
  considered: { source: string; found: boolean; detail: string }[];
}

export function fingerprint(secret: string): string {
  if (!secret) return '(none)';
  if (secret.length <= 8) return '…(' + secret.length + ' chars)';
  return secret.slice(0, 4) + '…' + secret.slice(-3) + '(' + secret.length + ' chars)';
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Credential files to try, in order: the operator's list, then the neutral default. */
export function credentialFiles(home: string): string[] {
  const listed = (process.env['DORA_CREDENTIAL_FILES'] ?? '')
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith('~/') ? join(home, p.slice(2)) : p));
  return [...listed, join(home, '.config', 'dora', 'credentials.json')];
}

/** Parse the `refs:` section of a small YAML file: indented `NAME: value` lines. */
function readYamlRefs(path: string): Record<string, string> {
  const refs: Record<string, string> = {};
  let inRefs = false;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (/^[a-zA-Z]/.test(line)) {
      inRefs = false;
      continue;
    }
    if (!inRefs) continue;
    const m = /^\s+([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (m) refs[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return refs;
}

/** Read one credential file in whichever of the three shapes it uses. */
function readKeyFromFile(path: string): { key: string; baseUrl?: string; shape: string } | null {
  if (!existsSync(path)) return null;

  const json = readJson(path);
  if (json) {
    const direct = json['apiKey'];
    if (typeof direct === 'string' && direct.length > 0) {
      const baseUrl = typeof json['baseUrl'] === 'string' ? (json['baseUrl'] as string) : undefined;
      return { key: direct, baseUrl, shape: 'json apiKey' };
    }
    for (const value of Object.values(json)) {
      if (value !== null && typeof value === 'object') {
        const key = (value as Record<string, unknown>)['key'];
        if (typeof key === 'string' && key.length > 0) return { key, shape: 'json provider key' };
      }
    }
  }

  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]*API_KEY)\s*=\s*["']?([^"'\s]+)["']?/.exec(line);
    if (m) return { key: m[2].trim(), shape: 'env-style line' };
  }

  try {
    const refs = readYamlRefs(path);
    const entry = Object.entries(refs).find(([name, value]) => name.endsWith('API_KEY') && value.length > 0);
    if (entry) return { key: entry[1], shape: 'yaml refs' };
  } catch {
    /* not a YAML file either */
  }
  return null;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

export function probeCredentials(options: { home?: string; baseUrl?: string } = {}): CredentialProbe {
  const home = options.home ?? homedir();
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const considered: CredentialProbe['considered'] = [];

  const fromEnv = process.env.DORA_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';
  considered.push({ source: 'environment', found: fromEnv.length > 0, detail: fingerprint(fromEnv) });
  if (fromEnv) return { hit: { apiKey: fromEnv, source: 'environment', baseUrl }, considered };

  for (const path of credentialFiles(home)) {
    const found = readKeyFromFile(path);
    considered.push({
      source: found ? path + ' (' + found.shape + ')' : path,
      found: found !== null,
      detail: found ? fingerprint(found.key) : '(absent)'
    });
    if (found) return { hit: { apiKey: found.key, source: path, baseUrl: found.baseUrl ?? baseUrl }, considered };
  }

  return { hit: null, considered };
}

/** Verify a key against the provider and list the models it can see. */
export async function probeModelAccess(
  hit: CredentialHit,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ ok: boolean; models: { id: string; name: string; contextWindow: number | null }[]; error: string | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetchImpl(hit.baseUrl.replace(/\/$/, '') + '/models', {
      headers: { authorization: 'Bearer ' + hit.apiKey },
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, models: [], error: 'HTTP ' + response.status + ' ' + (await response.text()).slice(0, 200) };
    const payload = (await response.json()) as { data?: { id?: string; name?: string; context_window?: number }[] };
    const models = (payload.data ?? []).map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? ''), contextWindow: m.context_window ?? null }));
    return { ok: models.length > 0, models, error: null };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
