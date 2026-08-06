import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Who the assistant is writing as.
 *
 * This file is the whole de-branding story. In the system this came from, the
 * company name, the product's pricing, the refund window and the persona's
 * name were written directly into six different prompt strings across four
 * route handlers. Changing "we" meant a code change, and publishing the code
 * meant publishing the company's internal policy.
 *
 * Here it is configuration, and the defaults are deliberately bland: a fresh
 * checkout produces a correct, boring support reply rather than refusing to
 * start.
 */

export interface WorkspaceConfig {
  /** The organisation replying. Appears in the prompt as "you work for X". */
  organization: string;
  /** What it sells. Omit if the organisation name already says it. */
  product?: string;
  /**
   * How replies should sound. One or two sentences beats a style guide — the
   * model follows a short instruction more reliably than a long one.
   */
  voice: string;
  /**
   * Things that are true and that the model would otherwise invent: refund
   * windows, support hours, what the product cannot do. These go into every
   * draft, so keep the list short and load-bearing.
   */
  facts: string[];
  /** Appended verbatim. Empty means no signature. */
  signature: string;
  /**
   * `match` replies in whatever language the customer wrote in. An ISO code
   * forces one language regardless.
   */
  replyLanguage: string;
  /** Escalate rather than answer when the draft would touch one of these. */
  neverPromise: string[];
}

export const DEFAULT_WORKSPACE: WorkspaceConfig = {
  organization: 'our company',
  voice: 'Warm, direct and specific. No filler apologies, no corporate padding.',
  facts: [],
  signature: '',
  replyLanguage: 'match',
  neverPromise: [
    'refund amounts or dates that have not been confirmed',
    'delivery dates for unreleased features',
  ],
};

let cached: WorkspaceConfig | null = null;

function configPath(): string {
  return process.env.AAS_CONFIG?.trim() || resolve(process.cwd(), 'aas.config.json');
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return items.map(entry => entry.trim());
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * File first, then environment. The file is the readable place to keep a voice
 * and a list of facts; the environment is how a container overrides one field
 * without a rebuild.
 */
export function loadWorkspaceConfig(): WorkspaceConfig {
  let fromFile: Record<string, unknown> = {};

  try {
    fromFile = JSON.parse(readFileSync(/* turbopackIgnore: true */ configPath(), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    // A missing file is the normal first-run state. A malformed one is not —
    // silently falling back to defaults there would mean a deployment quietly
    // losing its policy facts.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not read ${configPath()}: ${(error as Error).message}`);
    }
  }

  return {
    organization:
      asString(process.env.AAS_ORGANIZATION) ??
      asString(fromFile.organization) ??
      DEFAULT_WORKSPACE.organization,
    ...(asString(process.env.AAS_PRODUCT) ?? asString(fromFile.product)
      ? { product: asString(process.env.AAS_PRODUCT) ?? asString(fromFile.product) }
      : {}),
    voice: asString(process.env.AAS_VOICE) ?? asString(fromFile.voice) ?? DEFAULT_WORKSPACE.voice,
    facts: asStringArray(fromFile.facts) ?? DEFAULT_WORKSPACE.facts,
    signature: asString(process.env.AAS_SIGNATURE) ?? asString(fromFile.signature) ?? DEFAULT_WORKSPACE.signature,
    replyLanguage:
      asString(process.env.AAS_REPLY_LANGUAGE) ??
      asString(fromFile.replyLanguage) ??
      DEFAULT_WORKSPACE.replyLanguage,
    neverPromise: asStringArray(fromFile.neverPromise) ?? DEFAULT_WORKSPACE.neverPromise,
  };
}

export function getWorkspaceConfig(): WorkspaceConfig {
  if (!cached) cached = loadWorkspaceConfig();
  return cached;
}

export function resetWorkspaceConfig(): void {
  cached = null;
}

/** The persona block that opens every drafting prompt. */
export function describeWorkspace(config: WorkspaceConfig): string {
  const lines: string[] = [
    `You write customer support replies for ${config.organization}${
      config.product ? `, which makes ${config.product}` : ''
    }.`,
    `Voice: ${config.voice}`,
  ];

  if (config.facts.length > 0) {
    lines.push(`\nFacts you may rely on (do not contradict or embellish these):\n${config.facts.map(f => `- ${f}`).join('\n')}`);
  }

  if (config.neverPromise.length > 0) {
    lines.push(
      `\nNever promise:\n${config.neverPromise.map(f => `- ${f}`).join('\n')}\n` +
        'If the customer needs one of those, say it is being checked rather than inventing an answer.',
    );
  }

  lines.push(
    config.replyLanguage === 'match'
      ? '\nReply in the same language the customer wrote in.'
      : `\nReply in ${config.replyLanguage} regardless of the language the customer wrote in.`,
  );

  return lines.join('\n');
}
