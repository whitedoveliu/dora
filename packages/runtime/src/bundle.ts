import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORE_SCHEMA, configureLogging, createLogger, defaultFlags, fingerprint, getKv, loadConfig, migrate, openDb,
  renderRecallBlock, resolveModelBackend, selectRecallSnippets, setKv, ulid,
  type AccountRef, type AgentEvent, type Db, type DoraConfig, type DoraServices, type FlagMap,
  type RuntimeHooks, type SessionRecord, type ToolResult, type WakeCause
} from '@dora/core';
import { BashRunner, LocalSandboxAdapter, Workspace, buildProfile } from '@dora/sandbox';
import { buildRegistry, type ToolRegistry } from '@dora/tools';
import { MemoryStore } from '@dora/memory';
import { ObservationsStore } from '@dora/observations';
import { VaultStore } from '@dora/vault';
import { ChannelStore, ConnectorStore, HttpSearchService, LocalBrowserService, OfflineSearchService, seedFixtures } from '@dora/integrations';
import { SkillLibrary } from '@dora/skills';
import { MockModelProvider, OpenAiCompatibleProvider } from '@dora/providers';
import { AgentRunner, type CommandRunner, type RunResult } from './agent.ts';
import { DelegationManager } from './delegation.ts';
import { SessionStore } from './store.ts';
import { WakeManager } from './wakes.ts';
import { ToolsServer } from './tools-server.ts';

/**
 * Runtime assembly.
 *
 * One account owns: a memory repo, a skills directory, an observation index, a vault, a
 * set of connector accounts, a browser, channels, and any number of sessions. Sessions
 * own: an event stream, a transcript, a sandbox workspace, and (optionally) wakes.
 */
export interface RuntimeOptions {
  config?: Partial<DoraConfig>;
  accountId?: string;
  handle?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  seed?: boolean;
  offlineSearch?: boolean;
  model?: DoraServices['model'];
  listen?: boolean;
}

export interface RuntimeBundle {
  config: DoraConfig;
  db: Db;
  store: SessionStore;
  registry: ToolRegistry;
  account: AccountRef;
  flags: FlagMap;
  services: DoraServices;
  runner: AgentRunner;
  wakes: WakeManager;
  delegation: DelegationManager;
  accountDir: string;
  ensureMainSession(channel?: string): SessionRecord;
  submitUserMessage(text: string, options?: { channel?: string | null; sessionId?: string }): Promise<RunResult>;
  runSession(sessionId: string, cause: WakeCause, payload?: Record<string, unknown>, text?: string): Promise<RunResult>;
  ingestEvent(source: string, payload: Record<string, unknown>): number;
  /** Run a shell command as a session, with the seatbelt fence and the session token. */
  bash(sessionId: string, command: string, options?: { timeoutMs?: number; stdin?: string }): Promise<ToolResult>;
  runDueWakes(): Promise<number>;
  /**
   * Drive the queue until nothing is running and no wake is due. Task agents run
   * asynchronously, so a caller that wants the whole tree settled (the bench, the API
   * when a request must return a finished answer) waits on this.
   */
  waitForQuiet(options?: { timeoutMs?: number; pollMs?: number }): Promise<{ settled: boolean; iterations: number; pendingWakes: number }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  events(sessionId: string, sinceSeq?: number): AgentEvent[];
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<RuntimeBundle> {
  const config = loadConfig(options.config ?? {});
  mkdirSync(config.dataDir, { recursive: true });
  configureLogging({ dir: config.logDir, level: config.logLevel, retentionDays: config.logRetentionDays });
  const log = createLogger('runtime');
  log.info('runtime starting', {
    data_dir: config.dataDir,
    model_provider: config.model.provider,
    model_main: config.model.main,
    credential: config.model.apiKey ? fingerprint(config.model.apiKey) : '(none)',
    credential_source: config.model.credentialSource,
    log_dir: config.logDir
  });

  const db = openDb(config.dbPath);
  migrate(db, CORE_SCHEMA);

  const accountId = options.accountId ?? 'acct_local';
  const account = ensureAccount(db, {
    id: accountId,
    handle: options.handle ?? 'member',
    displayName: options.displayName ?? 'Member',
    email: options.email ?? 'member@dora.local',
    phone: options.phone ?? '+15550000000',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  });

  const accountDir = join(config.dataDir, 'accounts', account.id);
  for (const dir of ['memory', 'skills', 'observations', 'transcripts', 'downloads']) {
    mkdirSync(join(accountDir, dir), { recursive: true });
  }

  const flags = loadFlags(db, account.id);
  const store = new SessionStore({ db, transcriptsDir: join(accountDir, 'transcripts') });
  const registry = buildRegistry();
  const memory = new MemoryStore({ root: join(accountDir, 'memory'), promoteLines: config.memoryPromoteLines });
  const observations = new ObservationsStore({ db, accountId: account.id, timeoutMs: config.observations.timeoutMs, maxRows: config.observations.maxRows });
  const vault = new VaultStore({ dir: join(config.dataDir, 'vault', account.id) });
  const connectors = new ConnectorStore({ db, accountId: account.id });
  const browser = new LocalBrowserService({ db, accountId: account.id, enforceGuidance: process.env.DORA_GUIDANCE_ENFORCE === '1' });
  const channels = new ChannelStore({ db, accountId: account.id, account });
  const skills = new SkillLibrary({ platformDir: join(config.root, 'packages/skills/corpus'), accountSkillsDir: join(accountDir, 'skills') });
  const search = options.offlineSearch ? new OfflineSearchService() : new HttpSearchService();
  const model = options.model ?? createModel(config);

  if (options.seed !== false && connectors.accounts().length === 0) {
    seedFixtures({ connectors, observations, account: { id: account.id, handle: account.handle, displayName: account.displayName, email: account.email, phone: account.phone } });
    seedMemory(memory, account);
  }

  const workspaces = new Map<string, Workspace>();
  const adapter = new LocalSandboxAdapter({ profileBuilder: buildProfile });
  const toolsSecret = getKv(db, 'tools_secret') ?? (() => {
    const secret = randomBytes(32).toString('base64url');
    setKv(db, 'tools_secret', secret);
    return secret;
  })();
  const tokenFor = (sessionId: string): string => createHmac('sha256', toolsSecret).update(sessionId).digest('base64url');
  const verifyToken = (sessionId: string, token: string): boolean => sessionId.length > 0 && token.length > 0 && tokenFor(sessionId) === token;
  const workspaceFor = (sessionId: string): Workspace => {
    const existing = workspaces.get(sessionId);
    if (existing) return existing;
    const workspace = new Workspace({
      dataDir: config.dataDir,
      accountDir,
      sessionId,
      repoRoot: config.root,
      nodePath: process.execPath,
      toolsSocketPath: config.socketPath,
      hiddenExtra: [config.root, config.dataDir, join(accountDir, 'transcripts')]
    });
    workspace.ensure();
    workspaces.set(sessionId, workspace);
    return workspace;
  };

  const commandRunner: CommandRunner = {
    async run(request) {
      const workspace = workspaceFor(request.sessionId);
      const bash = new BashRunner({
        adapter,
        workspace,
        toolsSocketPath: config.socketPath,
        outputBudgetTokens: config.outputBudgetTokens
      });
      return bash.run({ ...request, toolsToken: tokenFor(request.sessionId) });
    }
  };

  const wakes = new WakeManager({ db, store, config, model });
  const listeners = new Set<(event: AgentEvent) => void>();

  const delegation: DelegationManager = new DelegationManager({
    config,
    db,
    store,
    registry,
    services: null as unknown as DoraServices,
    wakes,
    runner: null as unknown as AgentRunner,
    workspaceFor,
    defaultPages: DelegationManager.defaultPageSet(registry),
    onTaskRun: (sessionId) => {
      void runQueue(sessionId);
    }
  });

  const hooks: RuntimeHooks = {
    delegate: (input) => delegation.delegate(input),
    taskStatus: (sessionId, taskId) => delegation.taskStatus(sessionId, taskId),
    listTasks: (sessionId) => delegation.listTasks(sessionId),
    cancelTask: (sessionId, taskId) => delegation.cancelTask(sessionId, taskId),
    sendToParent: (sessionId, body, attachments) => delegation.sendToParent(sessionId, body, attachments),
    createWake: (sessionId, spec) => wakes.create(sessionId, spec),
    listWakes: (sessionId) => wakes.list(sessionId).map((w) => ({ id: w.id, style: w.style, nextFireAt: w.nextFireAt, trigger: w.trigger, prompt: w.prompt, enabled: w.enabled })),
    cancelWake: (sessionId, wakeId) => wakes.cancel(sessionId, wakeId),
    updateWake: (sessionId, wakeId, patch) => wakes.update(sessionId, wakeId, patch),
    subscribe: (sessionId, spec) => wakes.subscribe(sessionId, spec),
    listSubscriptions: (sessionId) => wakes.listSubscriptions(sessionId),
    unsubscribe: (sessionId, id) => wakes.unsubscribe(sessionId, id),
    hold: (sessionId, reason) => {
      store.append(sessionId, 'hold', { reason, result: 'Turn ended.' });
      store.update(sessionId, { status: 'held', heldReason: reason });
    },
    budget: (acct) => store.budget(acct),
    todos: {
      list: (acct) => store.listTodos(acct),
      create: (acct, input) => store.createTodo(acct, input),
      update: (id, patch) => store.updateTodo(id, patch),
      get: (id) => store.getTodo(id)
    }
  };

  const services: DoraServices = {
    account,
    flags,
    memory,
    observations,
    vault,
    connectors,
    browser,
    channels,
    skills,
    search,
    runtime: hooks,
    model
  };

  delegation['deps'].services = services;

  // The prompt must state the paths that exist for *this* session: a workspace is
  // per-agent, so /memory is <workspace>/memory, not /memory and not a preview's path.
  const workspacePaths = (sessionId: string): Record<string, string> => {
    const sample = new Workspace({
      dataDir: config.dataDir,
      accountDir,
      sessionId,
      repoRoot: config.root,
      nodePath: process.execPath,
      toolsSocketPath: config.socketPath,
      hiddenExtra: [config.root, config.dataDir, join(accountDir, 'transcripts')]
    });
    return {
      workspace: sample.paths.root,
      cwd: sample.paths.root,
      memory: join(sample.paths.root, 'memory'),
      skills: join(sample.paths.root, 'skills'),
      observations: join(sample.paths.root, 'observations'),
      downloads: join(sample.paths.root, 'downloads')
    };
  };

  const runner = new AgentRunner({
    config,
    store,
    services,
    registry,
    runner: commandRunner,
    model,
    workspacePaths,
    onEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
    onTaskComplete: (session, text) => delegation.onTaskComplete(session, text)
  });
  delegation['deps'].runner = runner;

  const ensureMainSession = (channel: string | null = 'console'): SessionRecord => {
    const existing = store.sessionsForAccount(account.id, 50).find((s) => s.kind === 'main');
    if (existing) return existing;
    return store.createSession({ kind: 'main', role: 'main_agent', accountId: account.id, channel, title: 'Main session', modelMode: 'smart' });
  };

  const runSession = async (sessionId: string, cause: WakeCause, payload: Record<string, unknown> = {}, text?: string): Promise<RunResult> =>
    runner.run({ sessionId, cause, payload, text });

  const runQueue = async (onlySessionId?: string): Promise<number> => {
    let executed = 0;
    for (const wake of store.dueWakes(Date.now(), 20)) {
      if (onlySessionId && wake.sessionId !== onlySessionId) continue;
      if (runner.isRunning(wake.sessionId)) continue;
      const session = store.get(wake.sessionId);
      if (!session) {
        store.markWake(wake.id, 'expired', 'session missing');
        continue;
      }
      store.markWake(wake.id, 'delivered');
      const text = wake.cause === 'user_message' ? String(wake.payload['text'] ?? wake.payload['task'] ?? '') : undefined;
      log.info('wake delivered', { session: wake.sessionId, wake: wake.id, cause: wake.cause, source: wake.source });
      try {
        await runner.run({ sessionId: wake.sessionId, cause: wake.cause, payload: wake.payload, text });
      } catch (err) {
        store.append(wake.sessionId, 'error', { message: err instanceof Error ? err.message : String(err) });
        log.error('run failed', { session: wake.sessionId, cause: wake.cause, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : null });
      }
      executed += 1;
    }
    return executed;
  };

  const toolsServer = new ToolsServer({
    config,
    db,
    registry,
    verifyToken,
    servicesFor: (sessionId, acctId) => {
      const session = store.get(sessionId);
      if (!session || session.accountId !== acctId) return null;
      return { services, session, account, flags };
    }
  });

  let timer: NodeJS.Timeout | null = null;
  let listening = false;

  const bundle: RuntimeBundle = {
    config,
    db,
    store,
    registry,
    account,
    flags,
    services,
    runner,
    wakes,
    delegation,
    accountDir,
    ensureMainSession,
    submitUserMessage: async (text, opts = {}) => {
      const session = opts.sessionId ? store.get(opts.sessionId) ?? ensureMainSession(opts.channel ?? 'console') : ensureMainSession(opts.channel ?? 'console');
      store.append(session.id, 'user_message', { text, channel: opts.channel ?? session.channel });
      const wake = store.enqueueWake({ sessionId: session.id, cause: 'user_message', source: opts.channel ?? 'console', payload: { text } });
      store.markWake(wake.id, 'delivered');
      return runner.run({ sessionId: session.id, cause: 'user_message', payload: { source: opts.channel ?? 'console' }, text });
    },
    runSession,
    ingestEvent: (source, payload) => wakes.ingestEvent(source, payload),
    bash: (sessionId, command, opts = {}) =>
      commandRunner.run({
        command,
        timeoutMs: opts.timeoutMs ?? config.bashTimeoutMs,
        sessionId,
        accountId: account.id,
        stdin: opts.stdin
      }),
    runDueWakes: async () => {
      await wakes.tick({ contextFor: (sessionId) => store.events(sessionId, { limit: 20 }).map((e) => String(e.data['text'] ?? '')).join('\n') });
      return runQueue();
    },
    waitForQuiet: async (opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const pollMs = opts.pollMs ?? 400;
      const deadline = Date.now() + timeoutMs;
      let iterations = 0;
      while (Date.now() < deadline) {
        iterations += 1;
        await runQueue();
        const due = store.dueWakes(Date.now());
        const running = store
          .sessionsForAccount(account.id, 200)
          .some((s) => runner.isRunning(s.id));
        if (!running && due.length === 0) return { settled: true, iterations, pendingWakes: 0 };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return { settled: false, iterations, pendingWakes: store.dueWakes(Date.now()).length };
    },
    start: async () => {
      if (options.listen !== false && !listening) {
        await toolsServer.start();
        listening = true;
      }
      if (!timer) {
        timer = setInterval(() => {
          void bundle.runDueWakes();
        }, 5000);
        timer.unref?.();
      }
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (listening) {
        await toolsServer.stop();
        listening = false;
      }
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    events: (sessionId, sinceSeq) => store.events(sessionId, { sinceSeq })
  };

  return bundle;
}

/** Convenience wrapper used by the tools CLI when no daemon is running. */
export async function bootstrapDirect(input: { sessionId: string; accountId: string }) {
  const bundle = await createRuntime({ accountId: input.accountId, listen: false, offlineSearch: process.env.DORA_OFFLINE === '1' });
  const session = bundle.store.get(input.sessionId) ?? bundle.store.createSession({
    kind: 'main',
    role: 'main_agent',
    accountId: bundle.account.id,
    channel: 'console',
    title: 'Direct CLI session',
    modelMode: 'smart'
  });
  bundle.store.update(session.id, {});
  return {
    session,
    account: bundle.account,
    flags: bundle.flags,
    services: bundle.services,
    config: bundle.config,
    db: bundle.db,
    registry: bundle.registry
  };
}

function ensureAccount(db: Db, input: AccountRef): AccountRef {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.id) as Record<string, unknown> | undefined;
  if (row) {
    return {
      id: String(row['id']),
      handle: String(row['handle']),
      displayName: String(row['display_name']),
      email: input.email,
      phone: input.phone,
      timezone: input.timezone
    };
  }
  db.prepare('INSERT INTO accounts (id, handle, display_name, created_at, metadata) VALUES (?, ?, ?, ?, ?)').run(
    input.id, input.handle, input.displayName, Date.now(), JSON.stringify({ email: input.email, phone: input.phone, timezone: input.timezone })
  );
  return input;
}

function loadFlags(db: Db, accountId: string): FlagMap {
  const flags = defaultFlags();
  const rows = db.prepare('SELECT name, enabled FROM flags WHERE account_id = ?').all(accountId) as { name: string; enabled: number }[];
  for (const row of rows) flags[row.name] = row.enabled === 1;
  return flags;
}

function createModel(config: DoraConfig): DoraServices['model'] {
  const backend = resolveModelBackend();
  if (backend.provider === 'openai' && backend.hit) {
    return new OpenAiCompatibleProvider({
      baseUrl: backend.hit.baseUrl,
      apiKey: backend.hit.apiKey,
      timeoutMs: config.model.requestTimeoutMs,
      maxRetries: config.model.maxRetries,
      maxOutputTokens: config.model.maxOutputTokens
    });
  }
  if (backend.provider === 'openai' && !backend.hit) {
    createLogger('runtime').warn('a live model was requested but no credential was found; falling back to the offline mock', {
      considered: backend.considered.map((c) => c.source + (c.found ? ' (found, unusable)' : ' (absent)'))
    });
  }
  return new MockModelProvider({ heuristics: true });
}

/** Seed a small memory repo so recall has something real to inject. */
function seedMemory(memory: MemoryStore, account: AccountRef): void {
  const now = new Date();
  memory.write(
    'knowledge/preferences/communication-style.md',
    'The member prefers short messages, answers first and context second, and a receipt at the end of every piece of work.\n\nThey write in English and Chinese; match whichever language they used last in that thread.\n',
    { id: 'communication-style', type: 'preference', aliases: ['tone', 'im-style'] }
  );
  memory.write(
    'entities/people/alex.md',
    'Alex runs the weekly sync and owns the pilot timeline.\n\n- iMessage handle: +14155550123 (his thread is the one with the dinner and planning messages).\n- Prefers decisions in writing before a call.\n- Asked for the pilot scope by Friday.\n',
    { id: 'alex', type: 'person', aliases: ['Alex Chen'] }
  );
  memory.write(
    'workstreams/active/q3-planning.md',
    'Status: waiting on the headcount section review.\n\nNext: comment on the planning doc before Thursday standup, then send Alex the scope.\n',
    { id: 'q3-planning', type: 'workstream', aliases: ['planning'] }
  );
  memory.write(
    'knowledge/facts/travel.md',
    'Flight ZQ8K2P: SFO to JFK, departs 07:40 on the 14th. One carry-on included.\n',
    { id: 'travel-flight', type: 'fact', aliases: ['flight'] }
  );
  memory.write('timeline/raw/' + now.toISOString().slice(0, 13) + '-00.md', '- 09:12 member asked for the planning doc review\n- 09:40 reminders set for the dentist\n', {
    id: 'raw-' + now.toISOString().slice(0, 13),
    type: 'observation'
  });
  memory.commit('seed memory for ' + account.handle);
}

export { readFileSync, writeFileSync, existsSync, join, ulid, renderRecallBlock, selectRecallSnippets, type ToolResult };
