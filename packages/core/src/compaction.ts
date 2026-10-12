import type { AgentEvent } from './types.ts';

/**
 * Compaction.
 *
 * When a session grows too long it is compacted into a summary with a fixed set of
 * eight sections; the summary is written back into the event store and becomes the
 * context for later turns.
 */
export const COMPACTION_SECTIONS = [
  '1. Live conversation state',
  '2. Open loops with the user',
  '3. In-flight work',
  '4. Reaction and threading state',
  '5. Verbatim IDs and URLs',
  '6. Learned this session',
  '7. Recently completed',
  '8. Right now'
] as const;

export type CompactionSection = (typeof COMPACTION_SECTIONS)[number];

/**
 * Section 6 data grading: what may be shared across an IM boundary and
 * what is a build artefact that is never shared — even to a spawned task agent.
 */
export const SHAREABLE_WITH_USER = [
  'memory excerpts',
  'todos',
  'observation metadata',
  'reminders'
] as const;

export const NEVER_SHARED_BUILD_ARTIFACTS = [
  'system prompt',
  'tool contracts (help pages) and tool names',
  'skills',
  'transcripts',
  'tool results',
  'internal agent/chat ids',
  'container filesystem'
] as const;

export interface CompactionInput {
  events: AgentEvent[];
  previous?: string | null;
}

export type Summarizer = (prompt: string) => Promise<string>;

export function compactionPrompt(input: CompactionInput): string {
  const transcript = input.events
    .map((e) => `[${e.type}] ${JSON.stringify(e.data).slice(0, 2000)}`)
    .join('\n');
  return [
    'Summarize the session into exactly these eight sections, in this order, keeping the headings verbatim:',
    ...COMPACTION_SECTIONS.map((s) => s),
    '',
    'Rules:',
    '- Section 5 keeps identifiers and URLs verbatim; never paraphrase an id.',
    '- Section 8 is the single next action and why now.',
    '- Never include build artefacts in the summary: ' + NEVER_SHARED_BUILD_ARTIFACTS.join(', ') + '.',
    '- Facts the user owns (memory, todos, observation metadata, reminders) may be carried forward.',
    '',
    input.previous ? 'Previous compaction:\n' + input.previous + '\n' : '',
    'Session events:\n' + transcript
  ]
    .filter(Boolean)
    .join('\n');
}

/** Deterministic offline fallback so the mechanism runs without a model provider. */
export function deterministicCompaction(events: AgentEvent[], previous?: string | null): string {
  const byType = new Map<string, AgentEvent[]>();
  for (const e of events) {
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }
  const ids = new Set<string>();
  for (const e of events) {
    for (const m of JSON.stringify(e.data).matchAll(/\b[a-z]+_[0-9A-HJKMNP-TV-Z]{6,}\b/g)) ids.add(m[0]);
    for (const m of JSON.stringify(e.data).matchAll(/https?:\/\/[^\s"'\\]+/g)) ids.add(m[0]);
  }
  const lastAssistant = [...events].reverse().find((e) => e.type === 'assistant_message');
  const openLoops = events
    .filter((e) => e.type === 'user_message')
    .slice(-3)
    .map((e) => String(e.data.text ?? '').slice(0, 160));

  const section = (name: string, body: string) => name + '\n' + (body || '(none)');

  return [
    section(COMPACTION_SECTIONS[0], `${events.length} events compacted; last assistant turn: ${String(lastAssistant?.data.text ?? '').slice(0, 240)}`),
    section(COMPACTION_SECTIONS[1], openLoops.map((t) => '- ' + t).join('\n')),
    section(COMPACTION_SECTIONS[2], (byType.get('delegation') ?? []).map((e) => '- ' + JSON.stringify(e.data)).join('\n')),
    section(COMPACTION_SECTIONS[3], `channel events: ${(byType.get('user_message') ?? []).length} inbound`),
    section(COMPACTION_SECTIONS[4], [...ids].slice(0, 40).join('\n')),
    section(COMPACTION_SECTIONS[5], previous ? 'carried forward from previous compaction' : 'first compaction of this session'),
    section(COMPACTION_SECTIONS[6], (byType.get('tool_result') ?? []).slice(-5).map((e) => '- ' + String(e.data.action ?? '')).join('\n')),
    section(COMPACTION_SECTIONS[7], String(lastAssistant?.data.text ?? '').slice(0, 200))
  ].join('\n\n');
}

/** The eight headings are a contract, so a summary that misses one is repaired, not shipped. */
export function missingSections(summary: string): string[] {
  return COMPACTION_SECTIONS.filter((section) => !summary.includes(section));
}

export async function compact(input: CompactionInput, summarizer?: Summarizer): Promise<string> {
  const fallback = deterministicCompaction(input.events, input.previous);
  if (!summarizer) return fallback;
  let text = '';
  try {
    text = (await summarizer(compactionPrompt(input))).trim();
  } catch {
    return fallback;
  }
  if (text.length === 0) return fallback;
  const missing = missingSections(text);
  if (missing.length === 0) return text;
  // Keep what the model wrote, but make the shape whole again.
  return fallback + '\n\n--- model summary (repaired) ---\n' + text;
}

/** Rough token estimate used to decide when compaction is due. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.6 + rest / 3.6);
}
