import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Execution-layer adapter.
 *
 * A sandbox keeps the workspace semantics the runtime depends on: the read-only
 * /memory /skills /observations /downloads roots sit alongside a writable work
 * directory, so an agent's paths mean the same thing regardless of how the command is
 * executed. This module ships the local process adapter, which keeps those semantics
 * and the guarantees that matter:
 *   - a real shell with a real filesystem;
 *   - a write fence and a read fence implemented by the host kernel, not by a
 *     string filter;
 *   - wall-clock, CPU and output limits;
 *   - one workspace per agent session.
 * A hosted sandbox means implementing this same interface.
 */

export interface ExecSpec {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
  /** Sandbox profile inputs: what may be written and read. */
  fs: FsPolicy;
  maxOutputBytes?: number;
  network?: boolean;
}

export interface FsPolicy {
  /** Writable roots (the workspace). */
  writable: string[];
  /** Read-only roots that must stay readable (memory, skills). */
  readable: string[];
  /** Roots the agent must never read (the database, other workspaces, the vault). */
  hidden: string[];
  /**
   * Unix sockets the sandbox may connect to. Exactly one: the tools CLI socket for this
   * session. Everything else in the runtime directory stays hidden.
   */
  ipc?: string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  isolation: 'sandbox-exec' | 'none';
}

export interface SandboxAdapter {
  readonly name: string;
  readonly isolation: 'sandbox-exec' | 'none' | 'microvm';
  exec(spec: ExecSpec): Promise<ExecResult>;
  dispose(): Promise<void>;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/** Sandbox capability of this host: macOS seatbelt, or nothing at all. */
export function hostIsolation(): 'sandbox-exec' | 'none' {
  return existsSync('/usr/bin/sandbox-exec') ? 'sandbox-exec' : 'none';
}

/** Escape hatch for hosts without seatbelt; unisolated runs must be asked for by name. */
const ALLOW_UNSANDBOXED = /^(1|true|yes)$/i.test(process.env['DORA_ALLOW_UNSANDBOXED'] ?? '');

const UNSANDBOXED_REFUSAL =
  'the host has no sandbox (no /usr/bin/sandbox-exec), so this command was not run.\n' +
  'Set DORA_ALLOW_UNSANDBOXED=1 to run commands unconfined on a host you trust.\n';

export class LocalSandboxAdapter implements SandboxAdapter {
  readonly name = 'local';
  readonly isolation: 'sandbox-exec' | 'none';
  private readonly profileBuilder: (fs: FsPolicy, cwd: string, network: boolean) => string | null;
  private readonly requireIsolation: boolean;

  constructor(options: {
    profileBuilder: (fs: FsPolicy, cwd: string, network: boolean) => string | null;
    isolation?: 'sandbox-exec' | 'none';
    requireIsolation?: boolean;
  }) {
    this.profileBuilder = options.profileBuilder;
    this.isolation = options.isolation ?? hostIsolation();
    this.requireIsolation = options.requireIsolation ?? !ALLOW_UNSANDBOXED;
  }

  async exec(spec: ExecSpec): Promise<ExecResult> {
    if (this.isolation !== 'sandbox-exec' && this.requireIsolation) {
      // Fail closed: an unisolated host must opt in explicitly, never by accident.
      return {
        stdout: '',
        stderr: UNSANDBOXED_REFUSAL,
        exitCode: 126,
        signal: null,
        timedOut: false,
        durationMs: 0,
        truncated: false,
        isolation: 'none'
      };
    }
    const started = Date.now();
    const maxBytes = spec.maxOutputBytes ?? MAX_CAPTURE;
    const profile = this.isolation === 'sandbox-exec' ? this.profileBuilder(spec.fs, spec.cwd, spec.network ?? true) : null;

    const script = [
      'ulimit -t 30 2>/dev/null || true',
      'ulimit -f 262144 2>/dev/null || true',
      'exec "$0" "$@"'
    ].join('; ');

    const env: Record<string, string> = {
      PATH: spec.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: spec.cwd,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'dumb',
      TMPDIR: spec.env.TMPDIR ?? spec.cwd + '/tmp',
      ...spec.env
    };

    const args = profile
      ? ['-p', profile, '/bin/bash', '-c', script, '/bin/bash', '-c', spec.command]
      : ['-c', script, '/bin/bash', '-c', spec.command];

    const child = spawn(this.isolation === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : '/bin/bash', args, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const append = (target: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (target === 'out') {
        if (stdout.length + text.length > maxBytes) {
          stdout += text.slice(0, Math.max(0, maxBytes - stdout.length));
          truncated = true;
        } else stdout += text;
      } else {
        if (stderr.length + text.length > maxBytes) {
          stderr += text.slice(0, Math.max(0, maxBytes - stderr.length));
          truncated = true;
        } else stderr += text;
      }
    };

    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));

    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    else child.stdin?.end();

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 1500).unref?.();
    }, spec.timeoutMs);

    const exit = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 143 : 0), signal }));
      child.on('error', () => resolve({ code: 127, signal: null }));
    });
    clearTimeout(timer);

    return {
      stdout,
      stderr,
      exitCode: timedOut ? 124 : exit.code,
      signal: exit.signal,
      timedOut,
      durationMs: Date.now() - started,
      truncated,
      isolation: this.isolation
    };
  }

  async dispose(): Promise<void> {
    /* nothing to tear down for a local process sandbox */
  }
}

/**
 * Placeholder for a hosted remote sandbox adapter. Kept in the
 * tree so the seam is explicit: nothing in the runtime imports a process API directly.
 */
export class RemoteSandboxAdapter implements SandboxAdapter {
  readonly name: string;
  readonly isolation = 'microvm' as const;

  constructor(options: { name: string; endpoint: string; apiKey?: string }) {
    this.name = options.name;
    void options.endpoint;
    void options.apiKey;
  }

  async exec(): Promise<ExecResult> {
    throw new Error('RemoteSandboxAdapter is not implemented in this build; use the local adapter or provide a hosted one.');
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}
