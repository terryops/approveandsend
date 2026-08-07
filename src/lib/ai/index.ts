import { loadAiConfig, type AiConfig } from './config';
import { AiError, type AiResponse, type AiRole } from './types';

export { AiError, AI_ROLES } from './types';
export type { AiProvider, AiRequest, AiResponse, AiRole } from './types';
export type { AiConfig, RoleConfig } from './config';
export { loadAiConfig, buildProvider } from './config';

let cached: AiConfig | null = null;

/** Config is read once per process; call this after changing env in tests. */
export function resetAiConfig(): void {
  cached = null;
}

function config(): AiConfig {
  if (!cached) cached = loadAiConfig();
  return cached;
}

export interface CallAiOptions {
  role?: AiRole;
  system?: string;
  signal?: AbortSignal;
  /** Overrides the role's configured model for this call only. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function backoffMs(attempt: number, status?: number): number {
  // Rate limits need a real pause; everything else recovers faster than that.
  if (status === 429) return 30_000;
  // Configurable only so a test can cover the retry path without spending ten
  // real seconds asleep in it. Nothing in production sets it.
  return Number(process.env.AI_RETRY_BASE_MS ?? 10_000) * (attempt + 1);
}

/**
 * The single entry point for every AI call in the app. Callers pick a role and
 * pass a prompt; model selection, retries and provider quirks live here.
 */
export async function callAI(prompt: string, options: CallAiOptions = {}): Promise<string> {
  const result = await callAIDetailed(prompt, options);
  return result.text;
}

export async function callAIDetailed(
  prompt: string,
  options: CallAiOptions = {},
): Promise<AiResponse> {
  if (!prompt || !prompt.trim()) {
    throw new Error('callAI requires a non-empty prompt');
  }

  const cfg = config();
  const role = options.role ?? 'utility';
  const roleCfg = cfg.roles[role];
  if (!roleCfg) throw new Error(`Unknown AI role: ${role}`);

  const request = {
    prompt,
    system: options.system,
    model: options.model ?? roleCfg.model,
    temperature: options.temperature ?? roleCfg.temperature,
    maxTokens: options.maxTokens ?? roleCfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    signal: options.signal,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await cfg.provider.complete(request);
    } catch (err) {
      lastError = err;
      const transient = err instanceof AiError && err.transient;
      if (!transient || attempt === cfg.maxRetries || options.signal?.aborted) break;

      const delay = backoffMs(attempt, err instanceof AiError ? err.status : undefined);
      console.warn(
        `[ai] ${role} call failed (${(err as Error).message}); retry ${attempt + 1}/${cfg.maxRetries} in ${delay / 1000}s`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
