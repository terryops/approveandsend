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

/**
 * One kind of mail this desk gets, named once so that everything else can
 * agree on the name.
 */
export interface Topic {
  /** Lowercase, hyphenated. Stored on rules and on tasks. */
  slug: string;
  /**
   * What lands here, in the words of someone who reads the mail. This is the
   * only thing the classifier gets, so "asks for money back, disputes a
   * charge, wants to cancel" beats "billing issues".
   */
  description: string;
}

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
  /**
   * The language the people doing the reviewing read.
   *
   * Separate from `replyLanguage`, and the distinction is the whole point: the
   * customer gets an answer in their language, and the reviewer gets a
   * translation of it in theirs. Empty — the default — turns the feature off
   * entirely, which is right for a team that reads the mail it receives.
   *
   * It is never sent to anyone. It exists so that clicking Send is not an act
   * of faith.
   */
  reviewLanguage: string;
  /**
   * The language of the interface itself — buttons, labels, the setup wizard.
   *
   * A third language, and unrelated to the other two: what the reviewer reads
   * in the email panels is `reviewLanguage`, what the customer gets is
   * `replyLanguage`, and this is what the screen around them is written in.
   * A team can want their own language on the buttons while still reading
   * drafts in English, and the reverse. `en` when unset.
   */
  language: string;
  /**
   * The kinds of mail this desk gets — a fixed vocabulary, not a free-text
   * label.
   *
   * This is what makes a rulebook that has outgrown one prompt usable at all.
   * Without it the classifier invents a slug per email — `refund`, then
   * `refunds`, then `refund-request` — and a rule tagged with any one of them
   * matches almost nothing, so every rule has to be injected every time and
   * the character budget silently drops the ones that did not fit.
   *
   * Empty — the default — turns routing off: every enabled rule is a
   * candidate, which is the right behaviour for a desk with thirty rules and
   * the wrong one for a desk with three hundred.
   */
  topics: Topic[];
  /** Escalate rather than answer when the draft would touch one of these. */
  neverPromise: string[];
  /**
   * Where to look the sender up — billing, a CRM, an internal admin.
   *
   * Two forms. A string is a path to a module that default-exports a
   * `ContextSource`; paths rather than package names, because the useful ones
   * are specific to one company and cannot be published — they hold a tenant
   * id, an internal URL, a session cookie.
   *
   * An object is a `DeclarativeSpec`: a URL or a command, plus which fields
   * matter and what they mean. Most lookups are that and nothing more, and
   * asking for a JavaScript file to express them put the feature out of reach
   * of the people who know which fields matter.
   */
  contextSources: (string | Record<string, unknown>)[];
}

export const DEFAULT_WORKSPACE: WorkspaceConfig = {
  organization: 'our company',
  voice: 'Warm, direct and specific. No filler apologies, no corporate padding.',
  facts: [],
  signature: '',
  replyLanguage: 'match',
  reviewLanguage: '',
  language: 'en',
  topics: [],
  neverPromise: [
    'refund amounts or dates that have not been confirmed',
    'delivery dates for unreleased features',
  ],
  contextSources: [],
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

/**
 * A mixed list of module paths and lookup specs.
 *
 * Anything that is neither is dropped here rather than at load time, so a
 * typo in the config costs one source instead of the config file.
 */
function asSourceList(value: unknown): (string | Record<string, unknown>)[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((entry): (string | Record<string, unknown>)[] => {
    if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : [];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) return [entry as Record<string, unknown>];
    return [];
  });
}

/**
 * The one spelling of a topic name.
 *
 * Everywhere a slug can enter — the config file, a form field, the
 * classifier's JSON — it goes through here first, so `Refund `, `refund` and
 * `REFUND` cannot become three topics that each match a third of the rules.
 * Returns null for anything that is not a usable name.
 */
export function normaliseTopicSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null;
}

/** Later entries win, so a duplicated slug is a correction rather than an error. */
function asTopicList(value: unknown): Topic[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const bySlug = new Map<string, Topic>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const slug = normaliseTopicSlug(record.slug);
    if (!slug) continue;
    bySlug.set(slug, { slug, description: asString(record.description) ?? '' });
  }
  return [...bySlug.values()];
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
    reviewLanguage:
      asString(process.env.AAS_REVIEW_LANGUAGE) ??
      asString(fromFile.reviewLanguage) ??
      DEFAULT_WORKSPACE.reviewLanguage,
    language:
      asString(process.env.AAS_LANGUAGE) ??
      asString(fromFile.language) ??
      DEFAULT_WORKSPACE.language,
    topics: asTopicList(fromFile.topics) ?? DEFAULT_WORKSPACE.topics,
    neverPromise: asStringArray(fromFile.neverPromise) ?? DEFAULT_WORKSPACE.neverPromise,
    contextSources: asSourceList(fromFile.contextSources) ?? DEFAULT_WORKSPACE.contextSources,
  };
}

export function getWorkspaceConfig(): WorkspaceConfig {
  if (!cached) cached = loadWorkspaceConfig();
  return cached;
}

export function resetWorkspaceConfig(): void {
  cached = null;
}

/**
 * How the classifier is told what it may answer.
 *
 * Deliberately an instruction to *choose from a list* rather than to invent a
 * label. The difference is the whole feature: a chosen slug matches the rules
 * tagged with it, and an invented one matches nothing while looking exactly
 * as plausible in the UI.
 *
 * Empty when no vocabulary is configured, and the caller falls back to asking
 * for a free-form slug — useful as a description of the mail, and honestly
 * not much else.
 */
export function describeTopics(config: WorkspaceConfig): string {
  if (config.topics.length === 0) return '';

  const lines = config.topics.map(topic =>
    topic.description ? `- ${topic.slug}: ${topic.description}` : `- ${topic.slug}`,
  );

  return (
    `\n\n**The kinds of mail this desk gets:**\n${lines.join('\n')}\n\n` +
    'Pick the one that fits best for "scope", copying the name exactly. ' +
    'If none of them fits, return an empty string rather than inventing a name.'
  );
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
