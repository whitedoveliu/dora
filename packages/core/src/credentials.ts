import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Model credential discovery.
 *
 * The runtime must work on a machine that already has a model configured (this one has
 * both a local credential store), without asking the operator to copy a
 * key into an env var. Order of precedence:
 *
 *   1. DORA_API_KEY / DEEPSEEK_API_KEY in the environment
 *   2. ~/.config/dora/credentials.json          (a provider store)
 *   3. ~/.config/dora/credentials.env          (KEY="value" lines)
 *   4. ~/.config/dora/credentials.yaml       (a credential store, refs section)
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

/** Parse the tiny subset of YAML the credential store uses. */
function readCredentialYaml(path: string): { refs: Record<string, string>; records: Record<string, Record<string, string>> } {
  const out: { refs: Record<string, string>; records: Record<string, Record<string, string>> } = { refs: {}, records: {} };
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, 'utf8').split('\n');
  let section = '';
  let recordName = '';
  let recordField = '';
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^refs:\s*$/.test(line)) {
      section = 'refs';
      continue;
    }
    if (/^records:\s*$/.test(line)) {
      section = 'records';
      continue;
    }
    if (/^[a-zA-Z]/.test(line)) {
      section = '';
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (section === 'refs') {
      const m = /^\s+([A-Z0-9_]+):\s*(.*)$/.exec(line);
      if (m) out.refs[m[1]] = m[2].replace(/^["']|["']$/g, '');
      continue;
    }
    if (section === 'records') {
      if (indent === 2) {
        const m = /^\s{2}([^:]+):\s*$/.exec(line);
        if (m) {
          recordName = m[1].trim();
          out.records[recordName] = out.records[recordName] ?? {};
        }
        continue;
      }
      if (indent >= 6 && recordName) {
        const m = /^\s+([a-zA-Z_]+):\s*(.*)$/.exec(line);
        if (m) {
          const value = m[2].replace(/^["']|["']$/g, '');
          if (value !== '') {
            out.records[recordName][m[1]] = value;
            recordField = m[1];
          } else {
            recordField = m[1];
          }
        } else if (recordField) {
          const cont = line.trim().replace(/^["']|["']$/g, '');
          if (cont) out.records[recordName][recordField] = (out.records[recordName][recordField] ?? '') + cont;
        }
      }
    }
  }
  return out;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

export function probeCredentials(options: { home?: string; baseUrl?: string } = {}): CredentialProbe {
  const home = options.home ?? homedir();
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const considered: CredentialProbe['considered'] = [];

  const fromEnv = process.env.DORA_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';
  considered.push({ source: 'environment', found: fromEnv.length > 0, detail: fingerprint(fromEnv) });
  if (fromEnv) return { hit: { apiKey: fromEnv, source: 'environment', baseUrl }, considered };

  const authPath = join(home, '.config/dora/credentials.json');
  const auth = readJson(authPath);
  const deepseekAuth = auth && typeof auth['deepseek'] === 'object' ? (auth['deepseek'] as Record<string, unknown>) : null;
  const piKey = deepseekAuth && typeof deepseekAuth['key'] === 'string' ? (deepseekAuth['key'] as string) : '';
  considered.push({ source: authPath, found: piKey.length > 0, detail: fingerprint(piKey) });
  if (piKey) return { hit: { apiKey: piKey, source: authPath, baseUrl }, considered };

  const envPath = join(home, '.config/dora/credentials.env');
  let envKey = '';
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]*API_KEY)\s*=\s*["']?([^"']+)["']?/.exec(line);
      if (m) {
        envKey = m[2].trim();
        break;
      }
    }
  }
  considered.push({ source: envPath, found: envKey.length > 0, detail: fingerprint(envKey) });
  if (envKey) return { hit: { apiKey: envKey, source: envPath, baseUrl }, considered };

  const credPath = join(home, '.config/dora/credentials.yaml');
  const creds = readCredentialYaml(credPath);
  const refKey = creds.refs['DEEPSEEK_API_KEY'] ?? '';
  const looksLikeKey = refKey.startsWith('sk-');
  considered.push({
    source: credPath + ' (refs.DEEPSEEK_API_KEY)',
    found: looksLikeKey,
    detail: looksLikeKey ? fingerprint(refKey) : refKey ? 'indirection: ' + refKey.slice(0, 40) : '(absent)'
  });
  if (looksLikeKey) return { hit: { apiKey: refKey, source: credPath, baseUrl }, considered };

  const record = creds.records['deepseek-account-platform/default'];
  const token = record && typeof record['token'] === 'string' ? record['token'] : '';
  considered.push({
    source: credPath + ' (records.deepseek-account-platform/default)',
    found: token.length > 0,
    detail: token ? 'account session token, not an API key' : '(absent)'
  });

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
