import { callAI } from '../ai';
import { extractJson } from '../json-repair';
import type { Db } from '../db';
import { getDb } from '../db';
import { clip, htmlToText } from '../thread-context';
import { dedupeAndApplyRule, type DedupResult } from './dedup';
import { diffSummary } from './diff';
import { formatRulesForReview } from './prompt';
import { listRules, updateRule } from './store';
import { coerceCategory, type Rule } from './types';

/**
 * The learning loop.
 *
 * A human approved a reply. Either they sent the draft as written, or they
 * changed it first. The second case is the whole product: the edit is a
 * correction, and the difference between the two versions says what the model
 * got wrong in a way no amount of prompt tuning would have found.
 *
 * The predecessor never showed the model the original draft — only the final
 * text plus whatever the reviewer typed in the notes box. That works when
 * reviewers write good notes and learns nothing when they just fix the text
 * and hit send, which is most of the time. Here the two versions go in
 * together, so a silent edit still teaches something.
 */

export interface LearningInput {
  /** Identifies the conversation, recorded as the rule's provenance. */
  taskId: string;
  /** Confines what is learned to one kind of mail. Omit for global rules. */
  topic?: string | null;

  incomingSubject: string;
  incomingBody: string;

  /** What the model wrote. Omit if it is not retained. */
  originalDraft?: string;
  /** What actually went out. */
  sentReply: string;
  /** Anything the reviewer typed while rejecting or revising. */
  reviewerNotes?: string;

  /**
   * Where the pair came from. Default `'review'`.
   *
   * `'counterfactual'` means the human never saw the draft: they wrote the
   * reply unaided, months ago, and the draft was generated afterwards to
   * compare against. The evidence is weaker and the extractor is told so — in
   * a review the difference *is* a correction, whereas here two competent
   * replies to the same email will differ in wording for no reason at all.
   */
  mode?: 'review' | 'counterfactual';
}

export interface LearningOutcome {
  /** False when the reply went out unedited and there was nothing to learn. */
  attempted: boolean;
  results: DedupResult[];
  /** Existing rules the extractor rewrote, with the change already applied. */
  amended: { ruleId: string; content: string }[];
  /** Rejected ids and malformed proposals, for logging. */
  discarded: string[];
}

interface ProposedRule {
  content?: string;
  category?: string;
  rationale?: string;
}

interface Amendment {
  ruleId?: string;
  newContent?: string;
  rationale?: string;
}

interface ExtractionResult {
  newRules?: ProposedRule[];
  amendRules?: Amendment[];
}

export interface LearnOptions {
  /** Cap on new rules per conversation. One email is not a mandate. */
  maxNewRules?: number;
  db?: Db;
}

const MAX_BODY_CHARS = 6000;
const MAX_DRAFT_CHARS = 8000;

function buildPrompt(input: LearningInput, rules: Rule[], maxNewRules: number): string {
  const original = input.originalDraft?.trim();
  const sent = input.sentReply.trim();
  const edited = Boolean(original) && original !== sent;

  const counterfactual = input.mode === 'counterfactual';

  const comparison = edited
    ? `## What the assistant ${counterfactual ? 'would write today' : 'drafted'}
${clip(original!, MAX_DRAFT_CHARS)}

## What the human actually sent
${clip(sent, MAX_DRAFT_CHARS)}

## What changed
${diffSummary(original!, sent)}`
    : `## The reply that was sent
${clip(sent, MAX_DRAFT_CHARS)}`;

  const notes = input.reviewerNotes?.trim();

  const provenance = counterfactual
    ? `This is an exchange from the archive. A human answered it some time ago,
without any assistance, and the draft below was generated afterwards by
running the current assistant over the same email. Nobody edited anything —
the two texts are independent answers to the same message.`
    : `A human has just approved and sent a reply.`;

  return `You maintain the rulebook for a customer-support reply assistant.

${provenance} Your job is to decide whether this
exchange teaches anything that should change how future replies are written.

## The incoming message
Subject: ${input.incomingSubject}

${clip(htmlToText(input.incomingBody), MAX_BODY_CHARS)}

${comparison}
${notes ? `\n## The reviewer's notes\n${notes}\n` : ''}
## The rulebook as it stands
${formatRulesForReview(rules)}

## What to look for

${
  edited && counterfactual
    ? `The two replies differ. Most of that difference is not a lesson: two
competent people answering the same email choose different words, different
orderings and different amounts of warmth, and none of that is a mistake.

Look only for places where the human clearly knew something the assistant did
not, or observed a constraint the assistant ignored — a fact about the product,
a commitment it was not allowed to make, a step it left out. If the difference
is only in phrasing, there is nothing here. Say so by returning no rules.`
    : edited
    ? `The human edited the draft before sending. That edit is the signal — work
out what principle it implies, not what the specific wording was. "Removed the
apology paragraph" is an observation; "do not apologise more than once in a
reply" is a rule.`
    : `The draft was sent unchanged, so the assistant got it right. There is
usually nothing to learn from that. Only propose a rule if this exchange
revealed a durable fact about the product or the policy that the rulebook does
not already contain.`
}

Propose a rule only when it will apply again. A rule about one customer's
situation is noise; the same rule stated as a condition ("when a customer asks
about X, do Y") is useful. Be specific enough to act on — "be friendly" is not
a rule, "do not ask a customer who has already complained to leave a review"
is.

At most ${maxNewRules} new rules. Returning none is the normal outcome and is
the right answer most of the time.

You may also amend an existing rule when this exchange shows it to be wrong or
incomplete. Only use ids that appear in the rulebook above.

Categories: policy (commitments, money, compliance), product (how the thing
actually behaves), tone (voice and register), general (everything else).

Reply with JSON only:
{
  "newRules": [
    { "content": "one actionable sentence", "category": "policy", "rationale": "why" }
  ],
  "amendRules": [
    { "ruleId": "id from above", "newContent": "the corrected rule", "rationale": "why" }
  ]
}`;
}

export async function learnFromSentReply(
  input: LearningInput,
  options: LearnOptions = {},
): Promise<LearningOutcome> {
  const db = options.db ?? getDb();
  const maxNewRules = options.maxNewRules ?? 2;
  // What the mail was about becomes what the rule is about. One topic, not a
  // set: the extractor is looking at one conversation, and guessing that a
  // rule learned from a refund thread also governs API questions is a guess
  // nobody asked it to make.
  const topics = input.topic ? [input.topic] : [];

  if (!input.sentReply.trim()) {
    return { attempted: false, results: [], amended: [], discarded: [] };
  }

  const rules = listRules({ enabledOnly: true }, db);
  const extraction = await extract(buildPrompt(input, rules, maxNewRules));
  if (!extraction) return { attempted: true, results: [], amended: [], discarded: [] };

  return apply(extraction, { rules, taskId: input.taskId, topics, maxNewRules, db });
}

/**
 * Run the extractor and parse what comes back, or null if either step failed.
 *
 * Learning is best-effort and always runs after the decision it learns from —
 * the mail has gone, or the draft is already rejected. A failure here must
 * never surface as a failure of the thing the human actually did.
 */
async function extract(prompt: string): Promise<ExtractionResult | null> {
  let response: string;
  try {
    response = await callAI(prompt, { role: 'utility' });
  } catch (err) {
    console.warn('[rules] learning call failed:', errText(err));
    return null;
  }

  const extraction = extractJson<ExtractionResult>(response);
  if (!extraction) console.warn('[rules] learning returned unparseable JSON');
  return extraction;
}

/** Everything after the model call: amend what it corrected, dedupe what it
 * proposed, store what survives. Shared by every way of learning, because the
 * safeguards here are the same whatever prompted the lesson. */
async function apply(
  extraction: ExtractionResult,
  context: { rules: Rule[]; taskId: string; topics: string[]; maxNewRules: number; db: Db },
): Promise<LearningOutcome> {
  const { rules, taskId, topics, maxNewRules, db } = context;
  const input = { taskId };
  const outcome: LearningOutcome = { attempted: true, results: [], amended: [], discarded: [] };

  // Amendments are checked against the ids that were actually in the prompt.
  // The predecessor ran a bare UPDATE on whatever id came back, so a
  // hallucinated-but-real id overwrote an unrelated rule with no record of
  // what it used to say.
  const known = new Map(rules.map(rule => [rule.id, rule]));
  for (const amendment of extraction.amendRules ?? []) {
    const target = amendment.ruleId ? known.get(amendment.ruleId) : undefined;
    const content = amendment.newContent?.trim();
    if (!target || !content || content === target.content) {
      outcome.discarded.push(`amend:${amendment.ruleId ?? '(no id)'}`);
      continue;
    }
    const updated = updateRule(
      target.id,
      { content },
      { reason: 'learned', actor: input.taskId },
      db,
    );
    if (updated) outcome.amended.push({ ruleId: updated.id, content: updated.content });
  }

  // Shared pool, so two proposals from the same conversation dedupe against
  // each other and not only against what was stored before this run.
  const pool = listRules({ enabledOnly: true, proposed: 'include' }, db);

  for (const proposal of (extraction.newRules ?? []).slice(0, maxNewRules)) {
    const content = proposal.content?.trim();
    if (!content) {
      outcome.discarded.push('new:(empty)');
      continue;
    }

    const result = await dedupeAndApplyRule(
      {
        content,
        category: coerceCategory(proposal.category),
        topics,
        // Everything on this path was written by a model that had a customer's
        // email in its context, so it waits for somebody to agree with it.
        // Merges and replacements are not gated the same way: they only edit a
        // rule a human already accepted, and every edit leaves a revision.
        proposed: true,
        sourceTaskId: input.taskId,
        rationale: proposal.rationale?.trim() || null,
      },
      { against: pool, actor: input.taskId, db },
    );
    outcome.results.push(result);
  }

  return outcome;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A draft nobody would send, and a human's sentence saying why.
 *
 * The sent-reply path learns from a correction — two texts, and the difference
 * between them. Here there is no second text. What there is instead is rarer
 * and blunter: somebody stating in their own words what the assistant got
 * wrong. That is the clearest training signal this system ever receives, and
 * before this it was thrown away with the draft.
 */
export interface RejectionInput {
  taskId: string;
  topic?: string | null;
  incomingSubject: string;
  incomingBody: string;
  /** The draft that was refused. */
  rejectedDraft: string;
  /** Why. Written by the reviewer, in whatever words they chose. */
  reason: string;
}

function buildRejectionPrompt(
  input: RejectionInput,
  rules: Rule[],
  maxNewRules: number,
): string {
  return `You maintain the rulebook for a customer-support reply assistant.

A human read the draft below and refused to send it. They gave a reason. Your
job is to work out what the rulebook should say so this does not happen again.

## The incoming message
Subject: ${input.incomingSubject}

${clip(htmlToText(input.incomingBody), MAX_BODY_CHARS)}

## The draft that was rejected
${clip(input.rejectedDraft.trim(), MAX_DRAFT_CHARS)}

## Why it was rejected
${input.reason.trim()}

## The rulebook as it stands
${formatRulesForReview(rules)}

## What to look for

The reason is the lesson, but it is written about this one draft and a rule has
to hold for the next one. "Promised a refund in 3 days, we do not commit to a
date" is the observation; "never state a specific timeframe for a refund" is
the rule.

Take the reviewer at their word. They are the authority on what is correct here
and you are not being asked whether the rejection was fair.

Be careful about two things. A reason like "wrong tone" or "just bad" says
nothing you can turn into a rule — propose nothing rather than inventing a
principle the human did not state. And a rejection can be about the situation
rather than the writing ("this one needs a human, the customer is furious"),
which is a routing decision and not a rule about how to write.

At most ${maxNewRules} new rules. Proposing none is a perfectly good answer.

You may also amend an existing rule when the rejection shows it to be wrong or
too weak — that is common here, because a draft that broke a rule the rulebook
already contains means the rule was not stated firmly enough. Only use ids that
appear above.

Categories: policy (commitments, money, compliance), product (how the thing
actually behaves), tone (voice and register), general (everything else).

Reply with JSON only:
{
  "newRules": [
    { "content": "one actionable sentence", "category": "policy", "rationale": "why" }
  ],
  "amendRules": [
    { "ruleId": "id from above", "newContent": "the corrected rule", "rationale": "why" }
  ]
}`;
}

export async function learnFromRejection(
  input: RejectionInput,
  options: LearnOptions = {},
): Promise<LearningOutcome> {
  const db = options.db ?? getDb();
  const maxNewRules = options.maxNewRules ?? 2;
  const topics = input.topic ? [input.topic] : [];

  // No reason, nothing to learn. A rejection on its own says the draft was
  // wrong but not in what way, and asking a model to guess produces rules
  // nobody agreed to.
  if (!input.reason.trim() || !input.rejectedDraft.trim()) {
    return { attempted: false, results: [], amended: [], discarded: [] };
  }

  const rules = listRules({ enabledOnly: true }, db);
  const extraction = await extract(buildRejectionPrompt(input, rules, maxNewRules));
  if (!extraction) return { attempted: true, results: [], amended: [], discarded: [] };

  return apply(extraction, { rules, taskId: input.taskId, topics, maxNewRules, db });
}
