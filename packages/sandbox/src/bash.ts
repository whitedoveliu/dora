import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { estimateTokens, type Attachment, type Interrupt, type ToolResult } from '@dora/core';
import type { SandboxAdapter } from './adapter.ts';
import { assertCommandAllowed, invokesToolsCli, redirectsStdoutToFile } from './filters.ts';
import type { Workspace } from './workspace.ts';

export interface BashRequest {
  command: string;
  timeoutMs: number;
  stdin?: string;
  sessionId: string;
  accountId: string;
  /** HMAC of the session id under the runtime's tools secret: proves which agent is calling. */
  toolsToken?: string;
  extraEnv?: Record<string, string>;
}

export interface BashDeps {
  adapter: SandboxAdapter;
  workspace: Workspace;
  toolsSocketPath: string;
  outputBudgetTokens: number;
  now?: () => number;
}

interface AttachmentEnvelope {
  attachments: Attachment[];
}

/** Collect the attachment side channel written by the tools CLI. */
function collectAttachments(path: string): Attachment[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AttachmentEnvelope;
    return Array.isArray(parsed.attachments) ? parsed.attachments : [];
  } catch {
    return [];
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export class BashRunner {
  private readonly deps: BashDeps;

  constructor(deps: BashDeps) {
    this.deps = deps;
  }

  async run(request: BashRequest): Promise<ToolResult> {
    const clock = this.deps.now ?? Date.now;
    const started = clock();
    try {
      assertCommandAllowed(request.command);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const hint = (err as { details?: { hint?: string } }).details?.hint;
      return {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: detail + (hint ? '\n' + hint : '') + '\n',
        attachments: [],
        overflowPath: null,
        durationMs: clock() - started,
        interrupt: { cause: 'blocked', detail }
      };
    }

    const attachPath = join(this.deps.workspace.paths.tmp, 'attachments-' + randomUUID() + '.json');
    const env = this.deps.workspace.env({
      DORA_SESSION_ID: request.sessionId,
      DORA_ACCOUNT_ID: request.accountId,
      DORA_TOOLS_SOCKET: this.deps.toolsSocketPath,
      DORA_TOOLS_TOKEN: request.toolsToken ?? '',
      DORA_ATTACH_PATH: attachPath,
      ...(request.extraEnv ?? {})
    });

    const result = await this.deps.adapter.exec({
      command: request.command,
      cwd: this.deps.workspace.paths.root,
      env,
      timeoutMs: request.timeoutMs,
      stdin: request.stdin,
      fs: this.deps.workspace.policy(),
      network: true
    });

    const durationMs = clock() - started;
    const isTools = invokesToolsCli(request.command);
    let attachments = isTools ? collectAttachments(attachPath) : [];
    let stderr = result.stderr;
    if (isTools && redirectsStdoutToFile(request.command) && attachments.length > 0) {
      attachments = [];
      stderr += '\n[attachment dropped: stdout was redirected to a file; re-run the tools command without redirection]\n';
    }

    const combined = result.stdout + stderr;
    const budgetChars = this.deps.outputBudgetTokens * 4;
    let stdout = result.stdout;
    let overflowPath: string | null = null;
    if (combined.length > budgetChars) {
      overflowPath = join(this.deps.workspace.paths.tmp, 'output-' + randomUUID() + '.txt');
      writeFileSync(overflowPath, combined, 'utf8');
      const preview = combined.slice(0, 2000);
      stdout =
        '[output over budget: ' + estimateTokens(combined) + ' tokens estimated, budget ' + this.deps.outputBudgetTokens + ' tokens]\n' +
        '[full output: ' + overflowPath + ']\n\n--- preview (first 2000 chars) ---\n' + preview;
      stderr = '';
    }

    const interrupt: Interrupt | null = result.timedOut
      ? { cause: 'timeout', detail: 'command exceeded ' + request.timeoutMs + ' ms' }
      : null;
    if (interrupt) {
      stdout += '\n<interrupt_cause>timeout</interrupt_cause>\n<delivered_code>124</delivered_code>\n';
    }

    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout,
      stderr,
      attachments,
      overflowPath,
      durationMs,
      interrupt
    };
  }
}
