import { t } from '../i18n';

import { AnthropicProvider } from './providers/anthropic';
import { CLI_KINDS, CliProvider, isCliKind } from './providers/cli';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import { AI_ROLES, type AiProvider, type AiRole } from './types';

export interface RoleConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface AiConfig {
  provider: AiProvider;
  roles: Record<AiRole, RoleConfig>;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Sensible per-role starting points. Drafting wants some room to write; the
 * critic and the translator should not be inventing anything, so they run cold.
 */
const ROLE_DEFAULTS: Record<AiRole, { temperature: number; maxTokens: number }> = {
  drafter: { temperature: 0.7, maxTokens: 4000 },
  critic: { temperature: 0.2, maxTokens: 2000 },
  translator: { temperature: 0.0, maxTokens: 4000 },
  utility: { temperature: 0.2, maxTokens: 2000 },
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(t('config.number', { name, value: JSON.stringify(raw) }));
  }
  return parsed;
}

function upper(role: AiRole): string {
  return role.toUpperCase();
}

export function buildProvider(): AiProvider {
  const kind = (env('AI_PROVIDER') ?? 'openai-compatible').toLowerCase();
  const apiKey = env('AI_API_KEY') ?? '';

  if (kind === 'anthropic') {
    if (!apiKey) throw new Error(t('config.anthropicKey'));
    return new AnthropicProvider(apiKey, env('AI_BASE_URL') ?? 'https://api.anthropic.com/v1');
  }

  if (kind === 'openai-compatible' || kind === 'openai') {
    const baseUrl = env('AI_BASE_URL') ?? 'https://api.openai.com/v1';
    return new OpenAiCompatibleProvider(baseUrl, apiKey, `AI endpoint (${baseUrl})`);
  }

  // Neither subscription has an endpoint to point AI_BASE_URL at, so this one
  // is a local process rather than a URL and a key. See providers/cli.ts for
  // what that costs.
  if (kind === 'cli') {
    const which = (env('AI_CLI') ?? 'claude').toLowerCase();
    if (!isCliKind(which)) {
      throw new Error(t('config.aiCli', { value: JSON.stringify(which), options: CLI_KINDS.join(', ') }));
    }
    return new CliProvider(which, env('AI_CLI_BIN') ?? which);
  }

  throw new Error(
    t('config.aiProvider', {
      value: JSON.stringify(kind),
      options: 'openai-compatible, anthropic, cli',
    }),
  );
}

/**
 * Per-role model resolution: AI_MODEL_DRAFTER falls back to AI_MODEL. Same for
 * temperature and max tokens, so the common case is one AI_MODEL line and the
 * tuning knobs only appear when someone reaches for them.
 */
export function loadAiConfig(): AiConfig {
  const defaultModel = env('AI_MODEL');
  if (!defaultModel) {
    throw new Error(t('config.required', { name: 'AI_MODEL' }));
  }

  const roles = {} as Record<AiRole, RoleConfig>;
  for (const role of AI_ROLES) {
    const key = upper(role);
    roles[role] = {
      model: env(`AI_MODEL_${key}`) ?? defaultModel,
      temperature: num(`AI_TEMPERATURE_${key}`, ROLE_DEFAULTS[role].temperature),
      maxTokens: num(`AI_MAX_TOKENS_${key}`, ROLE_DEFAULTS[role].maxTokens),
    };
  }

  return {
    provider: buildProvider(),
    roles,
    // Fifteen minutes. Self-hosted models on modest hardware genuinely take
    // this long on a full thread, and a premature timeout looks like a bug.
    timeoutMs: num('AI_TIMEOUT_MS', 900_000),
    maxRetries: num('AI_MAX_RETRIES', 2),
  };
}
