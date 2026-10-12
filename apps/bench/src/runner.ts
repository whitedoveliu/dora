import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, type AgentEvent, type LogLevel } from '@dora/core';
import { createRuntime, type RuntimeBundle } from '@dora/runtime';
import { selectTasks, TASKS, type BenchTask, type TaskExpectations } from './tasks.ts';

/**
 * Bench runner.
 *
 * One task = one fresh data directory, one main session, one prompt. The runner drives the
 * queue until the whole tree is quiet, then judges the run from the event stream — never
 * from what the model says about itself.
 */
export interface ToolCallRecord {
  session: string;
  kind: 'main' | 'task';
  argv: string;
  action: string | null;
  exitCode: number;
  attachments: number;
  durationMs: number;
}

export interface TaskOutcome {
  id: string;
  difficulty: BenchTask['difficulty'];
  title: string;
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  reasons: string[];
  durationMs: number;
  turns: number;
  tokens: { input: number; output: number };
  toolCalls: ToolCallRecord[];
  toolActions: string[];
  taskAgents: number;
  gateBlocks: number;
  toolErrors: number;
  logCounts: Record<string, number>;
  finalText: string;
  dataDir: string;
  logFile: string | null;
  quiet: { settled: boolean; iterations: number };
}

export interface BenchOptions {
  benchDir: string;
  only?: string[];
  difficulty?: string;
  /** Force the deterministic offline model. */
  mock?: boolean;
  mockwebUrl?: string | null;
  onProgress?: (line: string) => void;
}

const log = createLogger('bench');

export async function runTask(task: BenchTask, options: BenchOptions): Promise<TaskOutcome> {
  const dataDir = join(options.benchDir, task.id);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const started = Date.now();
  const base: TaskOutcome = {
    id: task.id,
    difficulty: task.difficulty,
    title: task.title,
    verdict: 'error',
    reasons: [],
    durationMs: 0,
    turns: 0,
    tokens: { input: 0, output: 0 },
    toolCalls: [],
    toolActions: [],
    taskAgents: 0,
    gateBlocks: 0,
    toolErrors: 0,
    logCounts: {},
    finalText: '',
    dataDir,
    logFile: null,
    quiet: { settled: false, iterations: 0 }
  };

  if (options.mock) process.env.DORA_MODEL_PROVIDER = 'mock';

  let runtime: RuntimeBundle | null = null;
  try {
    runtime = await createRuntime({
      config: { dataDir, logDir: join(dataDir, 'logs') },
      offlineSearch: true
    });
    // The tools CLI inside the sandbox reaches the runtime over the session socket, so
    // the socket has to exist before the first bash call.
    await runtime.start();
    if (task.setup) await task.setup(runtime);

    const session = runtime.ensureMainSession('console');
    log.info('task start', { task: task.id, difficulty: task.difficulty, session: session.id });

    const timeoutMs = task.timeoutMs ?? 300_000;
    const run = (async () => {
      await runtime!.submitUserMessage(task.prompt, { sessionId: session.id });
      const quiet = await runtime!.waitForQuiet({ timeoutMs: Math.max(30_000, timeoutMs - (Date.now() - started)) });
      base.quiet = { settled: quiet.settled, iterations: quiet.iterations };
      if (task.phase2) {
        log.info('task phase2', { task: task.id, note: task.phase2.note });
        await task.phase2.run(runtime!);
        const quiet2 = await runtime!.waitForQuiet({ timeoutMs: 120_000 });
        base.quiet = { settled: quiet.settled && quiet2.settled, iterations: quiet.iterations + quiet2.iterations };
      }
    })();

    const guard = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs).unref?.());
    const raced = await Promise.race([run.then(() => 'done' as const), guard]);
    if (raced === 'timeout') base.reasons.push('task exceeded ' + timeoutMs + ' ms');

    const collected = collect(runtime, session.id);
    Object.assign(base, collected);
    base.finalText = collected.finalText;
    base.reasons.push(...judge(task.expect, collected));
    base.verdict = base.reasons.length === 0 ? 'pass' : 'fail';
  } catch (err) {
    base.verdict = 'error';
    base.reasons.push(err instanceof Error ? err.message : String(err));
    log.error('task threw', { task: task.id, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : null });
  } finally {
    if (runtime) await runtime.stop().catch(() => undefined);
    base.durationMs = Date.now() - started;
    base.logCounts = countLogLevels(dataDir);
    const logFiles = (() => {
      try {
        return readdirSync(join(dataDir, 'logs')).filter((f) => f.endsWith('.jsonl')).sort();
      } catch {
        return [];
      }
    })();
    base.logFile = logFiles.length > 0 ? join(dataDir, 'logs', logFiles[logFiles.length - 1]) : null;
    writeFileSync(join(dataDir, 'outcome.json'), JSON.stringify(base, null, 2), 'utf8');
  }
  return base;
}

interface Collected {
  turns: number;
  tokens: { input: number; output: number };
  toolCalls: ToolCallRecord[];
  toolActions: string[];
  taskAgents: number;
  gateBlocks: number;
  toolErrors: number;
  compaction: boolean;
  reports: number;
  todosCreated: number;
  wakesCreated: number;
  subscriptions: number;
  leases: number;
  finalText: string;
  childText: string;
  errors: string[];
}

function collect(runtime: RuntimeBundle, mainSessionId: string): Collected {
  const main = runtime.store.get(mainSessionId)!;
  const children = runtime.store.children(mainSessionId);
  const out: Collected = {
    turns: 0,
    tokens: { input: 0, output: 0 },
    toolCalls: [],
    toolActions: [],
    taskAgents: children.length,
    gateBlocks: 0,
    toolErrors: 0,
    compaction: false,
    reports: 0,
    todosCreated: 0,
    wakesCreated: 0,
    subscriptions: 0,
    leases: 0,
    finalText: '',
    childText: '',
    errors: []
  };

  const scan = (sessionId: string, kind: 'main' | 'task') => {
    const events: AgentEvent[] = runtime.store.events(sessionId, { limit: 5000 });
    const pending = new Map<string, { command: string; at: number }>();
    for (const event of events) {
      if (event.type === 'assistant_message') {
        out.turns += 1;
        const usage = event.data['usage'] as { inputTokens?: number; outputTokens?: number } | undefined;
        out.tokens.input += usage?.inputTokens ?? 0;
        out.tokens.output += usage?.outputTokens ?? 0;
        if (kind === 'main') out.finalText = String(event.data['text'] ?? out.finalText);
        else out.childText += String(event.data['text'] ?? '') + '\n';
      }
      if (event.type === 'compaction') out.compaction = true;
      if (event.type === 'report') out.reports += 1;
      if (event.type === 'error') out.errors.push(String(event.data['message'] ?? 'error'));
      if (event.type === 'tool_call') {
        pending.set(String(event.data['command'] ?? ''), { command: String(event.data['command'] ?? ''), at: event.ts });
      }
      if (event.type === 'tool_result') {
        const command = String(event.data['command'] ?? '');
        const exitCode = Number(event.data['exit_code'] ?? 0);
        // A bash command may chain several calls; the first one is the primary record
        // and the rest still count towards which actions ran.
        const argv = toolsInvocations(command)[0] ?? command;
        const action = actionOf(runtime, argv);
        const record: ToolCallRecord = {
          session: sessionId,
          kind,
          argv,
          action,
          exitCode,
          attachments: Array.isArray(event.data['attachments']) ? (event.data['attachments'] as unknown[]).length : 0,
          durationMs: Number(event.data['duration_ms'] ?? 0)
        };
        out.toolCalls.push(record);
        if (action) out.toolActions.push(action);
        for (const extra of toolsInvocations(command)) {
          const extraAction = actionOf(runtime, extra);
          if (extraAction && !out.toolActions.includes(extraAction)) out.toolActions.push(extraAction);
        }
        if (exitCode === 3) out.gateBlocks += 1;
        else if (exitCode >= 2) out.toolErrors += 1;
        if (action === 'todos.create') out.todosCreated += 1;
        if (action === 'wake_schedule.create') out.wakesCreated += 1;
        if (action === 'wake_subscription.subscribe') out.subscriptions += 1;
        if (action === 'cloud_browser_scheduler.acquire') out.leases += 1;
      }
    }
    for (const child of runtime.store.children(sessionId)) scan(child.id, 'task');
  };
  scan(mainSessionId, 'main');
  void main;
  return out;
}

/**
 * Every "tools <family> <action> ..." invocation inside a shell command line. The whole
 * fragment is returned, because the caller needs the action name, not just the family.
 */
export function toolsInvocations(command: string): string[] {
  const found: string[] = [];
  for (const match of command.matchAll(/(?:^|[;&|(]|\$\()\s*(tools\s+[^;&|\n]*)/g)) {
    const fragment = match[1].trim();
    const tokens = fragment.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && !tokens[1].startsWith('-')) found.push(fragment);
  }
  return found;
}

function actionOf(runtime: RuntimeBundle, argv: string): string | null {
  const raw = argv.trim().split(/\s+/).filter(Boolean);
  // Callers hand us either "todos list ..." or the whole command line "tools todos list ...".
  const tokens = raw[0] === 'tools' ? raw.slice(1) : raw;
  if (tokens.length === 0) return null;
  if (tokens[0] === 'help' || tokens[0] === 'async') return null;
  if (tokens[0].includes('.')) return runtime.registry.get(tokens[0]) ? tokens[0] : null;
  if (tokens[1] && !tokens[1].startsWith('--')) {
    const two = tokens[0] + '.' + tokens[1];
    if (runtime.registry.get(two)) return two;
  }
  return runtime.registry.get(tokens[0]) ? tokens[0] : null;
}

function judge(expect: TaskExpectations, got: Collected): string[] {
  const reasons: string[] = [];
  const haystack = (got.finalText + '\n' + got.childText).toLowerCase();
  const wokenText = (got.finalText + '\n' + got.childText).toLowerCase();
  if (expect.noToolErrors && got.toolErrors > 0) reasons.push('expected no tool errors, saw ' + got.toolErrors);
  for (const action of expect.toolsUsed ?? []) {
    if (!got.toolActions.includes(action)) reasons.push('never called ' + action);
  }
  if (expect.anyOfTools && expect.anyOfTools.length > 0 && !expect.anyOfTools.some((a) => got.toolActions.includes(a))) {
    reasons.push('called none of ' + expect.anyOfTools.join(', '));
  }
  if (expect.minToolCalls !== undefined && got.toolCalls.length < expect.minToolCalls) {
    reasons.push('only ' + got.toolCalls.length + ' tool calls, expected at least ' + expect.minToolCalls);
  }
  if (expect.taskAgentsAtLeast !== undefined && got.taskAgents < expect.taskAgentsAtLeast) {
    reasons.push('spawned ' + got.taskAgents + ' task agents, expected at least ' + expect.taskAgentsAtLeast);
  }
  if (expect.todoCreatedAtLeast !== undefined && got.todosCreated < expect.todoCreatedAtLeast) {
    reasons.push('created ' + got.todosCreated + ' todos, expected at least ' + expect.todoCreatedAtLeast);
  }
  if (expect.wakeCreated && got.wakesCreated === 0) reasons.push('no wake was scheduled');
  if (expect.subscriptionCreated && got.subscriptions === 0) reasons.push('no subscription was created');
  if (expect.leaseAcquired && got.leases === 0) reasons.push('no browser lease was acquired');
  if (expect.compactionHappened && !got.compaction) reasons.push('no compaction happened');
  if (expect.reportToParent && got.reports === 0) reasons.push('no task agent reported back');
  if (expect.maxTurns !== undefined && got.turns > expect.maxTurns) reasons.push('used ' + got.turns + ' turns, limit ' + expect.maxTurns);
  for (const needle of expect.contains ?? []) {
    if (!haystack.includes(needle.toLowerCase())) reasons.push('answer never mentioned "' + needle + '"');
  }
  if (expect.containsAny && expect.containsAny.length > 0 && !expect.containsAny.some((n) => haystack.includes(n.toLowerCase()))) {
    reasons.push('answer mentioned none of ' + expect.containsAny.join(' / '));
  }
  for (const needle of expect.notContains ?? []) {
    if (haystack.includes(needle.toLowerCase())) reasons.push('answer contained forbidden "' + needle + '"');
  }
  if (expect.readBeforeSend) {
    const ordered = got.toolCalls.map((c) => c.action).filter((a): a is string => a !== null);
    const firstSend = ordered.findIndex((a) => expect.readBeforeSend!.send.includes(a));
    if (firstSend === -1) {
      reasons.push('never sent anything through ' + expect.readBeforeSend.send.join('/'));
    } else {
      const readBefore = ordered.slice(0, firstSend).some((a) => expect.readBeforeSend!.read.includes(a));
      if (!readBefore) reasons.push('sent without reading the thread first');
    }
  }
  if (expect.asksMember) {
    const asks = /[?？]/.test(wokenText) || /(confirm|approval|approve|before i|shall i|do you want|请确认|确认一下|需要你|要不要)/i.test(wokenText);
    if (!asks) reasons.push('did not hand the decision back to the member');
  }
  return reasons;
}

function countLogLevels(dataDir: string): Record<string, number> {
  const dir = join(dataDir, 'logs');
  const counts: Record<string, number> = {};
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { level?: LogLevel; channel?: string };
          const key = String(record.level ?? 'unknown');
          counts[key] = (counts[key] ?? 0) + 1;
          const channelKey = 'channel:' + String(record.channel ?? '');
          counts[channelKey] = (counts[channelKey] ?? 0) + 1;
        } catch {
          counts['torn'] = (counts['torn'] ?? 0) + 1;
        }
      }
    }
  } catch {
    /* a task with no log directory is reported as such */
  }
  return counts;
}

export interface BenchReport {
  startedAt: string;
  finishedAt: string;
  model: string;
  outcomes: TaskOutcome[];
  totals: { pass: number; fail: number; error: number; skipped: number; durationMs: number; tokens: { input: number; output: number } };
}

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const tasks = selectTasks({ only: options.only, difficulty: options.difficulty });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const outcomes: TaskOutcome[] = [];
  const progress = options.onProgress ?? ((line: string) => process.stdout.write(line + '\n'));

  progress('route: ' + tasks.length + ' task(s) from ' + TASKS.length + ' defined');
  for (const task of tasks) {
    progress('--- ' + task.id + ' [' + task.difficulty + '] ' + task.title);
    const outcome = await runTask(task, options);
    outcomes.push(outcome);
    const mark = outcome.verdict === 'pass' ? 'PASS' : outcome.verdict.toUpperCase();
    progress(
      '    ' + mark + '  ' + Math.round(outcome.durationMs / 1000) + 's  turns=' + outcome.turns +
        ' tools=' + outcome.toolCalls.length + ' agents=' + outcome.taskAgents +
        ' tokens=' + outcome.tokens.input + '/' + outcome.tokens.output +
        (outcome.reasons.length > 0 ? '\n      reasons: ' + outcome.reasons.join(' | ') : '')
    );
  }

  const report: BenchReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: process.env.DORA_MODEL_MAIN ?? 'deepseek-v4-pro',
    outcomes,
    totals: {
      pass: outcomes.filter((o) => o.verdict === 'pass').length,
      fail: outcomes.filter((o) => o.verdict === 'fail').length,
      error: outcomes.filter((o) => o.verdict === 'error').length,
      skipped: outcomes.filter((o) => o.verdict === 'skipped').length,
      durationMs: Date.now() - started,
      tokens: outcomes.reduce((acc, o) => ({ input: acc.input + o.tokens.input, output: acc.output + o.tokens.output }), { input: 0, output: 0 })
    }
  };
  mkdirSync(options.benchDir, { recursive: true });
  writeFileSync(join(options.benchDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(join(options.benchDir, 'report.md'), renderReport(report), 'utf8');
  return report;
}

export function renderReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push('# Dora.ai bench — ' + report.startedAt + ' → ' + report.finishedAt);
  lines.push('model: ' + report.model);
  lines.push('');
  lines.push('| task | difficulty | verdict | s | turns | tools | agents | tokens in/out | reasons |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const o of report.outcomes) {
    lines.push(
      '| ' + o.id + ' | ' + o.difficulty + ' | ' + o.verdict + ' | ' + Math.round(o.durationMs / 1000) + ' | ' + o.turns + ' | ' +
        o.toolCalls.length + ' | ' + o.taskAgents + ' | ' + o.tokens.input + '/' + o.tokens.output + ' | ' + (o.reasons.join('; ') || '') + ' |'
    );
  }
  lines.push('');
  lines.push(
    'totals: ' + report.totals.pass + ' pass / ' + report.totals.fail + ' fail / ' + report.totals.error + ' error / ' +
      report.totals.skipped + ' skipped in ' + Math.round(report.totals.durationMs / 1000) + 's, tokens ' +
      report.totals.tokens.input + ' in / ' + report.totals.tokens.output + ' out'
  );
  return lines.join('\n') + '\n';
}
