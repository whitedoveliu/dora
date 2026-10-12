import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeCredentials, type CredentialHit } from './credentials.ts';

export interface ModelConfig {
  provider: 'mock' | 'openai';
  baseUrl: string;
  apiKey: string;
  credentialSource: string;
  main: string;
  fast: string;
  smart: string;
  maxTurns: number;
  contextBudgetTokens: number;
  /** Input tokens one run may spend before it is ended with an explicit event. */
  runInputTokenBudget: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface DoraConfig {
  root: string;
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
  socketPath: string;
  logDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logRetentionDays: number;
  bashTimeoutMs: number;
  helpBatchLimit: number;
  attachmentLimits: { maxFiles: number; maxBytes: number };
  observations: { timeoutMs: number; maxRows: number };
  outputBudgetTokens: number;
  memoryPromoteLines: number;
  model: ModelConfig;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Repo root = the directory that owns package.json (4 levels up from packages/core/src). */
export function repoRoot(): string {
  const here = new URL('../../../', import.meta.url).pathname;
  return resolve(decodeURIComponent(here));
}

/**
 * Which model backend to use. `DORA_MODEL_PROVIDER` wins; otherwise the runtime looks for
 * a credential the machine already has (an env var or a credentials file) and only falls back to the offline
 * mock when there is none.
 */
export function resolveModelBackend(): { provider: 'mock' | 'openai'; hit: CredentialHit | null; considered: { source: string; found: boolean; detail: string }[] } {
  const explicit = process.env.DORA_MODEL_PROVIDER;
  const probe = probeCredentials({ baseUrl: env('DORA_BASE_URL', 'https://api.deepseek.com/v1') });
  if (explicit === 'mock') return { provider: 'mock', hit: null, considered: probe.considered };
  if (explicit === 'openai') return { provider: 'openai', hit: probe.hit, considered: probe.considered };
  return { provider: probe.hit ? 'openai' : 'mock', hit: probe.hit, considered: probe.considered };
}

export function loadConfig(overrides: Partial<DoraConfig> = {}): DoraConfig {
  const root = resolve(overrides.root ?? repoRoot());
  // Every path is absolute: a relative data dir broke the memory repo's root guard and
  // produced workspace symlinks pointing outside the sandbox.
  const dataDir = resolve(overrides.dataDir ?? env('DORA_DATA_DIR', join(homedir(), '.dora')));
  const backend = resolveModelBackend();
  const base: DoraConfig = {
    root,
    dataDir,
    dbPath: join(dataDir, 'dora.db'),
    workspaceRoot: join(dataDir, 'workspaces'),
    socketPath: join(dataDir, 'run', 'tools.sock'),
    logDir: env('DORA_LOG_DIR', join(dataDir, 'logs')),
    logLevel: env('DORA_LOG_LEVEL', 'info') as DoraConfig['logLevel'],
    logRetentionDays: intEnv('DORA_LOG_RETENTION_DAYS', 14),
    bashTimeoutMs: intEnv('DORA_BASH_TIMEOUT_MS', 45_000),
    helpBatchLimit: intEnv('DORA_HELP_BATCH_LIMIT', 8),
    attachmentLimits: { maxFiles: 5, maxBytes: 20 * 1024 * 1024 },
    observations: { timeoutMs: 3_000, maxRows: 10_000 },
    outputBudgetTokens: intEnv('DORA_OUTPUT_BUDGET_TOKENS', 10_000),
    memoryPromoteLines: 150,
    model: {
      provider: backend.provider,
      baseUrl: env('DORA_BASE_URL', 'https://api.deepseek.com/v1'),
      apiKey: backend.hit?.apiKey ?? '',
      credentialSource: backend.hit?.source ?? '(none)',
      main: env('DORA_MODEL_MAIN', 'deepseek-v4-pro'),
      fast: env('DORA_MODEL_FAST', 'deepseek-flash'),
      smart: env('DORA_MODEL_SMART', 'deepseek-v4-pro'),
      maxTurns: intEnv('DORA_MAX_TURNS', 40),
      contextBudgetTokens: intEnv('DORA_CONTEXT_BUDGET', 120_000),
      runInputTokenBudget: intEnv('DORA_RUN_TOKEN_BUDGET', 600_000),
      maxOutputTokens: intEnv('DORA_MAX_OUTPUT_TOKENS', 8_192),
      requestTimeoutMs: intEnv('DORA_MODEL_TIMEOUT_MS', 180_000),
      maxRetries: intEnv('DORA_MODEL_RETRIES', 3)
    }
  };
  const merged: DoraConfig = { ...base, ...overrides, model: { ...base.model, ...(overrides.model ?? {}) } };
  return {
    ...merged,
    root,
    dataDir,
    dbPath: resolve(merged.dbPath),
    workspaceRoot: resolve(merged.workspaceRoot),
    socketPath: resolve(merged.socketPath),
    logDir: resolve(merged.logDir)
  };
}
