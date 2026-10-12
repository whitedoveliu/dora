import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentEvent, Attachment, Db, DoraConfig, DoraServices, ModelMode, SessionRecord } from '@dora/core';
import { HelpGate, renderHelpPage, renderToolIndex, type ToolRegistry } from '@dora/tools';
import type { Workspace } from '@dora/sandbox';
import type { SessionStore } from './store.ts';
import type { WakeManager, WakeSpec } from './wakes.ts';
import type { AgentRunner } from './agent.ts';

/**
 * Delegation and lifecycle.
 *
 * tasks.delegate creates a task agent whose opening package is three things:
 * memory recall snippets, the task text, and roughly fifteen pre-injected help
 * pages. Because those pages count as read, the Help gate does not block the task
 * agent's first calls. The task agent reports back with agent_message.send and holds;
 * the parent owns cleanup and receives the result, never the trail.
 */
export interface DelegationDeps {
  config: DoraConfig;
  db: Db;
  store: SessionStore;
  registry: ToolRegistry;
  services: DoraServices;
  wakes: WakeManager;
  runner: AgentRunner;
  workspaceFor: (sessionId: string) => Workspace;
  defaultPages: string[];
  onTaskRun?: (sessionId: string) => void;
}

export interface DelegateInput {
  parentSessionId: string;
  task: string;
  modelMode: ModelMode;
  name?: string;
  attachments?: string[];
  includeConversationContext?: boolean;
  start?: 'now' | 'queued';
  schedule?: WakeSpec;
  neverExpire?: boolean;
}

export class DelegationManager {
  private readonly deps: DelegationDeps;

  constructor(deps: DelegationDeps) {
    this.deps = deps;
  }

  async delegate(input: DelegateInput): Promise<{ taskSessionId: string }> {
    const parent = this.deps.store.get(input.parentSessionId);
    if (!parent) throw new Error('no parent session ' + input.parentSessionId);
    const task = this.deps.store.createSession({
      kind: 'task',
      role: 'task_agent',
      accountId: parent.accountId,
      parentId: parent.id,
      channel: null,
      title: input.name ?? input.task.slice(0, 60),
      modelMode: input.modelMode,
      metadata: {
        task: input.task,
        never_expire: input.neverExpire ?? false,
        include_conversation_context: input.includeConversationContext ?? false,
        standing: input.schedule ?? null
      }
    });

    // Attachments land in the task agent's private filesystem.
    const workspace = this.deps.workspaceFor(task.id);
    workspace.ensure();
    const copied: string[] = [];
    for (const file of input.attachments ?? []) {
      if (!existsSync(file)) continue;
      const target = join(workspace.paths.work, basename(file));
      mkdirSync(workspace.paths.work, { recursive: true });
      copyFileSync(file, target);
      copied.push(target);
    }

    const opening = this.openingPackage(task, input.task, copied);
    // Pre-injected pages count as read, so the task agent's first calls are not blocked.
    new HelpGate(this.deps.db).markRead(task.id, this.deps.defaultPages.filter((p) => this.deps.registry.get(p) !== null));
    this.deps.store.append(task.id, 'user_message', { text: opening, source: 'delegation' });
    this.deps.store.append(parent.id, 'delegation', { task_session_id: task.id, name: task.title, model_mode: input.modelMode, attachments: copied.length });

    if (input.schedule) {
      this.deps.wakes.create(task.id, { ...input.schedule, prompt: input.schedule.prompt || input.task.slice(0, 200) });
    }

    this.deps.store.enqueueWake({ sessionId: task.id, cause: 'user_message', source: 'delegation', payload: { task: input.task } });
    if ((input.start ?? 'now') === 'now') {
      this.deps.onTaskRun?.(task.id);
    }
    return { taskSessionId: task.id };
  }

  /**
   * Opening package: memory recall + task text + about fifteen pre-injected help pages.
   * The pages are also marked read, so the gate lets the first call through.
   */
  openingPackage(task: SessionRecord, taskText: string, attachments: string[]): string {
    const pages = this.deps.defaultPages
      .map((path) => {
        const action = this.deps.registry.get(path);
        return action ? renderHelpPage(action) : null;
      })
      .filter((p): p is string => p !== null);
    const lines = [
      'You are a task agent. Your parent spawned you for the job below. When the job is done, report back with',
      '`tools agent_message send --body ...` and hold. Your parent owns cleanup.',
      '',
      '## Job',
      taskText,
      ''
    ];
    if (attachments.length > 0) {
      lines.push('## Files handed to you (in your workspace)');
      for (const file of attachments) lines.push('- ' + file);
      lines.push('');
    }
    const parent = task.parentId ? this.deps.store.get(task.parentId) : null;
    if (parent && parent.metadata['include_conversation_context']) {
      const tail = this.deps.store
        .events(parent.id, { limit: 50 })
        .filter((e) => e.type === 'user_message' || e.type === 'assistant_message')
        .slice(-6)
        .map((e) => String(e.data['text'] ?? '').slice(0, 400));
      lines.push('## Recent conversation tail');
      lines.push(...tail.map((t) => '- ' + t.replace(/\n/g, ' ')));
      lines.push('');
    }
    lines.push('## Pre-loaded tool contracts (' + pages.length + ' pages)');
    lines.push(...pages);
    return lines.join('\n');
  }

  listTasks(sessionId: string): Record<string, unknown>[] {
    const session = this.deps.store.get(sessionId);
    if (!session) return [];
    const children = session.kind === 'task' ? (session.parentId ? this.deps.store.children(session.parentId) : []) : this.deps.store.children(session.id);
    return children.map((child) => ({
      id: child.id,
      name: child.title,
      status: child.status,
      model_mode: child.modelMode,
      created_at: child.createdAt
    }));
  }

  taskStatus(sessionId: string, taskId: string): Record<string, unknown> | null {
    const task = this.deps.store.get(taskId);
    if (!task) return null;
    const session = this.deps.store.get(sessionId);
    const related =
      task.id === sessionId ||
      task.parentId === sessionId ||
      (session?.parentId !== null && session?.parentId !== undefined && task.parentId === session.parentId);
    if (!related) return null;
    const reports = this.deps.store
      .events(task.id, { limit: 500 })
      .filter((e) => e.type === 'report')
      .map((e) => String(e.data['body'] ?? ''));
    return {
      id: task.id,
      status: task.status,
      name: task.title,
      model_mode: task.modelMode,
      last_report: reports.length > 0 ? reports[reports.length - 1] : null,
      created_at: task.createdAt
    };
  }

  cancelTask(sessionId: string, taskId: string): boolean {
    const task = this.deps.store.get(taskId);
    if (!task || task.parentId !== sessionId) return false;
    this.deps.store.update(taskId, { status: 'failed', heldReason: 'cancelled by parent' });
    this.deps.store.append(taskId, 'error', { message: 'cancelled by parent', by: sessionId });
    return true;
  }

  /** agent_message.send: results only, never the trail or the filesystem. */
  async sendToParent(sessionId: string, body: string, attachments: string[] = []): Promise<{ delivered: boolean }> {
    const task = this.deps.store.get(sessionId);
    if (!task || !task.parentId) return { delivered: false };
    this.deps.store.append(task.id, 'report', { body, attachments: attachments.map((a) => basename(a)) });
    this.deps.store.enqueueWake({
      sessionId: task.parentId,
      cause: 'task_report',
      source: 'task_agent',
      payload: { task_session_id: task.id, report: body, attachments: attachments.map((a) => basename(a)) }
    });
    return { delivered: true };
  }

  /** Called by the agent runner when a task agent finishes its turn. */
  async onTaskComplete(session: SessionRecord, text: string): Promise<void> {
    const reported = this.deps.store.events(session.id, { limit: 500 }).some((e) => e.type === 'report');
    if (!reported && text.trim()) await this.sendToParent(session.id, text.trim());
    const neverExpire = session.metadata['never_expire'] === true;
    if (!neverExpire) this.deps.store.update(session.id, { status: 'held', heldReason: 'job done' });
  }

  /** Build the ~15 pages a task agent needs to start working without a gate block. */
  static defaultPageSet(registry: ToolRegistry): string[] {
    const preferred = [
      'search.search', 'web_search.search', 'web_fetch.fetch', 'read.read',
      'observations.sql', 'observations.fetch', 'vault.fill',
      'cloud_browser_scheduler.acquire', 'cloud_browser_scheduler.release',
      'cloud_browser.open', 'cloud_browser.snapshot', 'cloud_browser.click',
      'cloud_browser.type', 'cloud_browser.read', 'cloud_browser.current-url',
      'browser_guidance.search', 'agent_message.send', 'wake_schedule.create', 'wake_subscription.subscribe'
    ];
    const available = preferred.filter((p) => registry.get(p) !== null);
    return available.slice(0, 15);
  }

  renderIndexLines(): string {
    return renderToolIndex(this.deps.registry.index((c) => this.deps.services.connectors.isConnected(c)));
  }

  eventsFor(sessionId: string): AgentEvent[] {
    return this.deps.store.events(sessionId, { limit: 1000 });
  }

  attachmentsFor(sessionId: string): Attachment[] {
    return this.deps.store
      .events(sessionId, { limit: 1000 })
      .filter((e) => e.type === 'tool_result')
      .flatMap((e) => (e.data['attachments'] as Attachment[] | undefined) ?? []);
  }
}
