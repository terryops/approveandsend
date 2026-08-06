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
  scope?: string | null;

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
  const scope = input.scope ?? null;

  const empty: LearningOutcome = { attempted: false, results: [], amended: [], discarded: [] };
  if (!input.sentReply.trim()) return empty;

  const rules = listRules({ enabledOnly: true }, db);

  let extraction: ExtractionResult | null = null;
  try {
    const response = await callAI(buildPrompt(input, rules, maxNewRules), { role: 'utility' });
    extraction = extractJson<ExtractionResult>(response);
  } catch (err) {
    // Learning is best-effort and runs after the mail is already gone. A
    // failure here must never look like a failure to send.
    console.warn('[rules] learning call failed:', errText(err));
    return { ...empty, attempted: true };
  }

  if (!extraction) {
    console.warn('[rules] learning returned unparseable JSON');
    return { ...empty, attempted: true };
  }

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
  const pool = listRules({ enabledOnly: true }, db);

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
        scope,
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
