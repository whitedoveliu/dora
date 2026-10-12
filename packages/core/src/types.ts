/** Domain types shared by every Dora.ai package. */

export type AgentRole = 'main_agent' | 'task_agent';
export type SessionKind = 'main' | 'task';
export type SessionStatus = 'running' | 'held' | 'completed' | 'failed';
export type ModelMode = 'fast' | 'smart';

/** The four wake sources of the runtime. */
export type WakeCause =
  | 'user_message'
  | 'schedule'
  | 'subscription'
  | 'task_report'
  | 'safety_check_in';

export interface SessionRecord {
  id: string;
  kind: SessionKind;
  role: AgentRole;
  accountId: string;
  parentId: string | null;
  channel: string | null;
  status: SessionStatus;
  modelMode: ModelMode;
  title: string;
  createdAt: number;
  updatedAt: number;
  heldReason: string | null;
  metadata: Record<string, unknown>;
}

export type EventType =
  | 'session_started'
  | 'user_message'
  | 'wake'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'compaction'
  | 'recall'
  | 'delegation'
  | 'report'
  | 'hold'
  | 'error'
  | 'budget'
  | 'system';

export interface AgentEvent {
  id: string;
  sessionId: string;
  seq: number;
  ts: number;
  type: EventType;
  data: Record<string, unknown>;
}

export interface Attachment {
  name: string;
  kind: 'help_page' | 'file' | 'json' | 'media';
  mime: string;
  content: string;
  truncated: boolean;
}

export interface Interrupt {
  cause: 'timeout' | 'signal' | 'blocked' | 'delivered_code';
  detail: string;
}

export interface ToolResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  attachments: Attachment[];
  overflowPath: string | null;
  durationMs: number;
  interrupt: Interrupt | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  /** Set on a tool result: the id of the call it answers. */
  toolCallId?: string;
  /** Set on an assistant turn that requested tools; providers must echo it back verbatim. */
  toolCalls?: ModelToolCall[];
  /** Reasoning text some providers return beside the content; logged, never replayed. */
  reasoning?: string;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelResponse {
  content: string;
  toolCalls: ModelToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  meta: Record<string, unknown>;
}

export interface ToolContractRef {
  path: string;
  family: string;
  name: string;
}

export interface PendingWake {
  id: string;
  sessionId: string;
  cause: WakeCause;
  source: string;
  payload: Record<string, unknown>;
  dueAt: number;
  state: 'pending' | 'delivered' | 'skipped' | 'expired';
  createdAt: number;
  deliveredAt: number | null;
  skipReason: string | null;
}

export interface Todo {
  id: string;
  accountId: string;
  sessionId: string | null;
  title: string;
  status: 'open' | 'done' | 'dropped';
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  notes: string;
}

export interface HelpGateBlock {
  blocked: true;
  actions: string[];
  pages: Attachment[];
}
