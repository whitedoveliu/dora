import { createLogger } from '@dora/core';
import type { ChatMessage, ModelProvider, ModelResponse, ModelToolSpec } from '@dora/core';

/**
 * OpenAI-compatible chat provider, tuned for DeepSeek V4.1.
 *
 * Production behaviours that matter here:
 *   - an assistant turn that requested tools is echoed back verbatim, because a strict
 *     OpenAI-compatible server rejects a tool result whose call it cannot see;
 *   - 429/5xx/network failures retry with exponential backoff and respect Retry-After;
 *   - every call is logged with model, purpose, tokens, duration and retry count;
 *   - the API key never appears in a log line.
 */
export interface OpenAiProviderOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  /** Injected by tests to avoid sleeping. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface OpenAiErrorShape {
  status: number;
  detail: string;
  retryable: boolean;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  private readonly options: OpenAiProviderOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly log = createLogger('model');
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OpenAiProviderOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private serialise(messages: ChatMessage[]): Record<string, unknown>[] {
    return messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant') {
        const out: Record<string, unknown> = { role: 'assistant', content: m.content ?? '' };
        if (m.toolCalls && m.toolCalls.length > 0) {
          out['tool_calls'] = m.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments }
          }));
        }
        return out;
      }
      return { role: m.role, content: m.content };
    });
  }

  async complete(input: {
    model: string;
    messages: ChatMessage[];
    tools?: ModelToolSpec[];
    maxTokens?: number;
    temperature?: number;
    purpose?: string;
  }): Promise<ModelResponse> {
    if (!this.options.apiKey) throw new Error('no model API key configured (set DORA_API_KEY or configure a credentials file)');
    const body: Record<string, unknown> = {
      model: input.model,
      messages: this.serialise(input.messages),
      max_tokens: input.maxTokens ?? this.options.maxOutputTokens ?? 8192,
      temperature: input.temperature ?? 0.2
    };
    if (input.tools && input.tools.length > 0) {
      body['tools'] = input.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (process.env.DORA_MODEL_EFFORT) body['reasoning_effort'] = process.env.DORA_MODEL_EFFORT;

    const url = this.options.baseUrl.replace(/\/$/, '') + '/chat/completions';
    const maxRetries = this.options.maxRetries ?? 3;
    const clock = this.options.now ?? Date.now;
    const started = clock();
    let attempt = 0;
    let lastError: OpenAiErrorShape | null = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000);
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.options.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          const retryable = response.status === 429 || response.status >= 500;
          lastError = { status: response.status, detail, retryable };
          this.log.warn('model request failed', {
            model: input.model,
            purpose: input.purpose ?? 'agent',
            status: response.status,
            attempt,
            retryable,
            detail
          });
          if (!retryable || attempt > maxRetries) break;
          const retryAfter = Number(response.headers.get('retry-after') ?? '0');
          await this.sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 500 * 2 ** (attempt - 1)));
          continue;
        }
        const payload = (await response.json()) as {
          choices?: { message?: { content?: string; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_cache_hit_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        const message = payload.choices?.[0]?.message ?? {};
        const durationMs = clock() - started;
        const usage = {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0
        };
        this.log.info('model call', {
          model: input.model,
          purpose: input.purpose ?? 'agent',
          attempt,
          duration_ms: durationMs,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cached_tokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
          reasoning_tokens: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
          tool_calls: (message.tool_calls ?? []).map((c) => c.function.name),
          messages: input.messages.length
        });
        return {
          content: message.content ?? '',
          toolCalls: (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
          usage,
          meta: {
            model: input.model,
            durationMs,
            attempts: attempt,
            reasoning: message.reasoning_content ?? null
          }
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const retryable = true;
        lastError = { status: 0, detail, retryable };
        this.log.warn('model request threw', { model: input.model, attempt, detail });
        if (attempt > maxRetries) break;
        await this.sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timer);
      }
    }

    this.log.error('model call failed', {
      model: input.model,
      purpose: input.purpose ?? 'agent',
      attempts: attempt,
      duration_ms: clock() - started,
      status: lastError?.status ?? 0,
      detail: lastError?.detail ?? 'unknown error'
    });
    throw new Error('model call failed after ' + attempt + ' attempt(s): ' + (lastError?.detail ?? 'unknown'));
  }
}
