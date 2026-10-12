import { createLogger } from '@dora/core';
import {
  buildActionSpace, buildSystemPrompt, compact, estimateTokens, renderRecallBlock, selectRecallSnippets,
  type AgentEvent, type Attachment, type ChatMessage, type DoraConfig, type DoraServices, type ModelToolSpec,
  type SessionRecord, type ToolResult, type WakeCause
} from '@dora/core';
import type { ModelProvider } from '@dora/core';
import { renderToolIndex, type ToolRegistry } from '@dora/tools';
import type { SessionStore } from './store.ts';

/** Anything that can run one shell command for a session. */
export interface CommandRunner {
  run(request: { command: string; timeoutMs: number; sessionId: string; accountId: string; stdin?: string }): Promise<ToolResult>;
}

/**
 * The agent loop.
 *
 * A run is: wake -> memory recall injection -> model turn -> (bash | hold) -> ... -> hold.
 * The model gets exactly two base commands. Everything else — mail, calendar, the rented
 * browser, delegating a task agent, scheduling a wake — is a tools CLI call made from
 * inside bash, which is what makes the tool layer dynamic instead of baked into the
 * prompt.
 */
export const BASE_TOOLS: ModelToolSpec[] = [
  {
    name: 'bash',
    description: [
      'Execute a shell command in the sandbox, including the tools CLI.',
      'One call is limited to 45 seconds. Two content filters apply: a shell-expandable $ that looks like an amount is refused, and a multi-line quoted argument must instead be passed with --<option>-stdin and a heredoc.',
      'Output is capped by a budget; over budget you get the numbers, a preview and a path to read the full text from.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to run.' } },
      required: ['command']
    }
  },
  {
    name: 'hold',
    description: 'Suspend the current turn while waiting for a lock, an event or a wake. Returns "Turn ended."',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why the turn is ending.' } },
      required: []
    }
  }
];

export interface AgentDeps {
  config: DoraConfig;
  store: SessionStore;
  services: DoraServices;
  registry: ToolRegistry;
  runner: CommandRunner;
  model: ModelProvider;
  /** Real sandbox paths for a session; the prompt must never advertise a preview path. */
  workspacePaths: (sessionId: string) => Record<string, string>;
  onEvent?: (event: AgentEvent) => void;
  /** Called when a task agent finishes, so the parent can be woken. */
  onTaskComplete?: (session: SessionRecord, text: string) => Promise<void>;
}

export interface RunResult {
  status: 'held' | 'completed' | 'failed';
  turns: number;
  text: string;
  error?: string;
}

export class AgentRunner {
  private readonly deps: AgentDeps;
  private readonly running = new Set<string>();
  private readonly log = createLogger('runtime');

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  private emit(event: AgentEvent): void {
    this.deps.onEvent?.(event);
  }

  private append(sessionId: string, type: AgentEvent['type'], data: Record<string, unknown>): AgentEvent {
    const event = this.deps.store.append(sessionId, type, data);
    this.emit(event);
    return event;
  }

  /** Render a tool result for the model, attachments included. */
  static renderToolResult(result: ToolResult): string {
    const parts: string[] = [];
    parts.push('exit_code: ' + result.exitCode);
    if (result.stdout.trim()) parts.push('stdout:\n' + result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push('stderr:\n' + result.stderr.trimEnd());
    if (result.overflowPath) parts.push('full_output: ' + result.overflowPath);
    if (result.interrupt) parts.push('<interrupt_cause>' + result.interrupt.cause + '</interrupt_cause>');
    for (const attachment of result.attachments) {
      parts.push(renderAttachment(attachment));
    }
    return parts.join('\n');
  }

  async run(input: { sessionId: string; cause: WakeCause; payload?: Record<string, unknown>; text?: string }): Promise<RunResult> {
    const session = this.deps.store.get(input.sessionId);
    if (!session) throw new Error('no session ' + input.sessionId);
    if (this.running.has(session.id)) return { status: 'held', turns: 0, text: '(already running)' };
    this.running.add(session.id);
    try {
      return await this.runInner(session, input.cause, input.payload ?? {}, input.text);
    } finally {
      this.running.delete(session.id);
    }
  }

  private async runInner(session: SessionRecord, cause: WakeCause, payload: Record<string, unknown>, text?: string): Promise<RunResult> {
    const { store, services, config } = this.deps;
    store.update(session.id, { status: 'running' });
    this.append(session.id, 'wake', { cause, source: payload['source'] ?? 'runtime', payload });

    const model = session.modelMode === 'smart' ? config.model.smart : config.model.main;
    const messages = this.buildMessages(session, cause, payload, text);
    let turns = 0;
    let finalText = '';
    let inputTokensSpent = 0;
    let emptyResponses = 0;

    for (let turn = 0; turn < config.model.maxTurns; turn += 1) {
      // Compaction before the context gets too large.
      const contextTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
      if (contextTokens > config.model.contextBudgetTokens) {
        const summary = await compact({ events: store.events(session.id) }, async (prompt) => {
          const response = await this.deps.model.complete({ model: config.model.fast, messages: [{ role: 'user', content: prompt }], purpose: 'compaction' });
          return response.content;
        });
        this.append(session.id, 'compaction', { summary, sections: 8, context_tokens: contextTokens });
        // Compaction replaces the conversation, never the instructions: dropping the system
        // prompt leaves the model with no role, no action index and no rules.
        const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;
        messages.length = 0;
        if (systemMessage) messages.push(systemMessage);
        messages.push({ role: 'user', content: '<session_compaction>\n' + summary + '\n</session_compaction>' });
      }

      turns += 1;
      if (inputTokensSpent > config.model.runInputTokenBudget) {
        // A run that keeps re-reading its own context is a loop, not work: end it with a
        // reason the member and the logs can both see.
        this.append(session.id, 'error', {
          message: 'run input budget exhausted',
          input_tokens: inputTokensSpent,
          budget: config.model.runInputTokenBudget,
          turns
        });
        this.log.warn('run stopped: input budget exhausted', {
          session: session.id,
          input_tokens: inputTokensSpent,
          budget: config.model.runInputTokenBudget,
          turns
        });
        return this.finish(session, 'completed', turns, finalText || '(stopped: this run read more context than the budget allows)');
      }

      const response = await this.deps.model.complete({ model, messages, tools: BASE_TOOLS, purpose: 'agent' });
      inputTokensSpent += response.usage.inputTokens;
      store.recordUsage(session.accountId, (response.usage.inputTokens + response.usage.outputTokens) / 1000);
      this.append(session.id, 'assistant_message', {
        text: response.content,
        usage: response.usage,
        model,
        tool_calls: response.toolCalls.map((c) => c.name),
        reasoning: response.meta?.['reasoning'] ?? null
      });
      this.log.info('model turn', {
        turn,
        model,
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        tool_calls: response.toolCalls.length,
        duration_ms: response.meta?.['durationMs'] ?? null,
        text_preview: response.content.slice(0, 160)
      });
      // Echo the assistant turn including its tool calls: a strict provider rejects a
      // tool result whose originating call it cannot see.
      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined });
      if (response.content.trim()) finalText = response.content.trim();

      if (response.toolCalls.length === 0) {
        if (response.content.trim() === '') {
          // A silent completion used to end the run with nothing said to the member.
          emptyResponses += 1;
          this.append(session.id, 'error', { message: 'model returned an empty turn', attempt: emptyResponses });
          this.log.warn('empty model turn', { session: session.id, turn, attempt: emptyResponses });
          if (emptyResponses === 1) {
            messages.push({
              role: 'user',
              content:
                'Your last turn was empty. Either take the next concrete action with bash, or answer the member and end with hold.'
            });
            continue;
          }
          return this.finish(session, 'held', turns, finalText || 'Turn ended.');
        }
        return this.finish(session, 'completed', turns, finalText);
      }

      for (const call of response.toolCalls) {
        const args = safeParse(call.arguments);
        if (call.name === 'hold') {
          const reason = String(args['reason'] ?? 'hold requested');
          this.append(session.id, 'hold', { reason, result: 'Turn ended.' });
          return this.finish(session, 'held', turns, finalText || 'Turn ended.');
        }
        if (call.name !== 'bash') {
          messages.push({ role: 'tool', toolCallId: call.id, content: 'unknown command: ' + call.name + '; only bash and hold are available' });
          this.append(session.id, 'tool_result', { command: call.name, ok: false, stdout: '', stderr: 'unknown command' });
          continue;
        }
        const command = String(args['command'] ?? '');
        this.append(session.id, 'tool_call', { command });
        this.log.info('bash call', { session: session.id, command: command.slice(0, 400) });
        let result: ToolResult;
        try {
          result = await this.deps.runner.run({
            command,
            timeoutMs: config.bashTimeoutMs,
            sessionId: session.id,
            accountId: session.accountId
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = { ok: false, exitCode: 2, stdout: '', stderr: message, attachments: [], overflowPath: null, durationMs: 0, interrupt: { cause: 'blocked', detail: message } };
        }
        this.append(session.id, 'tool_result', {
          command,
          exit_code: result.exitCode,
          ok: result.ok,
          stdout: clip(result.stdout, 100_000),
          stderr: clip(result.stderr, 20_000),
          attachments: result.attachments.map((a) => ({ name: a.name, kind: a.kind, mime: a.mime, bytes: a.content.length })),
          overflow_path: result.overflowPath,
          duration_ms: result.durationMs
        });
        this.log.info('bash result', {
          session: session.id,
          exit_code: result.exitCode,
          duration_ms: result.durationMs,
          attachments: result.attachments.map((a) => a.name),
          interrupt: result.interrupt?.cause ?? null,
          stdout_preview: result.stdout.slice(0, 200)
        });
        messages.push({ role: 'tool', toolCallId: call.id, content: AgentRunner.renderToolResult(result) });
      }
    }

    this.append(session.id, 'error', { message: 'turn budget exhausted', turns });
    return this.finish(session, 'completed', turns, finalText || '(turn budget exhausted)');
  }

  private finish(session: SessionRecord, status: 'held' | 'completed', turns: number, text: string): RunResult {
    this.deps.store.update(session.id, { status: status === 'held' ? 'held' : 'completed', heldReason: status === 'held' ? 'hold' : null });
    if (session.kind === 'task' && this.deps.onTaskComplete) {
      void this.deps.onTaskComplete(session, text);
    }
    return { status, turns, text };
  }

  private buildMessages(session: SessionRecord, cause: WakeCause, payload: Record<string, unknown>, text?: string): ChatMessage[] {
    const { services, config, registry } = this.deps;
    const index = registry.index((c) => services.connectors.isConnected(c));
    const modeByTrait = new Map(buildActionSpace(session.role, services.flags).map((row) => [row.trait, row.mode]));
    const actionSpace = buildActionSpace(session.role, services.flags);
    const system = buildSystemPrompt({
      role: session.role,
      flags: services.flags,
      actionSpace,
      toolIndex: renderToolIndex(index, {
        role: session.role,
        modeForTrait: (trait) => modeByTrait.get(trait as never) ?? 'unavailable'
      }),
      memberName: services.account.displayName || services.account.handle,
      contactInfo: services.account.email + ' / ' + services.account.phone,
      channel: session.channel,
      nowIso: new Date().toISOString(),
      timezone: services.account.timezone,
      workspacePaths: this.deps.workspacePaths(session.id),
      skills: services.skills.list(session.role).map((s) => ({ id: s.id, description: s.description }))
    });

    const messages: ChatMessage[] = [{ role: 'system', content: system }];

    const compaction = this.deps.store.latestCompaction(session.id);
    if (compaction) {
      messages.push({ role: 'user', content: '<session_compaction>\n' + String(compaction.data['summary'] ?? '') + '\n</session_compaction>' });
    }

    const recent = this.deps.store.events(session.id, { limit: 200 }).filter((e) => e.seq > (compaction?.seq ?? 0));
    const history = recent
      .filter((e) => e.type === 'user_message' || e.type === 'assistant_message' || e.type === 'report')
      .slice(-30)
      .map<ChatMessage>((e) => ({
        role: e.type === 'assistant_message' ? 'assistant' : 'user',
        content: String(e.data['text'] ?? '')
      }));
    messages.push(...history);

    // memory_recall injection, at the start of every run.
    const snippets = selectRecallSnippets(
      services.memory.recent(20).map((f) => ({ path: f.path, id: f.id, type: f.type, body: f.body, lastModified: f.lastModified })),
      { limit: 6, query: text ?? '' }
    );
    const recall = renderRecallBlock(snippets);
    this.append(session.id, 'recall', { paths: snippets.map((s) => s.path), snippets: snippets.length });
    messages.push({ role: 'user', content: recall });

    const wakeLine = describeWake(cause, payload, text);
    messages.push({ role: 'user', content: wakeLine });
    if (cause === 'user_message' && text) this.append(session.id, 'user_message', { text, channel: session.channel });
    void config;
    return messages;
  }
}

function describeWake(cause: WakeCause, payload: Record<string, unknown>, text?: string): string {
  switch (cause) {
    case 'user_message':
      return text ? 'The member wrote:\n' + text : 'The member wrote something that was not captured.';
    case 'schedule':
      return 'You were woken by your own schedule. Instruction for this wake: ' + String(payload['prompt'] ?? '(none)');
    case 'subscription':
      return 'An event you subscribed to fired: ' + JSON.stringify(payload) + '. Decide whether the member needs to hear about it.';
    case 'safety_check_in':
      return 'This is the automatic safety check-in for a silent subscription: audit whether the subscription still earns its keep, then unsubscribe or keep it.';
    case 'task_report':
      return (
        'A task agent reported back:\n' + String(payload['report'] ?? text ?? '') +
        '\n\nAct on this report now: finish the member-facing work it enables (durable todos, the answer, any proposed write),' +
        ' then hold. Do not re-investigate what the report already establishes, and do not re-read the sources it cites.'
      );
  }
}

function renderAttachment(attachment: Attachment): string {
  const head = '<attachment name="' + attachment.name + '" kind="' + attachment.kind + '" mime="' + attachment.mime + '">';
  return head + '\n' + attachment.content + '\n</attachment>';
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\n…[clipped at ' + max + ' chars]' : text;
}

function safeParse(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
