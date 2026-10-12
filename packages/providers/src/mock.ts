import type { ChatMessage, ModelProvider, ModelResponse, ModelToolSpec } from '@dora/core';

/**
 * Deterministic provider used by tests, the demo and offline runs.
 *
 * It is a real agent loop participant: it sees the same two base commands the hosted
 * model sees (bash and hold) and returns real tool calls. Two modes:
 *   - scripted: a queue of canned responses consumed in order;
 *   - heuristic: reads the newest instruction out of the transcript, so an unscripted
 *     demo still shows planning, a bash turn, and a hold.
 */
export interface MockStep {
  content?: string;
  toolCall?: { name: 'bash' | 'hold'; arguments: Record<string, unknown> };
}

export class MockModelProvider implements ModelProvider {
  readonly name = 'mock';
  private readonly script: MockStep[];
  private cursor = 0;
  private readonly heuristics: boolean;
  readonly calls: { messages: ChatMessage[]; tools: string[] }[] = [];

  constructor(options: { script?: MockStep[]; heuristics?: boolean } = {}) {
    this.script = options.script ?? [];
    this.heuristics = options.heuristics ?? true;
  }

  async complete(input: { model: string; messages: ChatMessage[]; tools?: ModelToolSpec[] }): Promise<ModelResponse> {
    // Record a snapshot: the agent keeps appending to the array it handed us.
    this.calls.push({ messages: input.messages.map((m) => ({ ...m })), tools: (input.tools ?? []).map((t) => t.name) });
    const step = this.script[this.cursor];
    if (step) {
      this.cursor += 1;
      return {
        content: step.content ?? '',
        toolCalls: step.toolCall ? [{ id: 'call_' + this.cursor, name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.arguments) }] : [],
        usage: { inputTokens: 100, outputTokens: 20 },
        meta: { scripted: true }
      };
    }
    if (!this.heuristics) {
      return { content: 'done', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, meta: {} };
    }
    return this.heuristic(input.messages);
  }

  private heuristic(messages: ChatMessage[]): ModelResponse {
    const last = messages[messages.length - 1];
    const toolResults = messages.filter((m) => m.role === 'tool');

    // Second pass: after a tool result, summarise and hold.
    if (last && last.role === 'tool') {
      const summary = last.content.split('\n').slice(0, 6).join('\n');
      return {
        content: 'I ran the command and read the result:\n' + summary + '\nNext: nothing else is needed, so I am ending the turn.',
        toolCalls: [{ id: 'hold_' + toolResults.length, name: 'hold', arguments: JSON.stringify({ reason: 'job done' }) }],
        usage: { inputTokens: 200, outputTokens: 40 },
        meta: { heuristic: true }
      };
    }

    const instruction = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const command = extractCommand(instruction);
    if (command) {
      return {
        content: 'Plan: run that through bash, then report back.',
        toolCalls: [{ id: 'bash_1', name: 'bash', arguments: JSON.stringify({ command }) }],
        usage: { inputTokens: 150, outputTokens: 30 },
        meta: { heuristic: true }
      };
    }
    return {
      content: 'Understood: ' + instruction.slice(0, 200) + '\n(offline model: no external calls were made)',
      toolCalls: [{ id: 'hold_0', name: 'hold', arguments: JSON.stringify({ reason: 'answered directly' }) }],
      usage: { inputTokens: 80, outputTokens: 20 },
      meta: { heuristic: true }
    };
  }
}

/** Pull an explicit command out of an instruction: "run: X", "bash: X" or a tools line. */
export function extractCommand(instruction: string): string | null {
  const explicit = /(?:run|bash|exec)\s*:\s*([\s\S]+)/i.exec(instruction);
  if (explicit) return explicit[1].trim();
  const toolsLine = /(?:^|\n)\s*(tools\s+[^\n]+)/.exec(instruction);
  if (toolsLine) return toolsLine[1].trim();
  return null;
}
