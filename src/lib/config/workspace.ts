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
  /**
   * The name a reviewer sees, in the language they read.
   *
   * The slug is a machine name — it has to be one, because a rule tagged
   * `billing-refund-cancel` and a task tagged `billing-refund-cancel` have to
   * be the same string forever. But it is a poor label: a queue of
   * `partnership-and-press` and `billing-invoice-receipt` reads as English
   * kebab-case to somebody whose interface is in Chinese, and at tag width the
   * two of them look like the same word.
   *
   * Written here rather than in the interface translations on purpose. This
   * list is one deployment's vocabulary, invented by whoever runs the desk —
   * shipping translations of it would mean shipping their business in the
   * product's language files. Optional, and the slug shows through when it is
   * missing, so an existing config keeps working unchanged.
   */
  label?: string;
}

export interface WorkspaceConfig {
  /** The organisation replying. Appears in the prompt as "you work for X". */
  organization: string;
  /**
   * What this desk calls itself, in the header and the browser tab.
   *
   * Unlike everything else here it is never sent to a model — it is the label
   * on the tool, not a fact about the business. Empty falls back to the
   * product's own name; see `appName()`.
   */
  appName: string;
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
   * The zone every date on screen is printed in — an IANA name, e.g.
   * `Asia/Shanghai`. Empty follows the machine the desk runs on.
   *
   * One zone for the whole install, not one per reader: a queue where two
   * people see different arrival times is a queue they cannot talk about. Set
   * it when the desk and its server are in different places, which is most
   * hosted ones.
   */
  timeZone: string;
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
   * drafts in English, and the reverse.
   *
   * Empty means nobody has answered yet, which is not the same as choosing
   * English: an install still walking through the wizard takes the browser's
   * own preference until someone picks one. See `locale()`.
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
   * Whether a draft may offer a refund to somebody who withdraws a chargeback.
   *
   * True — the default — because it is the only move in an open dispute that
   * ends well for either side. The money is going back whichever way the bank
   * decides; going back by agreement keeps the dispute fee, keeps the desk's
   * win rate out of the card networks' monitoring programmes, and keeps a
   * customer who would otherwise have been told, correctly and uselessly, that
   * we cannot help them until their bank has finished.
   *
   * False is for a desk that defends chargebacks. It removes the offer from the
   * letter and leaves the rest of it — never a letter that promises a refund
   * this desk will not pay, which is worse than either policy.
   */
  refundOnDisputeWithdrawal: boolean;
  /**
   * What to call each intake on the tab that groups it.
   *
   * `source` is whatever the program posting the rows called itself, and the
   * inbox shows that string when nothing better is on offer —
   * `subeasy-bad-review` reads as "subeasy bad review", which is honest and
   * ugly. This is where a desk says "差评" instead. Unlisted labels keep the
   * slug, so a new intake gets a working tab before anybody names it.
   */
  sourceLabels: Record<string, string>;
  /**
   * Whether a rule the learning pass writes goes straight into drafts.
   *
   * True — the default — is the desk teaching itself: an approved reply is
   * read, a rule comes out of it, and the next draft is written knowing it.
   * Nobody clicks anything. That is the loop this product is named after, and
   * a queue of proposals nobody gets round to reading is the loop stopped: the
   * same correction gets made by hand every week while the rule that would
   * have fixed it waits on a page nobody opens.
   *
   * It is worth being straight about what the default gives up, because it is
   * not nothing. Every rule on this path was written by a model with a
   * customer's email in its context, and the prompt invites rewrites of rules
   * that are already live. So a sufficiently well-written letter can propose
   * the sentence that steers every later reply, and with this on there is no
   * human between the two. `false` puts that human back — proposals are kept
   * and injected nowhere until somebody agrees with them, which is what the
   * `proposed` flag on a rule has always meant.
   *
   * What survives either way is the record. Every write here lands as a rule
   * revision with `reason: 'learned'` and the task that taught it, so the
   * question "why does the drafter believe this, and which email put it there"
   * is answerable afterwards — which is the difference between a desk that
   * learns quickly and one that has quietly drifted.
   */
  autoApproveRules: boolean;
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
  appName: '',
  voice: 'Warm, direct and specific. No filler apologies, no corporate padding.',
  facts: [],
  signature: '',
  timeZone: '',
  replyLanguage: 'match',
  reviewLanguage: '',
  language: '',
  topics: [],
  neverPromise: [
    'refund amounts or dates that have not been confirmed',
    'delivery dates for unreleased features',
  ],
  refundOnDisputeWithdrawal: true,
  sourceLabels: {},
  autoApproveRules: true,
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
 * A slug-to-name map, with anything that is not a pair of non-empty strings
 * dropped. A mistyped entry costs that one label rather than the config file,
 * which is the same bargain every other reader here makes.
 */
function asLabelMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].trim() !== '')
    .map(([key, label]) => [key.trim(), label.trim()] as const);
  return Object.fromEntries(entries);
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
    const label = asString(record.label);
    bySlug.set(slug, {
      slug,
      description: asString(record.description) ?? '',
      ...(label ? { label } : {}),
    });
  }
  return [...bySlug.values()];
}

/**
 * What to print where a topic appears.
 *
 * Takes the slug rather than the Topic, because the callers have a slug: it is
 * what the task row and the rule carry. A slug with no topic behind it still
 * renders — it is either a free-form scope from an install with no vocabulary
 * configured, or a topic somebody removed from the config while tasks were
 * still tagged with it, and in both cases the raw slug is the honest answer.
 */
export function topicLabel(slug: string, config: WorkspaceConfig = getWorkspaceConfig()): string {
  return config.topics.find(topic => topic.slug === slug)?.label || slug;
}

/** How many colours the topic cell has to hand out. Matches `.tag.topic.tone-*`. */
export const TOPIC_TONES = 6;

/**
 * Which of those colours a topic wears, 1..TOPIC_TONES.
 *
 * Its place in the configured vocabulary, so the first six topics on a desk are
 * six different colours. A hash of the slug was the first answer and it was the
 * wrong one: hashing is stable across config edits, which sounds like the
 * property you want until you try it on a real vocabulary and three of the five
 * topics you actually use come out the same colour. Distinguishable is the
 * entire feature. Stable-but-identical is not a weaker version of it, it is the
 * thing it was supposed to fix.
 *
 * So the cost is stated plainly instead: insert a topic in the middle of the
 * list and the ones below it shift a colour. That is a deliberate edit to a file
 * somebody opens perhaps twice a year, and appending — which is how a
 * vocabulary actually grows — moves nothing.
 *
 * The slug, not the label: labels are translated and edited, and a topic must
 * not change colour because somebody rewrote what it is called.
 *
 * Everything outside the vocabulary falls back to a hash. Those are free-form
 * scopes from an install with no topics configured, or a topic deleted while
 * tasks still carried it — there is no list to take a position in, and a colour
 * from the slug beats grey. FNV-1a: four lines, no dependency, and identical in
 * every JavaScript engine, which matters because this renders on the server.
 */
export function topicTone(slug: string, config: WorkspaceConfig = getWorkspaceConfig()): number {
  const index = config.topics.findIndex(topic => topic.slug === slug);
  if (index >= 0) return (index % TOPIC_TONES) + 1;

  let hash = 2166136261;
  for (let i = 0; i < slug.length; i += 1) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % TOPIC_TONES) + 1;
}

/**
 * Slug to label, for the search box.
 *
 * Only the topics that actually have a label: a slug mapped to itself would
 * make the search do the same work twice, since the slug is already one of the
 * columns free text is matched against.
 */
export function topicLabelMap(
  config: WorkspaceConfig = getWorkspaceConfig(),
): Record<string, string> {
  return Object.fromEntries(
    config.topics.filter(topic => topic.label).map(topic => [topic.slug, topic.label as string]),
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * A yes or a no, from a file that can say it properly and an environment that
 * cannot say anything but a string.
 *
 * Anything unrecognised is `undefined` rather than `false`, so it falls through
 * to the next source and finally to the default. That is the safer direction
 * for a setting whose two values are "the desk teaches itself" and "the desk
 * waits" — a typo in a config file should not silently pick one.
 */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  return undefined;
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
    appName: asString(fromFile.appName) ?? DEFAULT_WORKSPACE.appName,
    voice: asString(process.env.AAS_VOICE) ?? asString(fromFile.voice) ?? DEFAULT_WORKSPACE.voice,
    facts: asStringArray(fromFile.facts) ?? DEFAULT_WORKSPACE.facts,
    signature: asString(process.env.AAS_SIGNATURE) ?? asString(fromFile.signature) ?? DEFAULT_WORKSPACE.signature,
    timeZone: asString(process.env.AAS_TIMEZONE) ?? asString(fromFile.timeZone) ?? DEFAULT_WORKSPACE.timeZone,
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
    refundOnDisputeWithdrawal:
      asBoolean(fromFile.refundOnDisputeWithdrawal) ?? DEFAULT_WORKSPACE.refundOnDisputeWithdrawal,
    sourceLabels: asLabelMap(fromFile.sourceLabels) ?? DEFAULT_WORKSPACE.sourceLabels,
    autoApproveRules:
      asBoolean(process.env.AAS_AUTO_APPROVE_RULES) ??
      asBoolean(fromFile.autoApproveRules) ??
      DEFAULT_WORKSPACE.autoApproveRules,
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
      ? '\nReply in the same language the customer wrote in, in the same script and' +
        ' regional variant they used. Somebody who writes in Traditional Chinese' +
        ' gets Traditional Chinese back; answering them in Simplified is the same' +
        ' discourtesy as answering a British customer in American spelling and' +
        ' currency, and it is the kind a Taiwanese or Hong Kong customer notices' +
        ' in the first line.'
      : `\nReply in ${config.replyLanguage} regardless of the language the customer wrote in.`,
  );

  return lines.join('\n');
}
