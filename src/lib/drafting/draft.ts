import { callAI } from '../ai';
import {
  describeTopics,
  describeWorkspace,
  getWorkspaceConfig,
  normaliseTopicSlug,
  type WorkspaceConfig,
} from '../config/workspace';
import { contextForPrompt } from '../context/gather';
import { classifyTopic } from './classify';
import type { Db } from '../db';
import { getDb } from '../db';
import { extractJson } from '../json-repair';
import { selectRules } from '../rules/prompt';
import { formatRetrieved, retrieveRules } from '../rules/retrieve';
import { listRules, recordApplied } from '../rules/store';
import { threadContextFor } from '../tasks/messages';
import type { Analysis, Task } from '../tasks/types';
import { isSentiment } from '../tasks/types';
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
  /** Rules that went into the prompt, already counted against their telemetry. */
  appliedRuleIds: string[];
  /** Rules the character budget pushed out, so the caller can log it. */
  droppedRuleIds: string[];
  /** The critic's verdict, when a critic pass ran. */
  critique?: Critique;
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
   * Override the conversation history block. '' forces a first-contact prompt.
   */
  thread?: string;
  db?: Db;
}

export interface Critique {
  /** False when the critic found something that must be fixed before sending. */
  approved: boolean;
  issues: string[];
  /** Present only when the critic rewrote the draft. */
  revised?: string;
}

function buildPrompt(
  task: Task,
  workspace: WorkspaceConfig,
  rulesBlock: string,
  contextBlock: string,
  /** Already decided, and already used to choose the rules above. */
  topic: string | undefined,
  /** Earlier messages in this conversation; '' for a first contact. */
  threadBlock: string,
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
  return `${describeWorkspace(workspace)}${topicBlock}${rulesBlock}${contextBlock}${threadBlock}

## ${threadBlock ? "The customer's latest message — this is what you are replying to" : "The customer's email"}
From: ${task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
Subject: ${task.subject}

${body}

## What to return
JSON only, no prose around it:
{
  "intent": "one specific sentence about what this person wants and why — 'wants a refund because the export was silent', not 'refund'",
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
  "keyPoints": ["what they actually said, in their terms"],
  "suggestedActions": ["what a human may need to do outside this reply, if anything"],
  "draft": "the reply itself, plain text, ready to send${workspace.signature ? '' : ' — no signature'}"
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
): { analysis: Analysis; draft: string } | null {
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

  return {
    draft,
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
    },
  };
}

export async function draftReply(task: Task, options: DraftOptions = {}): Promise<DraftResult> {
  const db = options.db ?? getDb();
  const workspace = options.workspace ?? getWorkspaceConfig();

  // What the mail is about has to be settled before the rules are chosen, or
  // the rules are chosen by nothing. A task that already carries a topic — a
  // regeneration, a backfill — keeps it rather than paying for the same answer
  // twice.
  const topic = task.scope || (await classifyTopic(task, workspace));

  const rules = listRules({ enabledOnly: true }, db);
  const block = selectRules(rules, { ...(topic ? { topic } : {}) });

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

  const rulesBlock = block.text + formatRetrieved(dropped.rules);
  const appliedIds = [...block.includedIds, ...dropped.rules.map(rule => rule.id)];

  // Whatever the enrichment job found, if it ran. Empty when no sources are
  // configured, which is the default and costs nothing.
  const contextBlock = options.context ?? contextForPrompt(task.id, db);

  // Everything said in this conversation before the message being answered.
  // Overridable for the same reason `context` is: the backfill reconstructs a
  // thread as it stood when the archived reply was written, not as it stands
  // now, and the two are not the same conversation.
  const threadBlock = options.thread ?? threadContextFor(task.id, {}, db);

  const raw = await callAI(
    buildPrompt(task, workspace, rulesBlock, contextBlock, topic || undefined, threadBlock),
    { role: 'drafter' },
  );
  const parsed = parseDraft(raw, workspace, topic || undefined);
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
    appliedRuleIds: appliedIds,
    // What did not fit and was not asked for either. A rule that was retrieved
    // is not a dropped rule, and reporting it as one would hide the fact that
    // retrieval is working.
    droppedRuleIds: block.droppedIds.filter(id => !appliedIds.includes(id)),
  };

  if (options.critic) {
    const critique = await criticise(task, signed, workspace, rulesBlock, contextBlock, threadBlock);
    if (critique) {
      result.critique = critique;
      if (critique.revised) result.draft = critique.revised;
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
): Promise<Critique | undefined> {
  const prompt = `You are reviewing a support reply before a human sees it. You did not write it.

${describeWorkspace(workspace)}${rulesBlock}${contextBlock}${threadBlock}

## The customer's ${threadBlock ? 'latest message' : 'email'}
Subject: ${task.subject}

${clip(htmlToText(task.body), MAX_BODY_CHARS)}

## The proposed reply
${draft}

Check it for: claims that are not supported by the facts above, anything on the
never-promise list, breaches of the rules, the wrong language, tone that does
not match${threadBlock ? ', and anything that contradicts or repeats what we already said in this thread' : ''}. Ignore matters of taste — a reply you would have phrased
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

    return {
      approved,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === 'string') : [],
      // A rewrite that comes back with an approval is the critic contradicting
      // itself; trust the verdict and keep the draft we already had.
      ...(!approved && revised ? { revised } : {}),
    };
  } catch (error) {
    console.warn('[drafting] critic pass failed, keeping the draft as written:', error);
    return undefined;
  }
}
