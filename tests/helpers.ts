import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeBundle } from '@dora/runtime';
import { executeArgv, type ExecuteOutput } from '@dora/tools';

/** Every test gets its own data directory so runs never share state. */
export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), 'dora-' + label + '-'));
}

export interface Harness {
  runtime: RuntimeBundle;
  dir: string;
  invoke(argv: string[], sessionId?: string): Promise<ExecuteOutput>;
  /** What an agent does: read the contract, then call. */
  run(argv: string[], sessionId?: string): Promise<ExecuteOutput>;
  bash(command: string, sessionId?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  dispose(): Promise<void>;
}

export async function harness(label: string, options: { seed?: boolean } = {}): Promise<Harness> {
  // Tests are deterministic and offline: they never spend a live model call.
  process.env.DORA_MODEL_PROVIDER = 'mock';
  process.env.DORA_LOG_ECHO = '0';
  const dir = makeTempDir(label);
  const runtime = await createRuntime({ config: { dataDir: dir }, offlineSearch: true, seed: options.seed ?? true });
  await runtime.start();
  const contractsRead = new Set<string>();

  const invoke = async (argv: string[], sessionId?: string): Promise<ExecuteOutput> => {
    const session = sessionId ? runtime.store.get(sessionId)! : runtime.ensureMainSession();
    return executeArgv({
      argv,
      session,
      account: runtime.account,
      flags: runtime.flags,
      services: runtime.services,
      config: runtime.config,
      db: runtime.db,
      registry: runtime.registry
    });
  };

  const run = async (argv: string[], sessionId?: string): Promise<ExecuteOutput> => {
    const session = sessionId ? runtime.store.get(sessionId)! : runtime.ensureMainSession();
    const path = resolvePath(runtime, argv);
    if (path && !contractsRead.has(session.id + ':' + path)) {
      await invoke(['help', path], session.id);
      contractsRead.add(session.id + ':' + path);
    }
    return invoke(argv, session.id);
  };

  const bash = async (command: string, sessionId?: string) => {
    const session = sessionId ? runtime.store.get(sessionId)! : runtime.ensureMainSession();
    return runtime.bash(session.id, command, { timeoutMs: 20_000 });
  };

  return {
    runtime,
    dir,
    invoke,
    run,
    bash,
    dispose: async () => {
      await runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function resolvePath(runtime: RuntimeBundle, argv: string[]): string | null {
  const first = argv[0];
  if (!first || first === 'help' || first === 'async') return null;
  if (first.includes('.')) return runtime.registry.get(first) ? first : null;
  if (argv[1] && !argv[1].startsWith('--')) {
    const two = first + '.' + argv[1];
    if (runtime.registry.get(two)) return two;
  }
  return runtime.registry.get(first) ? first : null;
}
