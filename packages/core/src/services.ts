import type { Attachment, ModelResponse, ChatMessage, SessionRecord, Todo, PendingWake, WakeCause, ModelMode } from './types.ts';
import type { FlagMap } from './flags.ts';

/**
 * Service seams. Every subsystem is declared here as an interface so the tools CLI,
 * the runtime and the HTTP control plane can be assembled without import cycles, and
 * so a subsystem can be swapped for a hosted implementation at one boundary.
 */

export interface AccountRef {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  phone: string;
  timezone: string;
}

export interface MemoryFile {
  path: string;
  id: string;
  type: string;
  aliases: string[];
  body: string;
  lastModified: number;
}

export interface MemoryService {
  list(): MemoryFile[];
  read(path: string): MemoryFile | null;
  write(path: string, body: string, frontmatter?: Record<string, unknown>): MemoryFile;
  search(query: string): MemoryFile[];
  /** Recent files by last_modified — the memory_recall selector. */
  recent(limit: number): MemoryFile[];
  commit(message: string): string | null;
}

export interface ObservationRow {
  [column: string]: unknown;
}

export interface ObservationsService {
  sql(query: string): { columns: string[]; rows: ObservationRow[]; truncated: boolean; ms: number };
  fetch(path: string): { path: string; content: string; mime: string } | null;
  ingest(source: string, records: Record<string, unknown>[]): number;
  sources(): { source: string; rows: number; lastIngest: number | null }[];
}

export interface VaultItemSummary {
  id: string;
  label: string;
  kind: 'password' | 'card' | 'address' | 'phone' | 'identity' | 'note';
  updatedAt: number;
  fields: string[];
}

export interface VaultService {
  /** Never returns a secret value. */
  list(): VaultItemSummary[];
  status(id: string): VaultItemSummary | null;
  /** Creates a single-use fill link the member opens outside the chat channel. */
  createFillLink(input: { label: string; kind: VaultItemSummary['kind']; fields: string[]; ttlMinutes?: number }): { token: string; url: string; expiresAt: number };
  submitFill(token: string, values: Record<string, string>): VaultItemSummary;
  /** Places a secret into a browser field; the model only learns that it happened. */
  fill(itemId: string, target: { site: string; field: string }): { filled: true; itemId: string; fields: number };
  remove(id: string): boolean;
  touchNote(id: string, note: string): VaultItemSummary | null;
}

export interface ConnectorAccount {
  id: string;
  connector: string;
  label: string;
  isDefault: boolean;
  createdAt: number;
  authKind: 'fixture' | 'token' | 'password' | 'none';
}

export interface ConnectorDescriptor {
  name: string;
  title: string;
  /** Actions declared for this connector in the static catalogue. */
  declaredActions: number;
  implementedActions: number;
  authKind: ConnectorAccount['authKind'];
  description: string;
}

export interface ConnectorRecord {
  id: string;
  connector: string;
  accountId: string;
  kind: string;
  externalId: string;
  title: string;
  body: string;
  ts: number;
  metadata: Record<string, unknown>;
}

export interface ConnectorRegistry {
  list(): ConnectorDescriptor[];
  /** Local records backing a connector family (fixture-backed in this build). */
  records(connector: string, kind: string, options?: { query?: string; limit?: number; accountId?: string; since?: number; externalId?: string }): ConnectorRecord[];
  put(connector: string, kind: string, record: Partial<ConnectorRecord> & { title?: string }): ConnectorRecord;
  accounts(connector?: string): ConnectorAccount[];
  addAccount(connector: string, label: string, credentials?: Record<string, string>): ConnectorAccount;
  disconnectAccount(id: string): boolean;
  defaultAccount(connector: string): ConnectorAccount | null;
  isConnected(connector: string): boolean;
}

export interface BrowserLease {
  id: string;
  sessionId: string;
  kind: 'read' | 'write';
  createdAt: number;
  expiresAt: number;
  site: string | null;
}

export interface BrowserService {
  acquire(input: { sessionId: string; kind: 'read' | 'write'; site?: string; guidanceToken?: string; ttlMinutes?: number }): BrowserLease;
  release(leaseId: string, sessionId: string): boolean;
  extend(leaseId: string, sessionId: string, minutes: number): BrowserLease;
  status(leaseId: string): BrowserLease | null;
  leases(): BrowserLease[];
  drive(leaseId: string, command: Record<string, unknown>): Promise<{ ok: boolean; stdout: string; attachment?: Attachment }>;
  guidance: {
    search(input: { site: string; flow?: string }): { token: string; entries: { id: string; site: string; flow: string; outcome: string; notes: string }[] } | null;
    record(input: { site: string; flow: string; outcome: 'success' | 'failure'; notes: string }): { id: string };
    list(): { id: string; site: string; flow: string; outcome: string; notes: string }[];
  };
}

export interface ChannelMessage {
  id: string;
  channel: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  body: string;
  ts: number;
  threadId?: string;
  template?: string;
}

export interface Channel {
  name: string;
  /**
   * Sends a message. Throws when the channel's window policy forbids a free-form message;
   * passing `template` marks the send as one of the pre-approved templates, which are
   * allowed outside the window.
   */
  send(input: { to: string; body: string; mediaPaths?: string[]; replyTo?: string; template?: string }): Promise<ChannelMessage>;
  /** True when a free-form message may be sent to this address right now. */
  windowOpen(to: string): boolean;
  /** Records an inbound message, which reopens the window. */
  recordInbound(message: Omit<ChannelMessage, 'id' | 'ts' | 'direction'>): ChannelMessage;
  history(limit: number): ChannelMessage[];
}

export interface ChannelRegistry {
  list(): Channel[];
  get(name: string): Channel | null;
  /** Delivers text to the member over the session's channel, honouring window policy. */
  deliver(session: SessionRecord, body: string): Promise<{ channel: string; messageId: string; template?: string }>;
}

export interface WakeSpec {
  style: 'cadence' | 'clock' | 'cron';
  intervalMinutes?: number;
  at?: string;
  cron?: string;
  thresholdMinutes: number;
  timezone?: string;
  trigger?: string;
  prompt: string;
}

export interface SubscriptionSpec {
  source: 'gmail' | 'google-calendar' | 'google-docs' | 'location' | 'imessage';
  filter?: string;
  checkInFrequencyMinutes?: number;
}

export interface RuntimeHooks {
  delegate(input: {
    parentSessionId: string;
    task: string;
    modelMode: ModelMode;
    name?: string;
    attachments?: string[];
    includeConversationContext?: boolean;
    start?: 'now' | 'queued';
    schedule?: WakeSpec;
    neverExpire?: boolean;
  }): Promise<{ taskSessionId: string }>;
  taskStatus(sessionId: string, taskId: string): Record<string, unknown> | null;
  listTasks(sessionId: string): Record<string, unknown>[];
  cancelTask(sessionId: string, taskId: string): boolean;
  sendToParent(sessionId: string, body: string, attachments?: string[]): Promise<{ delivered: boolean }>;
  createWake(sessionId: string, spec: WakeSpec): { id: string; nextFireAt: number };
  listWakes(sessionId: string): { id: string; style: string; nextFireAt: number | null; trigger: string | null; prompt: string | null; enabled: boolean }[];
  cancelWake(sessionId: string, wakeId: string): boolean;
  updateWake(sessionId: string, wakeId: string, patch: { enabled?: boolean; intervalMinutes?: number }): boolean;
  subscribe(sessionId: string, spec: SubscriptionSpec): { id: string; source: string; checkInFrequencyMinutes: number };
  listSubscriptions(sessionId: string): { id: string; source: string; filter: string | null; enabled: boolean; lastWakeAt: number | null }[];
  unsubscribe(sessionId: string, id: string): boolean;
  hold(sessionId: string, reason: string): void;
  budget(accountId: string): { day: string; units: number; calls: number; limitUnits: number; percent: number };
  todos: {
    list(accountId: string): Todo[];
    create(accountId: string, input: { title: string; dueAt?: number | null; notes?: string; sessionId?: string }): Todo;
    update(id: string, patch: { title?: string; status?: Todo['status']; dueAt?: number | null; notes?: string }): Todo | null;
    get(id: string): Todo | null;
  };
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  roles: ('main_agent' | 'task_agent')[];
  hasBody: boolean;
  references: string[];
}

export interface SkillService {
  list(role?: 'main_agent' | 'task_agent'): SkillRecord[];
  read(id: string, flags: FlagMap): { id: string; body: string; references: string[] } | null;
  readReference(id: string, reference: string, flags: FlagMap): string | null;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchService {
  search(query: string, options?: { limit?: number }): Promise<SearchResult[]>;
  fetch(url: string): Promise<{ url: string; status: number; contentType: string; text: string }>;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelProvider {
  readonly name: string;
  complete(input: {
    model: string;
    messages: ChatMessage[];
    tools?: ModelToolSpec[];
    maxTokens?: number;
    temperature?: number;
    purpose?: 'agent' | 'trigger' | 'compaction' | 'recall' | 'classification';
  }): Promise<ModelResponse>;
}

export interface DoraServices {
  account: AccountRef;
  flags: FlagMap;
  memory: MemoryService;
  observations: ObservationsService;
  vault: VaultService;
  connectors: ConnectorRegistry;
  browser: BrowserService;
  channels: ChannelRegistry;
  skills: SkillService;
  search: SearchService;
  runtime: RuntimeHooks;
  model: ModelProvider;
}

export interface PendingWakeRecord extends PendingWake {
  cause: WakeCause;
}
