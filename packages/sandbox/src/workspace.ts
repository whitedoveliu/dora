import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function homeDir(): string {
  return homedir();
}
import type { FsPolicy } from './adapter.ts';

/**
 * Per-agent workspace layout.
 *
 * The sandbox keeps these names as real paths: /memory, /skills, /observations,
 * /downloads. Each is backed by one directory per agent session so two agents can
 * never read each other's scratch space.
 */
export interface WorkspacePaths {
  root: string;
  bin: string;
  memory: string;
  skills: string;
  observations: string;
  downloads: string;
  tmp: string;
  work: string;
}

export interface WorkspaceOptions {
  dataDir: string;
  accountDir: string;
  sessionId: string;
  repoRoot: string;
  nodePath: string;
  toolsSocketPath?: string;
  /**
   * Extra paths the sandbox must never read: the repository source tree, the
   * control-plane database and logs, and the machine's own credential stores. The
   * workspace, /memory, /skills and /observations are re-allowed by the profile after
   * this deny.
   */
  hiddenExtra?: string[];
}

export class Workspace {
  readonly paths: WorkspacePaths;
  private readonly options: WorkspaceOptions;

  constructor(options: WorkspaceOptions) {
    this.options = { ...options, dataDir: resolve(options.dataDir), accountDir: resolve(options.accountDir) };
    const root = join(this.options.dataDir, 'workspaces', options.sessionId);
    this.paths = {
      root,
      bin: join(root, 'bin'),
      memory: join(root, 'memory'),
      skills: join(root, 'skills'),
      observations: join(root, 'observations'),
      downloads: join(root, 'downloads'),
      tmp: join(root, 'tmp'),
      work: join(root, 'work')
    };
  }

  ensure(): WorkspacePaths {
    const p = this.paths;
    for (const dir of [p.root, p.bin, p.downloads, p.tmp, p.work]) mkdirSync(dir, { recursive: true });
    this.installToolsBundle();
    this.linkReadOnly(p.memory, join(this.options.accountDir, 'memory'));
    this.linkReadOnly(p.skills, join(this.options.accountDir, 'skills'));
    this.linkReadOnly(p.observations, join(this.options.accountDir, 'observations'));
    this.installToolsShim();
    return p;
  }

  private linkReadOnly(linkPath: string, target: string): void {
    mkdirSync(target, { recursive: true });
    if (existsSync(linkPath) || this.isBrokenLink(linkPath)) {
      try {
        rmSync(linkPath, { recursive: true, force: true });
      } catch {
        /* a stale link is replaced below */
      }
    }
    try {
      symlinkSync(target, linkPath, 'dir');
    } catch {
      mkdirSync(linkPath, { recursive: true });
    }
  }

  private isBrokenLink(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The tools executable a bash call sees on PATH: the bundled CLI is copied into the
   * workspace, because the sandbox deliberately cannot read the source tree, and a
   * thin shim keeps it a stable name for scripts.
   */
  installToolsBundle(): string | null {
    const bundled = join(this.options.repoRoot, 'packages', 'tools', 'dist', 'cli.mjs');
    const target = join(this.paths.bin, 'dora-tools.mjs');
    if (!existsSync(bundled)) return null;
    try {
      copyFileSync(bundled, target);
      chmodSync(target, 0o644);
      return target;
    } catch {
      return null;
    }
  }

  installToolsShim(): string {
    const shim = join(this.paths.bin, 'tools');
    const bundled = join(this.paths.bin, 'dora-tools.mjs');
    const entry = existsSync(bundled) ? bundled : join(this.options.repoRoot, 'packages/tools/src/cli.ts');
    const script = [
      '#!/bin/sh',
      '# Dora tools CLI shim — speaks to the runtime over the session socket.',
      '# Node internals stay out of the agent\'s output.',
      'exec "' + this.options.nodePath + '" --disable-warning=ExperimentalWarning "' + entry + '" "$@"'
    ].join('\n') + '\n';
    writeFileSync(shim, script, { mode: 0o755 });
    try {
      chmodSync(shim, 0o755);
    } catch {
      /* mode is set on write */
    }
    return shim;
  }

  /** Seatbelt policy for a command executed in this workspace. */
  policy(options: { hiddenExtra?: string[] } = {}): FsPolicy {
    const { dataDir, accountDir } = this.options;
    const hidden = [
      // Anything inside the data dir that is not the workspace, memory, skills or
      // observations: the database, logs, transcripts, the vault and the socket dir.
      join(dataDir, 'dora.db'),
      join(dataDir, 'dora.db-wal'),
      join(dataDir, 'dora.db-shm'),
      join(dataDir, 'vault'),
      join(dataDir, 'logs'),
      join(dataDir, 'workspaces'),
      join(dataDir, 'secrets'),
      join(dataDir, 'run'),
      // Credential stores and the repository source tree. `.ssh`, `.aws` and friends are
      // generic on purpose; anything machine-specific belongs in DORA_HIDDEN_PATHS.
      join(homeDir(), '.ssh'),
      join(homeDir(), '.aws'),
      join(homeDir(), '.gnupg'),
      join(homeDir(), '.docker'),
      join(homeDir(), '.config'),
      join(homeDir(), '.netrc'),
      join(homeDir(), '.npmrc'),
      this.options.repoRoot,
      // Machine-specific paths the operator wants hidden too: colon-separated, `~/` expanded.
      ...(process.env['DORA_HIDDEN_PATHS'] ?? '')
        .split(':')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => (p.startsWith('~/') ? join(homeDir(), p.slice(2)) : p)),
      ...(this.options.hiddenExtra ?? [])
    ];
    // Memory, skills and observations stay readable; only the workspace is writable.
    const readable = [this.paths.memory, this.paths.skills, this.paths.observations];
    void accountDir;
    const ipc = this.options.toolsSocketPath ? [this.options.toolsSocketPath] : [];
    return { writable: [this.paths.root], readable, hidden, ipc };
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      DORA_WORKSPACE: this.paths.root,
      DORA_DATA_DIR: this.options.dataDir,
      DORA_NODE: this.options.nodePath,
      DORA_REPO_ROOT: this.options.repoRoot,
      PATH: [this.paths.bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      ...extra
    };
  }
}
