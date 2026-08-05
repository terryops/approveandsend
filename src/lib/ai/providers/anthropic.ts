import { postJson } from '../http';
import { AiError, isTransientNetworkError, type AiProvider, type AiRequest, type AiResponse } from '../types';

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic's /v1/messages differs from the OpenAI format in three ways that
 * matter here: auth is x-api-key rather than a bearer, the system prompt is a
 * top-level field rather than a message, and max_tokens is required.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com/v1',
  ) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    let res;
    try {
      res = await postJson(
        `${this.baseUrl.replace(/\/+$/, '')}/messages`,
        {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        {
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.prompt }],
        },
        req.timeoutMs,
        req.signal,
      );
    } catch (err) {
      throw new AiError(`Anthropic unreachable: ${(err as Error).message}`, {
        transient: isTransientNetworkError(err),
        providerId: this.id,
        cause: err,
      });
    }

    if (res.status < 200 || res.status >= 300) {
      throw new AiError(`Anthropic returned ${res.status}: ${res.body.slice(0, 300)}`, {
        status: res.status,
        // 529 is Anthropic's "overloaded"; retrying is the documented response.
        transient: res.status === 429 || res.status === 529 || res.status >= 500,
        providerId: this.id,
      });
    }

    let parsed: MessagesResponse;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new AiError(`Anthropic returned unparseable JSON: ${res.body.slice(0, 200)}`, {
        providerId: this.id,
        transient: true,
      });
    }

    if (parsed.error?.message) {
      throw new AiError(`Anthropic error: ${parsed.error.message}`, { providerId: this.id });
    }

    const text = (parsed.content ?? [])
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text)
      .join('');

    if (!text.trim()) {
      throw new AiError('Anthropic returned an empty completion', {
        providerId: this.id,
        transient: true,
      });
    }

    return {
      text,
      usage: {
        inputTokens: parsed.usage?.input_tokens,
        outputTokens: parsed.usage?.output_tokens,
      },
    };
  }
}
