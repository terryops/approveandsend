import { callAI } from '../ai';
import {
  describeTopics,
  describeWorkspace,
  getWorkspaceConfig,
  normaliseTopicSlug,
  type WorkspaceConfig,
} from '../config/workspace';
import { catalogBlock } from '../catalog/prompt';
import { listCatalog } from '../catalog/store';
import { contextForPrompt } from '../context/gather';
import { classifyTopic } from './classify';
import type { Db } from '../db';
import { getDb } from '../db';
import { operatorLanguage } from '../i18n';
import { extractJson } from '../json-repair';
import { selectRules } from '../rules/prompt';
import { formatRetrieved, retrieveRules } from '../rules/retrieve';
import { listRules, recordApplied } from '../rules/store';
import { attachmentSummary, listAttachments } from '../tasks/attachments';
import { threadContextFor } from '../tasks/messages';
import type { Analysis, Critique as StoredCritique, Task } from '../tasks/types';
import { isCause, isSentiment } from '../tasks/types';
import { clip, htmlToText } from '../thread-context';

/**
 * Reading a customer's email and writing a reply to it.
 *
 * One drafting call, not two. The predecessor ran a full analysis pass and
 * then a separate drafting pass over the same email, which doubled the latency
 * and the cost to produce a draft that could contradict its own analysis. The
 * critic pass below is a genuinely independent second opinion; splitting
 * analysis from drafting was not.
 *
 * What does run first is a classification (`classify.ts`): one small call that
 * answers what the mail is about and nothing else. That is not the analysis
 * pass coming back — it forms no opinion the drafter could contradict, and it
 * is the only way the rules can be chosen by topic at all, since the drafter
 * cannot route a prompt on an answer it has not given yet.
 */

const MAX_BODY_CHARS = 12_000;

export interface DraftResult {
  analysis: Analysis;
  draft: string;
  /** The subject the drafter chose, or undefined to keep the customer's. */
  subject?: string;
  /** Rules that went into the prompt, already counted against their telemetry. */
  appliedRuleIds: string[];
  /** Rules the character budget pushed out, so the caller can log it. */
  droppedRuleIds: string[];
  /** The critic's verdict, when a critic pass ran. */
  critique?: Critique;
  /**
   * The draft as the drafter wrote it, present only when the critic replaced it.
   *
   * `draft` above is always the text to send, which is what every caller wants
   * and why the swap happens in here rather than at each of them. This is the
   * text that was swapped out, so the job can keep it: a rewrite nobody can see
   * the other side of is a rewrite nobody can disagree with, and the critic is
   * a model, not an editor with a mandate.
   */
  supersededDraft?: string;
}

export interface DraftOptions {
  /** Skip the second opinion. Halves the cost of a draft. */
  critic?: boolean;
  /**
   * Count this generation against each rule's usage telemetry. Default true.
   *
   * Off for the counterfactual drafts the backfill generates: those replies
   * were sent years ago and never went anywhere, and letting them increment
   * `applied_count` would destroy the one number that says whether a rule is
   * earning its place in real correspondence.
   */
  recordUsage?: boolean;
  workspace?: WorkspaceConfig;
  /**
   * Override the looked-up context block. The backfill passes an empty string:
   * a Stripe subscription as it stands today says nothing true about what the
   * customer's account looked like when the archived reply was written, and
   * feeding it in would teach rules from a fact that was not available.
   */
  context?: string;
  /**
   * Override the catalogue block. '' leaves the prices out entirely.
   *
   * The backfill passes '' for the same reason it passes an empty context: it
   * drafts against replies that were sent years ago, and a rule learned from a
   * counterfactual draft that quoted today's prices would be a rule taught by a
   * fact nobody had at the time.
   */
  catalogue?: string;
  /**
   * Override the conversation history block. '' forces a first-contact prompt.
   */
  thread?: string;
  /**
   * What the reviewer asked for on this particular reply. '' ignores the note.
   *
   * Defaults to the task's reviewer notes, which is what the box under the
   * draft writes. Redraft without this is a coin flip: the reviewer's only
   * options are to accept the same objection back or to write the reply
   * themselves, and the second one is the product not working.
   */
  steer?: string;
  /**
   * Override the attached filenames. '' says they attached nothing.
   *
   * Set by the backfill, which learns rules from archived replies: the files
   * those customers sent are long gone from the mailbox, and listing today's
   * would be inventing them.
   */
  files?: string;
  db?: Db;
}

/**
 * The verdict as it comes back from the model, which is the stored one plus the
 * rewrite. Only the rewrite is transport: it becomes the draft, and what is
 * kept on the task is the judgement — see `Critique` in `tasks/types`.
 */
export interface Critique extends StoredCritique {
  /** Present only when the critic rewrote the draft. */
  revised?: string;
}

/**
 * The reviewer's instruction for this reply, if they left one.
 *
 * Last in the prompt, immediately before the email, because it is the most
 * specific thing in it: a human who has read this exact draft and said what is
 * wrong with it outranks anything the desk knows in general. It does not
 * outrank the rules — a note asking for something the rulebook forbids is the
 * one case where a reviewer should have to change the rule — and the wording
 * says so, rather than leaving the model to work out the precedence.
 */
function buildSteer(steer: string): string {
  const trimmed = steer.trim();
  if (!trimmed) return '';

  return `

## What the reviewer said about the last attempt
A human read the previous draft and asked for this. Do what it says, unless a
rule above forbids it — in which case follow the rule and leave the rest of the
note honoured:

${clip(trimmed, 2000)}`;
}

/**
 * What they attached, named.
 *
 * The drafter cannot open any of it, and is told so — a model given a filename
 * and no warning will happily summarise a log it has never read. It is told at
 * all because asking a customer for the screenshot they attached is the single
 * most irritating reply a support desk can send, and it is what happens by
 * default when the model has no idea the file is there.
 */
function buildFiles(names: string): string {
  if (!names) return '';
  return `

## What they attached
${names}

You cannot open these and have not read them. Do not describe or quote their
contents, and do not ask for a file that is already in this list.`;
}

function buildPrompt(
  task: Task,
  workspace: WorkspaceConfig,
  /** What the desk sells; '' when nothing has been catalogued. */
  catalogueBlock: string,
  rulesBlock: string,
  contextBlock: string,
  /** Already decided, and already used to choose the rules above. */
  topic: string | undefined,
  /** Earlier messages in this conversation; '' for a first contact. */
  threadBlock: string,
  /** What the reviewer asked for on the retry; '' on a first generation. */
  steerBlock: string,
  /** Filenames the customer attached; '' when they attached nothing. */
  filesBlock: string,
): string {
  const body = clip(htmlToText(task.body), MAX_BODY_CHARS);

  // The vocabulary is listed only where the drafter still has to choose from
  // it. Once the classifier has answered, listing the alternatives invites the
  // drafter to relitigate a decision the rules in front of it were already
  // chosen by.
  const topicBlock = topic
    ? `\n\nThis mail has been classified as: ${topic}. The rules below were chosen for it.`
    : describeTopics(workspace);

  // The history comes before the message being answered, and the heading says
  // which is which. A drafter shown four messages and asked for "a reply" will
  // otherwise answer whichever one it found most interesting, which on a thread
  // where the customer has already been placated is the angry one.
  // The catalogue sits with the persona rather than with the looked-up context,
  // because it is the same for every mail this desk answers. That keeps the
  // cacheable prefix — workspace, then catalogue — intact, and it puts the
  // prices above the rules, which is the order they are read in: a rule about
  // how to discuss pricing is worth nothing to a model that has already decided
  // what the price is.
  return `${describeWorkspace(workspace)}${catalogueBlock}${topicBlock}${rulesBlock}${contextBlock}${threadBlock}${steerBlock}

## ${threadBlock ? "The customer's latest message — this is what you are replying to" : "The customer's email"}
From: ${task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
Subject: ${task.subject}

${body}${filesBlock}

## Where the fault lies
If they are reporting that something did not work, work down this list and
stop at the first one that fits what they described: our bug, a limit of the
product we already know about, something we built that is easy to get wrong,
and only last, something they did. Do not reach for the last one because it is
the cheapest — a desk that assumes user error is a desk where real bugs go
unreported for weeks. If they are reporting no fault at all, say
not_a_problem rather than picking somebody to blame.

This is for whoever reads the reply, not for the reply. Do not tell the
customer whose fault it was; write the answer their message needs.

## How the reply should read
Open by name where you have one — above it says who wrote in.

You may use two marks and no others. \`**like this**\` for the one or two
sentences that carry the answer, and lines starting with \`- \` for a list of
steps or things you need from them. Both survive as bold and bullets in their
mail client. Anything else — headings, tables, HTML tags, links in brackets —
comes out as literal punctuation in their inbox, so do not write it.

Use them sparingly. A reply where half the sentences are bold is a reply where
none of them are.
${
  // Nothing else in the prompt says the signature is not the drafter's job,
  // and the drafter has spent its whole life ending letters properly. Left
  // unsaid, it writes "Best regards, <company> Support" and then the desk
  // appends its own — two sign-offs, which reads exactly as machine-written as
  // it sounds.
  workspace.signature
    ? '\nDo not write a sign-off, a closing line or a signature. One is added ' +
      'below your reply automatically, and a second one is what makes a reply ' +
      'look machine-written.\n'
    : ''
}
## Two languages, and which is which
The reply goes to the customer, so it is written in the language they wrote in.

Everything else you return is a note to the colleague who reviews it, and they
read ${operatorLanguage()}. So \`intent\`, \`keyPoints\` and \`suggestedActions\` are
written in ${operatorLanguage()} whatever language the mail arrived in — a queue
where every other summary is in a language the reviewer has to guess at is a
queue they read one row at a time instead of scanning. Quote the customer's own
words where the exact wording matters, and leave product names, error strings
and identifiers exactly as they appear.

A quotation is not a translation. Where you quote them, the words stay in the
script they wrote — a phrase lifted from a Traditional Chinese mail is quoted in
Traditional Chinese even though the sentence around it is Simplified. The point
of a quotation is that the reviewer can find it in the letter above.

## What to return
JSON only, no prose around it:
{
  "intent": "one specific sentence, in ${operatorLanguage()}, about what this person wants and why — 'wants a refund because the export was silent', not 'refund'",
  "language": "ISO 639-1 code of the language they wrote in",
  "sentiment": "positive | neutral | negative | angry",${
    // Asked for only where nothing else can answer it. Where the desk has a
    // topic vocabulary the classifier has already decided, and asking again
    // would produce a second answer that the reviewer sees and the rules were
    // not chosen by.
    workspace.topics.length > 0
      ? ''
      : '\n  "scope": "a short lowercase slug for the kind of mail this is, e.g. refund, bug-report, sales, how-to",'
  }
  "keyPoints": ["what they actually said, in ${operatorLanguage()}"],
  "cause": "system_bug | known_limitation | ux_issue | user_error | not_a_problem",
  "suggestedActions": ["what a human may need to do outside this reply, if anything, in ${operatorLanguage()}"],
  "subject": "the subject line to answer under, in their language — say what the reply contains, e.g. 'Your refund has been issued'. Leave it empty to keep theirs.",
  "draft": "the reply itself, ready to send${workspace.signature ? '' : ' — no signature'}"
}`;
}

/**
 * The topic a desk with no vocabulary gets: whatever the drafter called it.
 *
 * Only reachable where there is no list to check against. Where there is one,
 * the classifier owns the answer and a name the drafter volunteers is ignored
 * rather than validated — the rules in that prompt were chosen by the
 * classifier, and recording a different name would route the next
 * regeneration by a topic this draft never saw.
 */
function freeSlug(value: unknown): string | undefined {
  return normaliseTopicSlug(value) ?? undefined;
}

function parseDraft(
  raw: string,
  workspace: WorkspaceConfig,
  /** What the rules were routed by. Outranks anything the drafter says. */
  routedTopic: string | undefined,
): { analysis: Analysis; draft: string; subject?: string } | null {
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed) return null;

  const draft = typeof parsed.draft === 'string' ? parsed.draft.trim() : '';
  // A draft is the one field with no sensible default. Everything else can be
  // empty and the reviewer still has something to work with.
  if (!draft) return null;

  // The topic on the task must be the topic the rules were chosen by, or the
  // next regeneration routes on something this draft never saw. The drafter's
  // own answer is only consulted where there was no classification to make.
  const scope = routedTopic ?? (workspace.topics.length === 0 ? freeSlug(parsed.scope) : undefined);

  // Capped rather than validated. A subject is free text in someone's
  // language and there is nothing here to check it against, but a model that
  // has decided to summarise the whole reply into it should not be able to
  // put four hundred characters in a mail header.
  const subject = typeof parsed.subject === 'string' ? parsed.subject.trim().slice(0, 160) : '';

  return {
    draft,
    ...(subject ? { subject } : {}),
    analysis: {
      intent: typeof parsed.intent === 'string' ? parsed.intent.trim() : '',
      language: typeof parsed.language === 'string' ? parsed.language.trim().toLowerCase() : '',
      sentiment: isSentiment(parsed.sentiment) ? parsed.sentiment : 'neutral',
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.filter((p): p is string => typeof p === 'string')
        : [],
      suggestedActions: Array.isArray(parsed.suggestedActions)
        ? parsed.suggestedActions.filter((p): p is string => typeof p === 'string')
        : [],
      ...(scope ? { scope } : {}),
      ...(isCause(parsed.cause) ? { cause: parsed.cause } : {}),
    },
  };
}

/**
 * Everything a prompt about this task needs, assembled once.
 *
 * Pulled out of `draftReply` when a second kind of generation appeared. The
 * expensive half of drafting is not the drafting: it is working out what the
 * mail is about, which rules that routes to, what had to be retrieved because
 * it did not fit, what the enrichment found and what has already been said in
 * the thread. Any generation that answers the same email needs the same
 * answers, and paying for them twice would be paying for a classification call
 * to tell us what we already know.
 */
export interface Assembled {
  workspace: WorkspaceConfig;
  /** Undefined where the desk has no topic vocabulary to route by. */
  topic: string | undefined;
  /**
   * What the desk sells, and the instruction not to invent the rest of it.
   *
   * Assembled here rather than in each prompt builder so that the drafter, the
   * critic, the alternatives and the composer all see the same catalogue. A
   * critic that cannot see the price list cannot catch an invented price, which
   * is the single thing it is most useful for catching.
   */
  catalogueBlock: string;
  rulesBlock: string;
  contextBlock: string;
  threadBlock: string;
  steerBlock: string;
  filesBlock: string;
  /** Rules that went into the prompt. Not yet counted against telemetry. */
  appliedIds: string[];
  /** What the budget pushed out and retrieval did not ask back. */
  droppedIds: string[];
}

export async function assemble(task: Task, options: DraftOptions = {}): Promise<Assembled> {
  const db = options.db ?? getDb();
  const workspace = options.workspace ?? getWorkspaceConfig();

  // What the mail is about has to be settled before the rules are chosen, or
  // the rules are chosen by nothing. A task that already carries a topic — a
  // regeneration, say — keeps it rather than paying for the same answer twice.
  // The backfill's synthetic task does not: nothing has ever classified that
  // archived exchange, so every item pays for one, and that is the fourth call
  // the confirmation panel quotes.
  const topic = task.scope || (await classifyTopic(task, workspace));

  const rules = listRules({ enabledOnly: true }, db);
  const block = selectRules(rules, topic ? { topic } : {});

  // Anything the budget pushed out is offered back as an index of summaries,
  // and whatever this email actually needs is read in full. On a rulebook
  // where everything fits — which is the point of routing — there is nothing
  // dropped, so this costs nothing and does not run.
  const body = clip(htmlToText(task.body), MAX_BODY_CHARS);
  const dropped = block.droppedIds.length > 0
    ? await retrieveRules({
        subject: task.subject,
        body,
        available: rules.filter(rule => block.droppedIds.includes(rule.id)),
      })
    : { rules: [], refusedIds: [] };

  const appliedIds = [...block.includedIds, ...dropped.rules.map(rule => rule.id)];

  return {
    workspace,
    topic: topic || undefined,
    // Overridable alongside `context` and for the same reason: the backfill
    // learns rules from replies sent years ago, and today's price list is not
    // what the person writing them could see.
    catalogueBlock: options.catalogue ?? catalogBlock(listCatalog({ enabledOnly: true }, db)).text,
    rulesBlock: block.text + formatRetrieved(dropped.rules),
    // Whatever the enrichment job found, if it ran. Empty when no sources are
    // configured, which is the default and costs nothing.
    contextBlock: options.context ?? contextForPrompt(task.id, db),
    // Everything said in this conversation before the message being answered.
    // Overridable for the same reason `context` is: the backfill reconstructs a
    // thread as it stood when the archived reply was written, not as it stands
    // now, and the two are not the same conversation.
    threadBlock: options.thread ?? threadContextFor(task.id, {}, db),
    // Read off the task rather than passed in by the caller: a redraft that is
    // retried by the queue, or requeued by the sweep, has to carry the same
    // instruction, and a payload would have lost it on the first retry.
    steerBlock: buildSteer(options.steer ?? task.reviewerNotes ?? ''),
    // Names only, and only of the files a person meant to send — see
    // `attachmentSummary`.
    filesBlock: buildFiles(options.files ?? attachmentSummary(listAttachments(task.id, db))),
    appliedIds,
    // What did not fit and was not asked for either. A rule that was retrieved
    // is not a dropped rule, and reporting it as one would hide the fact that
    // retrieval is working.
    droppedIds: block.droppedIds.filter(id => !appliedIds.includes(id)),
  };
}

export async function draftReply(task: Task, options: DraftOptions = {}): Promise<DraftResult> {
  const db = options.db ?? getDb();
  const {
    workspace, topic, catalogueBlock, rulesBlock, contextBlock, threadBlock, steerBlock, filesBlock,
    appliedIds, droppedIds,
  } = await assemble(task, options);

  const raw = await callAI(
    buildPrompt(
      task, workspace, catalogueBlock, rulesBlock, contextBlock, topic,
      threadBlock, steerBlock, filesBlock,
    ),
    { role: 'drafter' },
  );
  const parsed = parseDraft(raw, workspace, topic);
  if (!parsed) {
    throw new Error('The drafter returned no usable draft');
  }

  // Telemetry is recorded once the draft exists, not when the prompt is built:
  // a failed generation should not inflate a rule's usage count.
  if (options.recordUsage !== false) recordApplied(appliedIds, db);

  const signed = workspace.signature ? `${parsed.draft}\n\n${workspace.signature}` : parsed.draft;

  const result: DraftResult = {
    analysis: parsed.analysis,
    draft: signed,
    ...(parsed.subject ? { subject: parsed.subject } : {}),
    appliedRuleIds: appliedIds,
    droppedRuleIds: droppedIds,
  };

  if (options.critic) {
    const critique = await criticise(
      task, signed, workspace, catalogueBlock, rulesBlock, contextBlock, threadBlock, steerBlock,
      filesBlock,
    );
    if (critique) {
      result.critique = critique;
      if (critique.revised) {
        // The text going out is the corrected one; the text it replaced goes
        // back to the caller rather than nowhere. Whoever reviews this gets to
        // read both and disagree with the critic, which they cannot do about a
        // rewrite that happened silently inside one function call.
        result.supersededDraft = result.draft;
        result.draft = critique.revised;
      }
    }
  }

  return result;
}

/**
 * A second model reads the draft against the same rules and either signs it
 * off or rewrites it.
 *
 * Worth its cost because the failure it catches is the expensive one: a draft
 * that reads perfectly well and quietly breaks a policy. It is optional, and a
 * critic that itself fails is not allowed to lose the draft — the reviewer can
 * judge an uncriticised draft perfectly well, and the original's habit of
 * failing the whole task when the review step errored meant a transient blip
 * threw away a good generation.
 */
async function criticise(
  task: Task,
  draft: string,
  workspace: WorkspaceConfig,
  // The catalogue is worth more to the critic than to the drafter. An invented
  // price is the mistake a support reply makes that costs actual money, and it
  // is invisible without the list to check the number against.
  catalogueBlock: string,
  rulesBlock: string,
  // The critic sees the looked-up context too, and needs it more than the
  // drafter does: "claims not supported by the facts above" is how a reply
  // that cheerfully tells a lapsed customer their subscription renews next
  // month gets caught before a human has to notice it.
  contextBlock: string,
  // The critic needs the thread more than the drafter does. "Contradicts what
  // we already told them" is not a judgement it can make on a message in
  // isolation, and it is the mistake a follow-up reply actually makes.
  threadBlock: string,
  // "Did it do what it was asked?" is the whole point of a redraft, and it is
  // a question only something holding both the note and the new draft can ask.
  steerBlock: string,
  // Given for one check only: whether the reply asks for something the customer
  // already sent.
  filesBlock: string,
): Promise<Critique | undefined> {
  const prompt = `You are reviewing a support reply before a human sees it. You did not write it.

${describeWorkspace(workspace)}${catalogueBlock}${rulesBlock}${contextBlock}${threadBlock}${steerBlock}

## The customer's ${threadBlock ? 'latest message' : 'email'}
Subject: ${task.subject}

${clip(htmlToText(task.body), MAX_BODY_CHARS)}${filesBlock}

## The proposed reply
${draft}

Check it for: claims that are not supported by the facts above, anything on the
never-promise list, breaches of the rules, the wrong language, tone that does
not match${catalogueBlock ? ', any product, plan or price that does not appear exactly as written in the catalogue above — a number that is close is a wrong number' : ''}${threadBlock ? ', and anything that contradicts or repeats what we already said in this thread' : ''}${steerBlock ? ', and whether it actually did what the reviewer asked for' : ''}${filesBlock ? ', and whether it asks for a file they already attached' : ''}. Ignore matters of taste — a reply you would have phrased
differently is not a problem.

JSON only:
{
  "approved": true or false,
  "issues": ["what is wrong, specifically; empty when approved"],
  "revised": "the corrected reply in full — include this ONLY if approved is false"
}`;

  try {
    const parsed = extractJson<Record<string, unknown>>(await callAI(prompt, { role: 'critic' }));
    if (!parsed) return undefined;

    const approved = parsed.approved !== false;
    const revised = typeof parsed.revised === 'string' ? parsed.revised.trim() : '';
    // A rewrite that comes back with an approval is the critic contradicting
    // itself; trust the verdict and keep the draft we already had.
    const rewriting = !approved && Boolean(revised);

    return {
      approved,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === 'string') : [],
      rewritten: rewriting,
      ...(rewriting ? { revised } : {}),
    };
  } catch (error) {
    console.warn('[drafting] critic pass failed, keeping the draft as written:', error);
    return undefined;
  }
}
