/**
 * Every AI call in ReplyLoop is made on behalf of a role. Roles exist so an
 * operator can point the expensive work at a strong model and the cheap work at
 * a small one — translating a draft does not need the model that wrote it.
 */
export type AiRole = 'drafter' | 'critic' | 'translator' | 'utility';

export const AI_ROLES: readonly AiRole[] = ['drafter', 'critic', 'translator', 'utility'];

export interface AiRequest {
  prompt: string;
  /** Optional system prompt. Providers that lack one prepend it to the user turn. */
  system?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AiResponse {
  text: string;
  /** Present when the provider reports it; used for cost accounting later. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AiProvider {
  readonly id: string;
  /** Human-readable, shown in the admin UI when a call fails. */
  readonly label: string;
  complete(req: AiRequest): Promise<AiResponse>;
}

/**
 * Thrown by providers. `transient` drives the retry loop — the provider decides,
 * because only it knows what its own 4xx bodies mean.
 */
export class AiError extends Error {
  readonly status?: number;
  readonly transient: boolean;
  readonly providerId: string;

  constructor(
    message: string,
    opts: { status?: number; transient?: boolean; providerId: string; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AiError';
    this.status = opts.status;
    this.transient = opts.transient ?? false;
    this.providerId = opts.providerId;
  }
}

/**
 * Network-level failures are transient regardless of provider. HTTP status is
 * handled per-provider; this only classifies what happened below the response.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  return err.name === 'AbortError' || err.message === 'fetch failed';
}
