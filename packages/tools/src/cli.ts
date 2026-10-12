#!/usr/bin/env node
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Attachment } from '@dora/core';
import { executeArgv, type ExecuteOutput } from './execute.ts';

/**
 * The `tools` CLI.
 *
 * Inside the sandbox it speaks to the runtime over the session socket. Run by hand on the
 * host it falls back to a direct in-process runtime so the same contracts are testable
 * without a daemon.
 */

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 250).unref?.();
  });
}

function writeAttachments(path: string | undefined, attachments: Attachment[]): void {
  if (!path || attachments.length === 0) return;
  try {
    writeFileSync(path, JSON.stringify({ attachments }), 'utf8');
  } catch {
    /* the caller loses the attachment, not the result */
  }
}

async function callSocket(socketPath: string, payload: Record<string, unknown>): Promise<ExecuteOutput> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const done = (fn: () => void) => {
      socket.destroy();
      fn();
    };
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      try {
        const parsed = JSON.parse(line) as ExecuteOutput & { error?: string };
        if (parsed.error) done(() => reject(new Error(parsed.error)));
        else done(() => resolve(parsed));
      } catch (err) {
        done(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
    socket.on('error', (err) => done(() => reject(err)));
    socket.setTimeout(120_000, () => done(() => reject(new Error('tools CLI timed out waiting for the runtime'))));
  });
}

export async function main(argv: string[]): Promise<number> {
  const sessionId = process.env.DORA_SESSION_ID ?? '';
  const accountId = process.env.DORA_ACCOUNT_ID ?? '';
  const socketPath = process.env.DORA_TOOLS_SOCKET ?? '';
  const attachPath = process.env.DORA_ATTACH_PATH;
  const workspace = process.env.DORA_WORKSPACE;
  const stdin = await readStdin();

  const emit = (out: ExecuteOutput) => {
    writeAttachments(attachPath, out.attachments);
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    return out.exitCode;
  };

  if (socketPath && existsSync(socketPath)) {
    try {
      const out = await callSocket(socketPath, { argv, sessionId, accountId, workspace, stdin, attachPath, token: process.env.DORA_TOOLS_TOKEN ?? '' });
      return emit(out);
    } catch (err) {
      process.stderr.write('runtime unreachable: ' + (err instanceof Error ? err.message : String(err)) + '\n');
      return 70;
    }
  }

  // Inside a sandbox the CLI speaks to the runtime over the session socket only: a
  // private runtime would be a second writer on the same state, and the sandbox fence
  // hides the database from it anyway.
  if (sessionId) {
    process.stderr.write('runtime socket is not available at ' + socketPath + '; start the runtime with `dora serve`\n');
    return 70;
  }

  // Direct mode — for a human at a shell.
  try {
    const runtime = (await import('@dora/runtime')) as unknown as {
      bootstrapDirect: (input: { sessionId: string; accountId: string }) => Promise<{
        session: Parameters<typeof executeArgv>[0]['session'];
        account: Parameters<typeof executeArgv>[0]['account'];
        flags: Parameters<typeof executeArgv>[0]['flags'];
        services: Parameters<typeof executeArgv>[0]['services'];
        config: Parameters<typeof executeArgv>[0]['config'];
        db: Parameters<typeof executeArgv>[0]['db'];
        registry: Parameters<typeof executeArgv>[0]['registry'];
      }>;
    };
    const boot = await runtime.bootstrapDirect({ sessionId: sessionId || 'sess_local_' + randomUUID().slice(0, 8), accountId: accountId || 'acct_local' });
    const out = await executeArgv({
      argv,
      session: boot.session,
      account: boot.account,
      flags: boot.flags,
      services: boot.services,
      config: boot.config,
      db: boot.db,
      registry: boot.registry,
      workspace,
      stdin
    });
    return emit(out);
  } catch (err) {
    process.stderr.write(
      'no runtime available (start it with `dora serve`): ' + (err instanceof Error ? err.message : String(err)) + '\n'
    );
    return 70;
  }
}

const entry = process.argv[1] ?? '';
const isEntryPoint = entry.endsWith('cli.ts') || entry.endsWith('cli.mjs') || entry.endsWith('dora-tools.mjs') || entry.endsWith('tools');

if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(String(err?.stack ?? err) + '\n');
      process.exit(1);
    });
}

export { readFileSync };
