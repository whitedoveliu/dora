import { createLogger, denialFor, redactArgv, type AccountRef, type Attachment, type Db, type DoraConfig, type DoraServices, type FlagMap, type SessionRecord } from '@dora/core';
import { blockedMessage, HelpGate } from './gate.ts';
import { helpAttachmentName, renderHelpPage, renderHelpStub, renderStatusLine } from './help.ts';
import { parseInvocation, renderIssues } from './parse.ts';
import { renderToolIndex, type ToolRegistry } from './registry.ts';
import type { ActionContext } from './contract.ts';

export interface ExecuteInput {
  argv: string[];
  session: SessionRecord;
  account: AccountRef;
  flags: FlagMap;
  services: DoraServices;
  config: DoraConfig;
  db: Db;
  registry: ToolRegistry;
  workspace?: string;
  stdin?: string;
}

export interface ExecuteOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  attachments: Attachment[];
}

function actionPathOf(input: ExecuteInput, registry: ToolRegistry): string | null {
  const argv = input.argv.length > 0 ? input.argv : ['help'];
  if (argv[0] === 'help' || argv[0] === 'async') return null;
  const first = argv[0];
  if (first.includes('.')) return registry.get(first) ? first : null;
  if (argv[1] && !argv[1].startsWith('--')) {
    const two = first + '.' + argv[1];
    if (registry.get(two)) return two;
  }
  return registry.get(first) ? first : null;
}

function pageAttachment(target: string, content: string): Attachment {
  return { name: helpAttachmentName(target), kind: 'help_page', mime: 'text/plain', content, truncated: false };
}

/** Resolve argv[0..1] to an action path: "family action" or a single action name. */
function resolvePath(registry: ToolRegistry, argv: string[]): string | null {
  const first = argv[0];
  if (!first) return null;
  if (first.includes('.')) return registry.get(first) ? first : null;
  if (argv[1] && !argv[1].startsWith('--')) {
    const two = first + '.' + argv[1];
    if (registry.get(two)) return two;
  }
  return registry.get(first) ? first : null;
}

function renderTarget(
  registry: ToolRegistry,
  services: DoraServices,
  target: string
): { pages: Attachment[]; missing: string[] } {
  const pages: Attachment[] = [];
  const missing: string[] = [];
  const clean = target.endsWith('.all') ? target.slice(0, -4) : target;

  const action = registry.get(clean);
  if (action) {
    if (action.connector && !services.connectors.isConnected(action.connector)) {
      pages.push(pageAttachment(clean, renderStatusLine(action.connector)));
    } else {
      pages.push(pageAttachment(clean, renderHelpPage(action)));
    }
    return { pages, missing };
  }

  // "todos.read" is not an action; point the caller at the family instead of only failing.
  const parent = clean.includes('.') ? clean.slice(0, clean.indexOf('.')) : null;
  if (parent && registry.family(parent)) {
    const actions = registry.familyActions(parent).map((a) => a.name).join(', ');
    pages.push({
      name: 'help:' + clean,
      kind: 'help_page',
      mime: 'text/plain',
      content:
        'No action named ' + clean + '.\n\nThe "' + parent + '" family has these actions: ' + actions + '\n' +
        'Read a contract with: tools help ' + parent + '.<action>   (or tools help ' + parent + ' for all of them)\n',
      truncated: false
    });
    return { pages, missing };
  }

  const family = registry.family(clean);
  if (family) {
    const actions = registry.familyActions(clean);
    if (actions.length === 0) missing.push(target);
    for (const a of actions) {
      if (a.connector && !services.connectors.isConnected(a.connector)) {
        pages.push(pageAttachment(a.path, renderStatusLine(a.connector!)));
      } else {
        pages.push(pageAttachment(a.path, renderHelpPage(a)));
      }
    }
    return { pages, missing };
  }

  missing.push(target);
  return { pages, missing };
}

export async function executeArgv(input: ExecuteInput): Promise<ExecuteOutput> {
  const { registry, services, session, config } = input;
  const gate = new HelpGate(input.db);
  const log = createLogger('tools').bind({ session: session.id, role: session.role });
  const startedAt = Date.now();
  const finish = (output: ExecuteOutput, actionPath: string | null): ExecuteOutput => {
    log[output.exitCode === 0 ? 'info' : 'warn']('tools call', {
      argv: redactArgv(input.argv).join(' '),
      action: actionPath,
      exit_code: output.exitCode,
      duration_ms: Date.now() - startedAt,
      attachments: output.attachments.map((a) => a.name),
      stdout_preview: output.stdout.slice(0, 160),
      // A failing call must carry its reason into the log, or the log cannot explain it.
      stderr_preview: output.exitCode === 0 ? undefined : output.stderr.slice(0, 300)
    });
    return output;
  };
  const raw = await executeInner(input, gate);
  return finish(raw, actionPathOf(input, registry));
}

async function executeInner(input: ExecuteInput, gate: HelpGate): Promise<ExecuteOutput> {
  const { registry, services, session, config } = input;
  const ctx: ActionContext = {
    session,
    account: input.account,
    flags: input.flags,
    services,
    config,
    db: input.db,
    json: false,
    workspace: input.workspace
  };

  const argv = [...input.argv];
  if (argv.length === 0) argv.push('help');

  // ---- built-in: help -------------------------------------------------------
  if (argv[0] === 'help') {
    const targets = argv.slice(1).filter((a) => !a.startsWith('--'));
    if (targets.length === 0) {
      const index = registry.index((c) => services.connectors.isConnected(c));
      const text = renderToolIndex(index);
      return {
        exitCode: 0,
        stdout: 'index attached: ' + index.families.length + ' families, ' + index.totalActions + ' actions routed\n',
        stderr: '',
        attachments: [{ name: 'help:index', kind: 'help_page', mime: 'text/plain', content: text, truncated: false }]
      };
    }
    const accepted = targets.slice(0, config.helpBatchLimit);
    const dropped = targets.slice(config.helpBatchLimit);
    const pages: Attachment[] = [];
    const missing: string[] = [];
    for (const target of accepted) {
      const rendered = renderTarget(registry, services, target);
      pages.push(...rendered.pages);
      missing.push(...rendered.missing);
    }
    gate.markRead(session.id, pages.map((p) => p.name.replace(/^help:/, '')));
    const stdout =
      renderHelpStub(accepted, pages.length, dropped) + (missing.length > 0 ? 'unknown target: ' + missing.join(', ') + '\n' : '');
    return { exitCode: missing.length > 0 ? 64 : 0, stdout, stderr: '', attachments: pages };
  }

  // ---- built-in: async ------------------------------------------------------
  if (argv[0] === 'async') {
    const sub = argv[1] ?? 'list';
    if (sub === 'list') return { exitCode: 0, stdout: '(no asynchronous operations pending)\n', stderr: '', attachments: [] };
    if (sub === 'wait') return { exitCode: 0, stdout: '(nothing to wait for)\n', stderr: '', attachments: [] };
    return { exitCode: 64, stdout: '', stderr: 'unknown built-in: async ' + sub + '\n', attachments: [] };
  }

  // ---- action dispatch ------------------------------------------------------
  const path = resolvePath(registry, argv);
  if (!path) {
    return {
      exitCode: 64,
      stdout: '',
      stderr:
        'unknown action: ' + argv.slice(0, 2).join(' ') + '\n' +
        'Run `tools help` for the action index, or `tools help <family>` for one family.\n',
      attachments: []
    };
  }
  const action = registry.get(path)!;
  const consumed = path === argv[0] ? 1 : 2;
  const rest = argv.slice(consumed);

  // Pre-check 1: capability matrix for the role.
  const denial = denialFor(session.role, action.trait, action.path);
  if (denial) {
    return { exitCode: 4, stdout: denial.message + '\n', stderr: '', attachments: [] };
  }

  // Pre-check 2: connector state.
  if (action.connector && !services.connectors.isConnected(action.connector)) {
    return { exitCode: 5, stdout: renderStatusLine(action.connector) + '\n', stderr: '', attachments: [] };
  }

  // Pre-check 3: the help gate.
  if (!gate.isRead(session.id, action.path)) {
    const attachments = action.connector && !services.connectors.isConnected(action.connector)
      ? [pageAttachment(action.path, renderStatusLine(action.connector))]
      : [pageAttachment(action.path, renderHelpPage(action))];
    gate.markRead(session.id, [action.path]);
    return { exitCode: 3, stdout: blockedMessage([action.path]) + '\n', stderr: '', attachments };
  }

  const parsed = parseInvocation(rest, action);
  if (parsed.issues.length > 0) {
    return { exitCode: 64, stdout: '', stderr: renderIssues(parsed.issues, action), attachments: [] };
  }
  if (parsed.stdinOption) {
    if (input.stdin === undefined) {
      return { exitCode: 64, stdout: '', stderr: parsed.stdinOption + '-stdin expects a value on stdin\n', attachments: [] };
    }
    parsed.args[parsed.stdinOption] = input.stdin;
  }
  ctx.json = parsed.json;

  try {
    const result = await action.handler(ctx, parsed.args);
    let stdout = result.stdout ?? '';
    if (parsed.json && result.json !== undefined) stdout = JSON.stringify(result.json, null, 2) + '\n';
    else if (stdout === '' && result.json !== undefined) stdout = JSON.stringify(result.json) + '\n';
    return { exitCode: result.exitCode ?? 0, stdout, stderr: '', attachments: result.attachments ?? [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof (err as { exitCode?: number }).exitCode === 'number' ? (err as { exitCode: number }).exitCode : 1;
    return { exitCode: code, stdout: '', stderr: 'error: ' + message + '\n', attachments: [] };
  }
}
