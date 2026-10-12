#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRuntime, type RuntimeBundle } from '@dora/runtime';
import { createApiServer, runDemo } from '@dora/api';
import { benchMain } from '@dora/bench';
import { loggingStatus, readLog } from '@dora/core';
import { toolsCliMain } from '@dora/tools';

/**
 * dora — the product entry point.
 *
 *   dora init            prepare the data directory and seed the account
 *   dora serve           run the runtime + control API + console
 *   dora chat            talk to the main session from the terminal
 *   dora demo            walk every mechanism with pass/fail output
 *   dora tools <...>     the tools CLI, exactly as the agent sees it
 *   dora doctor          environment and capability checks
 */
const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function dataDir(): string {
  return process.env.DORA_DATA_DIR ?? join(homedir(), '.dora');
}

function ensureToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'admin.token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function option(name: string, fallback: string): string {
  const idx = args.indexOf('--' + name);
  return idx === -1 ? fallback : (args[idx + 1] ?? fallback);
}

async function boot(): Promise<RuntimeBundle> {
  const runtime = await createRuntime({ config: { dataDir: dataDir() } });
  return runtime;
}

async function cmdInit(): Promise<number> {
  const dir = dataDir();
  const runtime = await boot();
  console.log('Dora.ai initialised');
  console.log('  data dir   : ' + dir);
  console.log('  database   : ' + runtime.config.dbPath);
  console.log('  account    : ' + runtime.account.handle + ' <' + runtime.account.email + '>');
  console.log('  main session: ' + runtime.ensureMainSession().id);
  console.log('  connectors : ' + runtime.services.connectors.list().filter((c) => runtime.services.connectors.isConnected(c.name)).length + ' connected');
  console.log('  skills     : ' + runtime.services.skills.list().length);
  console.log('  tools      : ' + runtime.registry.list().length + ' actions routed');
  console.log('  admin token: ' + ensureToken(dir) + '  (also in ' + join(dir, 'admin.token') + ')');
  return 0;
}

async function cmdServe(): Promise<number> {
  const port = Number.parseInt(option('port', String(process.env.DORA_PORT ?? 8420)), 10);
  const runtime = await boot();
  await runtime.start();
  const token = ensureToken(dataDir());
  const api = createApiServer({
    runtime,
    adminToken: token,
    webRoot: join(runtime.config.root, 'apps/web'),
    version: '0.1.0'
  });
  const { url, port: actual } = await api.listen(port, option('host', '127.0.0.1'));
  console.log('Dora.ai is running');
  console.log('  console : ' + url + '/?token=' + token);
  console.log('  agent   : ' + url + '/agent?token=' + token + (runtime.flags['agent_chat'] ? '' : '   (flag agent_chat is off)'));
  console.log('  api     : ' + url + '/api/health');
  console.log('  data dir: ' + runtime.config.dataDir);
  console.log('  stop    : ctrl-c');
  const shutdown = async () => {
    console.log('\nshutting down…');
    await api.close();
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => {
    /* run until interrupted */
  });
  return 0;
}

async function cmdChat(): Promise<number> {
  const runtime = await boot();
  await runtime.start();
  const session = runtime.ensureMainSession('console');
  console.log('Dora.ai chat — session ' + session.id + ' (' + runtime.services.model.name + ' provider)');
  console.log('Type a message, or "exit".');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  const unsubscribe = runtime.onEvent((event) => {
    if (event.sessionId !== session.id) return;
    if (event.type === 'tool_call') console.log('  [tool] ' + String(event.data['command']));
    if (event.type === 'tool_result') console.log('  [exit ' + event.data['exit_code'] + ']' + (event.data['attachments'] ? ' attachments=' + JSON.stringify(event.data['attachments']) : ''));
  });
  // A piped stdin (echo "..." | dora chat) closes the interface as soon as the input
  // runs out, so prompting must be guarded or the process dies with ERR_USE_AFTER_CLOSE.
  const prompt = () => {
    if (rl.closed) return;
    try {
      rl.prompt();
    } catch {
      /* the interface closed between the check and the call */
    }
  };
  prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === 'exit' || text === 'quit') break;
    if (text.length > 0) {
      const result = await runtime.submitUserMessage(text, { sessionId: session.id });
      console.log('dora> ' + result.text.trim() + '\n');
    }
    prompt();
  }
  unsubscribe();
  await runtime.stop();
  return 0;
}

async function cmdTools(): Promise<number> {
  // Works exactly like the in-sandbox CLI: socket when a daemon is up, direct otherwise.
  return toolsCliMain(args.slice(1));
}

async function cmdDoctor(): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  push('node >= 22.6 (native TypeScript)', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
  push('node:sqlite available', await hasSqlite(), 'used for events, observations and connector records');
  const seatbelt = existsSync('/usr/bin/sandbox-exec');
  push('seatbelt sandbox available', seatbelt, seatbelt ? '/usr/bin/sandbox-exec present: the memory fence is a kernel rule' : 'missing: the sandbox falls back to a non-isolated runner');
  push('git available', await hasGit(), 'the memory repo is a git repository');
  const runtime = await boot();
  const fence = await fenceCheck(runtime);
  push('memory is read-only from the sandbox', fence.memoryDenied, fence.detail);
  push('vault and database are unreadable from the sandbox', fence.secretDenied, fence.secretDetail);
  push('model provider', runtime.services.model.name !== 'mock' || process.env.DORA_API_KEY === undefined, runtime.services.model.name === 'mock' ? 'mock provider (set DORA_API_KEY and DORA_MODEL_PROVIDER=openai for a live model)' : runtime.services.model.name);
  push('skills loaded', runtime.services.skills.list().length >= 20, runtime.services.skills.list().length + ' skills');
  push('tool surface', runtime.registry.list().length >= 150, runtime.registry.list().length + ' actions routed');
  await runtime.stop();

  console.log('Dora.ai doctor');
  for (const check of checks) console.log((check.ok ? '  ok   ' : '  warn ') + check.name + ' — ' + check.detail);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? '\nall checks passed' : '\n' + failed + ' check(s) need attention');
  return failed === 0 ? 0 : 1;
}

async function hasSqlite(): Promise<boolean> {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

async function hasGit(): Promise<boolean> {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function fenceCheck(runtime: RuntimeBundle): Promise<{ memoryDenied: boolean; secretDenied: boolean; detail: string; secretDetail: string }> {
  const session = runtime.ensureMainSession();
  const memory = await runtime.bash(session.id, 'echo x > memory/probe.md 2>&1; echo rc=$?', { timeoutMs: 15_000 });
  const secret = await runtime.bash(session.id, 'cat ' + runtime.config.dbPath + ' 2>&1; echo', { timeoutMs: 15_000 });
  const memoryDenied = (memory.stdout + memory.stderr).includes('Operation not permitted') || (memory.stdout + memory.stderr).includes('rc=1');
  const secretDenied = (secret.stdout + secret.stderr).includes('Operation not permitted');
  return {
    memoryDenied,
    secretDenied,
    detail: 'write probe: ' + (memory.stdout + memory.stderr).trim().split('\n')[0],
    secretDetail: 'read probe: ' + (secret.stdout + secret.stderr).trim().split('\n')[0]
  };
}

function cmdLogs(): number {
  const level = option('level', 'info') as 'debug' | 'info' | 'warn' | 'error';
  const session = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;
  const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined;
  const limit = Number.parseInt(option('limit', '60'), 10);
  const records = readLog({ dir: join(dataDir(), 'logs'), level, session, channel, limit });
  const status = loggingStatus();
  console.error('log dir: ' + (status.dir ?? '(unset)') + '  level: ' + status.level + '  files: ' + status.files.length);
  for (const record of records) {
    const extra = Object.entries(record)
      .filter(([k]) => !['ts', 'level', 'channel', 'msg'].includes(k))
      .map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 90))
      .join(' ');
    console.log(record.ts.slice(11, 23) + ' ' + record.level.padEnd(5) + ' ' + String(record.channel).padEnd(14) + ' ' + record.msg + (extra ? '  ' + extra : ''));
  }
  return 0;
}

function usage(): void {
  console.log(`dora <command>

  init                 prepare the data directory, seed the account, print the admin token
  serve [--port N]     run the runtime, the control API and the console
  chat                 talk to the main session in the terminal
  demo                 walk every mechanism with pass/fail output
  tools <args...>      the tools CLI, exactly as the agent sees it
  bench [--only id,id] [--difficulty easy|medium|hard|extreme] [--list]
                       run the task suite against the live model and write a report
  logs [--level error] [--channel model] [--session id] [--limit N]
                       read the structured server log
  doctor               environment and capability checks

Environment: DORA_DATA_DIR, DORA_MODEL_PROVIDER=openai, DORA_API_KEY, DORA_BASE_URL,
DORA_MODEL_MAIN, DORA_MODEL_FAST, DORA_MODEL_SMART, DORA_OFFLINE=1, DORA_LOG_LEVEL`);
}

async function main(): Promise<number> {
  switch (command) {
    case 'init':
      return cmdInit();
    case 'serve':
      return cmdServe();
    case 'chat':
      return cmdChat();
    case 'demo':
      return (await runDemo({ dataDir: option('data-dir', join(process.cwd(), 'var', 'demo')) })).ok ? 0 : 1;
    case 'tools':
      return cmdTools();
    case 'bench':
      return benchMain(args.slice(1));
    case 'logs':
      return cmdLogs();
    case 'doctor':
      return cmdDoctor();
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      console.error('unknown command: ' + command);
      usage();
      return 64;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
