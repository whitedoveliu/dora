import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime, type RuntimeBundle } from '@dora/runtime';
import { executeArgv } from '@dora/tools';
import { COMPACTION_SECTIONS, compact } from '@dora/core';

/**
 * dora demo — a scripted walk through every mechanism the runtime implements.
 *
 * Each step prints what it is proving, the command it issues, and the raw outcome, so
 * the run doubles as the acceptance test a reviewer can execute by hand.
 */
export interface DemoOptions {
  dataDir?: string;
  quiet?: boolean;
  keepData?: boolean;
  /** Use the machine's live model instead of the deterministic offline one. */
  live?: boolean;
}

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDemo(options: DemoOptions = {}): Promise<{ steps: StepResult[]; ok: boolean }> {
  const dataDir = options.dataDir ?? join(process.cwd(), 'var', 'demo');
  if (!options.keepData) {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(process.cwd(), 'var', 'demo-socket'), { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });

  const log = (line = '') => {
    if (!options.quiet) process.stdout.write(line + '\n');
  };
  const steps: StepResult[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    log((ok ? '  PASS  ' : '  FAIL  ') + name + ' — ' + detail);
  };

  // The walkthrough is deterministic: it uses the offline model unless asked otherwise.
  if (options.live !== true) process.env.DORA_MODEL_PROVIDER = 'mock';
  process.env.DORA_LOG_ECHO = '0';
  const runtime = await createRuntime({ config: { dataDir }, offlineSearch: true });
  await runtime.start();
  const session = runtime.ensureMainSession('console');
  const invoke = (argv: string[], as: { id: string } = session) =>
    executeArgv({
      argv,
      session: runtime.store.get(as.id) ?? session,
      account: runtime.account,
      flags: runtime.flags,
      services: runtime.services,
      config: runtime.config,
      db: runtime.db,
      registry: runtime.registry
    });

  /**
   * An agent reads an action's contract before its first call. The demo does exactly
   * that, which is also what keeps the Help gate out of the way for later calls.
   */
  const run = async (argv: string[], as: { id: string } = session) => {
    const path = resolveActionPath(runtime, argv);
    if (path && !readContracts.has(as.id + ':' + path)) {
      await invoke(['help', path], as);
      readContracts.add(as.id + ':' + path);
    }
    return invoke(argv, as);
  };
  const readContracts = new Set<string>();

  log('Dora.ai — mechanism walkthrough');
  log('data dir: ' + dataDir);
  log('account:  ' + runtime.account.handle + '  main session: ' + session.id);
  log('');

  // 1. surface inventory -------------------------------------------------------
  const index = runtime.registry.index((c) => runtime.services.connectors.isConnected(c));
  log('[1] tool surface');
  log('    families: ' + index.families.length + '   actions routed: ' + index.totalActions + '   catalogue: ' + index.declaredTotal);
  const connected = index.families.filter((f) => f.connected).length;
  record('tool index', index.totalActions > 150 && connected > 10, index.totalActions + ' actions across ' + index.families.length + ' families, ' + connected + ' connectors connected');

  // 2. help gate ---------------------------------------------------------------
  log('');
  log('[2] Help gate — an action must have its contract read before the first call');
  const first = await invoke(['time', 'now', '--timezone', 'UTC']);
  record(
    'first call blocked with exit code 3',
    first.exitCode === 3 && first.attachments.length === 1,
    'exit=' + first.exitCode + ' attachments=' + first.attachments.map((a) => a.name).join(',')
  );
  const second = await invoke(['time', 'now', '--timezone', 'UTC']);
  record('second call allowed', second.exitCode === 0 && second.stdout.includes('now:'), 'stdout=' + JSON.stringify(second.stdout.trim().slice(0, 60)));

  // 3. capability matrix -------------------------------------------------------
  log('');
  log('[3] Capability matrix — the main agent delegates work, a task agent executes it');
  const denied = await run(['gmail', 'search', '--query', 'planning']);
  record('main agent denied gmail.search', denied.exitCode === 4 && denied.stdout.includes('DELEGATED'), denied.stdout.trim().slice(0, 90));

  // 4. delegation --------------------------------------------------------------
  log('');
  log('[4] Delegation — opening package = recall + task text + pre-injected help pages');
  const delegated = await run(['tasks', 'delegate', '--model-mode', 'fast', '--name', 'planning review', '--task', 'Read the planning doc and report the headcount risk.']);
  const taskId = /task agent started: (\S+)/.exec(delegated.stdout)?.[1] ?? '';
  const taskSession = taskId ? runtime.store.get(taskId) : null;
  const opening = taskSession ? runtime.store.events(taskId, { limit: 20 }).find((e) => e.type === 'user_message') : null;
  const pageCount = opening ? (String(opening.data['text']).match(/===== tools help /g) ?? []).length : 0;
  record('task agent created', taskSession !== null && taskSession.role === 'task_agent', 'task=' + taskId);
  record('opening package carries help pages', pageCount >= 10, pageCount + ' pre-injected pages');
  const taskGmail = taskId ? await run(['gmail', 'search', '--query', 'planning'], { id: taskId }) : null;
  record('task agent may execute gmail.search', taskGmail !== null && taskGmail.exitCode !== 4, 'exit=' + (taskGmail?.exitCode ?? -1));
  const taskChannelWrite = taskId ? await run(['whatsappbot', 'send', '--to', '+15550000000', '--body', 'hello'], { id: taskId }) : null;
  record(
    'task agent may not write to a channel',
    taskChannelWrite !== null && taskChannelWrite.exitCode === 4 && taskChannelWrite.stdout.includes('UNAVAILABLE'),
    taskChannelWrite?.stdout.trim().slice(0, 90) ?? ''
  );

  // 5. wakes -------------------------------------------------------------------
  log('');
  log('[5] Wakes — cadence, clock threshold, trigger filter, safety check-in');
  const wake = await run(['wake_schedule', 'create', '--schedule-interval', '5', '--prompt', 'check the plan']);
  const wakeId = /scheduled (\S+)/.exec(wake.stdout)?.[1] ?? '';
  const missingThreshold = await run(['wake_schedule', 'create', '--at', '2030-01-01T09:00:00', '--prompt', 'x']);
  record('cadence wake created', wakeId !== '', wakeId);
  record('clock wake without --schedule-threshold is refused', missingThreshold.exitCode !== 0 && missingThreshold.stderr.includes('--schedule-threshold'), missingThreshold.stderr.trim().slice(0, 90));
  const sub = await run(['wake_subscription', 'subscribe', '--source', 'gmail', '--filter', 'planning'], { id: taskId });
  const subId = /subscribed (\S+)/.exec(sub.stdout)?.[1] ?? '';
  const queued = runtime.ingestEvent('gmail', { subject: 'planning doc updated' });
  record('subscription wakes the subscriber on a matching event', queued === 1 && subId !== '', 'queued=' + queued);

  // 6. sandbox fence -----------------------------------------------------------
  log('');
  log('[6] Sandbox fence — enforced by the kernel, not by a prompt');
  const fence = await runBashThroughAgent(runtime, session.id, 'echo tampered > memory/communication-note.md 2>&1; echo rc=$?; cat /tmp/does-not-exist 2>/dev/null; echo');
  record('write into /memory is refused', fence.includes('Operation not permitted') || fence.includes('rc=1'), fence.split('\n').filter(Boolean).slice(0, 1).join(' '));
  const dbRead = await runBashThroughAgent(runtime, session.id, 'cat ' + runtime.config.dbPath + ' 2>&1 | head -c 200; echo');
  record('the control-plane database is unreadable from the sandbox', dbRead.includes('Operation not permitted'), dbRead.trim().slice(0, 80));

  // 7. vault -------------------------------------------------------------------
  log('');
  log('[7] Vault — fill-only: values go in and are never returned');
  const link = runtime.services.vault.createFillLink({ label: 'airline account', kind: 'password', fields: ['username', 'password'] });
  const item = runtime.services.vault.submitFill(link.token, { username: 'member', password: 'hunter2-not-readable' });
  const statusText = JSON.stringify(runtime.services.vault.list());
  const fillResult = runtime.services.vault.fill(item.id, { site: 'airline.example', field: 'password' });
  record('stored value never appears in the agent-facing surface', !statusText.includes('hunter2'), 'list() fields: ' + JSON.stringify(runtime.services.vault.status(item.id)?.fields));
  record('fill reports a count, not a value', fillResult.filled === true && !JSON.stringify(fillResult).includes('hunter2'), JSON.stringify(fillResult));

  // 8. channels ----------------------------------------------------------------
  log('');
  log('[8] Channels — the WhatsApp 24-hour window and the four pre-approved templates');
  const closed = await run(['whatsappbot', 'send', '--to', '+15550000000', '--body', 'hi']);
  const notified = await run(['whatsappbot', 'notify', '--to', '+15550000000', '--template', 'update_ready', '--var', 'planning review']);
  record('free-form send refused while the window is closed', closed.exitCode !== 0 && closed.stderr.includes('window is closed'), closed.stderr.trim().slice(0, 90));
  record('a pre-approved template still goes out', notified.exitCode === 0, notified.stdout.trim());

  // 9. observations ------------------------------------------------------------
  log('');
  log('[9] Observations — SQL with enforced limits');
  await run(['observations', 'sql', '--query', 'SELECT 1']);
  const okQuery = await run(['observations', 'sql', '--query', 'SELECT path, title FROM gmail WHERE ts > 0 LIMIT 3']);
  const writeQuery = await run(['observations', 'sql', '--query', 'DELETE FROM gmail']);
  const offsetQuery = await run(['observations', 'sql', '--query', 'SELECT path FROM gmail WHERE ts > 0 OFFSET 5']);
  record('timestamped SELECT succeeds', okQuery.exitCode === 0 && okQuery.stdout.includes('gm_'), okQuery.stdout.split('\n')[1] ?? '');
  record('writes are rejected', writeQuery.exitCode !== 0 && writeQuery.stderr.includes('SELECT or WITH'), writeQuery.stderr.trim().slice(0, 70));
  record('OFFSET is rejected', offsetQuery.exitCode !== 0 && offsetQuery.stderr.includes('OFFSET'), offsetQuery.stderr.trim().slice(0, 70));

  // 10. compaction -------------------------------------------------------------
  log('');
  log('[10] Compaction — a fixed eight-section summary becomes the context');
  const summary = await compact({ events: runtime.store.events(session.id, { limit: 200 }) });
  const sections = COMPACTION_SECTIONS.filter((s) => summary.includes(s));
  record('compaction emits all eight sections', sections.length === 8, sections.length + '/8 sections');

  // 11. recall -----------------------------------------------------------------
  log('');
  log('[11] memory_recall — verbatim memory excerpts, selected by last_modified');
  const agentTurn = await runtime.submitUserMessage('run: tools time now --timezone UTC', { sessionId: session.id });
  const recallEvent = runtime.store.events(session.id, { limit: 500 }).find((e) => e.type === 'recall');
  record('an agent turn ran end to end', agentTurn.turns > 0, agentTurn.turns + ' model turns, status ' + agentTurn.status);
  record('recall was injected at the start of the run', recallEvent !== undefined, 'paths: ' + JSON.stringify(recallEvent?.data['paths'] ?? []));

  await runtime.stop();

  const failures = steps.filter((s) => !s.ok);
  log('');
  log(failures.length === 0 ? 'all ' + steps.length + ' mechanisms verified' : failures.length + ' of ' + steps.length + ' steps failed');
  return { steps, ok: failures.length === 0 };
}

/** bash is an agent command rather than a tools action, so it goes through the sandbox runner. */
/** Work out which action an argv would resolve to, so the demo can read its contract first. */
function resolveActionPath(runtime: RuntimeBundle, argv: string[]): string | null {
  const first = argv[0];
  if (!first || first === 'help' || first === 'async') return null;
  if (first.includes('.')) return runtime.registry.get(first) ? first : null;
  if (argv[1] && !argv[1].startsWith('--')) {
    const two = first + '.' + argv[1];
    if (runtime.registry.get(two)) return two;
  }
  return runtime.registry.get(first) ? first : null;
}

/** bash is an agent command rather than a tools action, so it goes through the sandbox runner. */
async function runBashThroughAgent(runtime: RuntimeBundle, sessionId: string, command: string): Promise<string> {
  const session = runtime.store.get(sessionId) ?? runtime.ensureMainSession();
  const out = await runtime.bash(session.id, command, { timeoutMs: 20_000 });
  return out.stdout + out.stderr;
}
