import { postJson } from '../http';
import { AiError, isTransientNetworkError, type AiProvider, type AiRequest, type AiResponse } from '../types';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Speaks the OpenAI /v1/chat/completions wire format, which by now is the
 * lingua franca: OpenAI, OpenRouter, Groq, DeepSeek, Together, vLLM, Ollama,
 * LM Studio, llama.cpp and OpenClaw all accept it. Pointing AI_BASE_URL at any
 * of them is the whole integration.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = 'openai-compatible';
  readonly label: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    label = 'OpenAI-compatible endpoint',
  ) {
    this.label = label;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Local runtimes (Ollama, LM Studio) accept no key at all; sending an empty
    // bearer makes some of them 401, so only set the header when we have one.
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res;
    try {
      res = await postJson(
        `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        headers,
        {
          model: req.model,
          messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
        },
        req.timeoutMs,
        req.signal,
      );
    } catch (err) {
      throw new AiError(`${this.label} unreachable: ${(err as Error).message}`, {
        transient: isTransientNetworkError(err),
        providerId: this.id,
        cause: err,
      });
    }

    if (res.status < 200 || res.status >= 300) {
      throw new AiError(`${this.label} returned ${res.status}: ${res.body.slice(0, 300)}`, {
        status: res.status,
        // 429 and 5xx are worth another attempt; a 400 means our request is wrong.
        transient: res.status === 429 || res.status >= 500,
        providerId: this.id,
      });
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new AiError(`${this.label} returned unparseable JSON: ${res.body.slice(0, 200)}`, {
        providerId: this.id,
        transient: true,
      });
    }

    if (parsed.error?.message) {
      throw new AiError(`${this.label} error: ${parsed.error.message}`, { providerId: this.id });
    }

    const text = parsed.choices?.[0]?.message?.content;
    // Some gateways answer 200 with empty content when the upstream model timed
    // out or was filtered. That is a failed call wearing a success status, so
    // treat it as transient rather than feeding "" downstream as a draft.
    if (!text || !text.trim()) {
      throw new AiError(`${this.label} returned an empty completion`, {
        providerId: this.id,
        transient: true,
      });
    }

    return {
      text,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens,
        outputTokens: parsed.usage?.completion_tokens,
      },
    };
  }
}
