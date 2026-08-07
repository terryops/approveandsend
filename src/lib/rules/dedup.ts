import { callAI } from '../ai';
import { extractJson } from '../json-repair';
import type { Db } from '../db';
import { getDb } from '../db';
import { shortlist } from './similarity';
import { createRule, listRules, normaliseTopics, proposeRuleUpdate, updateRule } from './store';
import { coerceCategory, type NewRule, type Rule } from './types';

/**
 * The single gate every new rule passes through, whether a human typed it or
 * the learning job proposed it.
 *
 * Rules are written in natural language, so "is this a duplicate?" is a
 * semantic question and a model answers it better than any distance metric.
 * What the model is *not* allowed to do is invent an id: every id it returns
 * is checked against the shortlist it was actually shown, and a miss
 * downgrades the verdict to `add` rather than silently editing whatever rule
 * happened to match.
 */

export type DedupAction = 'add' | 'skip' | 'merge' | 'replace';

export interface DedupResult {
  action: DedupAction;
  /** Present unless the candidate was skipped. */
  rule: Rule | null;
  /** The existing rule the model matched against, when it matched one. */
  conflictRuleId: string | null;
  reason: string;
}

interface DedupVerdict {
  action?: string;
  reason?: string;
  conflictRuleId?: string;
  mergedContent?: string;
}

export interface DedupOptions {
  /**
   * Rules to compare against. Pass the same array through a batch of
   * candidates and it is mutated as they are applied, so candidates within
   * one batch dedupe against each other and not just against what was in the
   * database when the batch started.
   */
  against?: Rule[];
  /** How many existing rules the model gets to see. */
  shortlistSize?: number;
  actor?: string;
  db?: Db;
}

function buildPrompt(candidate: string, rules: Rule[]): string {
  const existing = rules.map(r => `[${r.id}] ${r.content}`).join('\n');

  return `You are reviewing a proposed rule for a customer-support reply assistant.
Decide whether it duplicates or conflicts with an existing rule.

## Proposed rule
${candidate}

## Existing rules
${existing}

Reply with JSON only:
{
  "action": "add" | "skip" | "merge" | "replace",
  "reason": "one short sentence",
  "conflictRuleId": "the id of the existing rule involved, or empty",
  "mergedContent": "the combined rule, only when action is merge"
}

How to choose:
- **skip** — an existing rule already says this, even in different words.
- **merge** — the proposal adds a condition or detail to an existing rule and
  the two belong in one sentence. Give the combined text in mergedContent.
- **replace** — the proposal contradicts an existing rule and is the better
  instruction. The old one will be overwritten.
- **add** — genuinely new.

Prefer skip and merge. A hundred narrow rules that overlap are worse than
twenty that are clearly written, because every one of them is sent to the
model on every reply.`;
}

export async function dedupeAndApplyRule(
  input: NewRule,
  options: DedupOptions = {},
): Promise<DedupResult> {
  const db = options.db ?? getDb();
  const content = input.content.trim();
  const category = coerceCategory(input.category);

  if (!content) {
    return { action: 'skip', rule: null, conflictRuleId: null, reason: 'Empty rule' };
  }

  // Proposals count as existing rules here and nowhere else. Two conversations
  // a week apart that suggest the same thing should produce one thing for a
  // human to look at, not two.
  //
  // This is the one place unapproved text reaches a model, and it is worth
  // being explicit about what that buys an attacker: they can seed a proposal
  // from one email and have it influence this comparison on a later one. The
  // worst outcomes are a genuine rule being skipped as a duplicate, or a
  // rewrite being aimed at the wrong rule — and neither reaches a draft,
  // because every verdict this prompt can produce now ends in either a
  // proposal or nothing. The alternative, comparing only against approved
  // rules, means the same suggestion queues up once per email and buries the
  // queue a human is supposed to be reading.
  const pool = options.against ?? listRules({ enabledOnly: true, proposed: 'include' }, db);

  // Only rules about the same subjects can duplicate each other: the same
  // sentence about refunds is not redundant with the same sentence about
  // onboarding if each is confined to its own kind of mail.
  const topics = normaliseTopics(input.topics).join(',');
  const comparable = pool.filter(r => r.topics.join(',') === topics);

  const candidates = shortlist(content, comparable, r => r.content, {
    limit: options.shortlistSize ?? 12,
  });

  // Nothing even vaguely similar: there is nothing for the model to compare
  // against, so asking it would only invite a hallucinated match.
  if (candidates.length === 0) {
    return insert(input, content, category, pool, db);
  }

  let verdict: DedupVerdict | null = null;
  try {
    const response = await callAI(buildPrompt(content, candidates), { role: 'utility' });
    verdict = extractJson<DedupVerdict>(response);
  } catch (err) {
    // Fail open. A rule was learned from a real human correction; losing it
    // because a dedup call timed out is worse than keeping a near-duplicate,
    // which the next consolidation pass will collapse anyway.
    console.warn('[rules] dedup check failed, adding as new:', errText(err));
    return insert(input, content, category, pool, db);
  }

  if (!verdict) {
    console.warn('[rules] dedup returned unparseable JSON, adding as new');
    return insert(input, content, category, pool, db);
  }

  // The model may only name a rule it was actually shown.
  const shown = new Map(candidates.map(r => [r.id, r]));
  const conflict = verdict.conflictRuleId ? shown.get(verdict.conflictRuleId) : undefined;
  const reason = (verdict.reason ?? '').trim();

  if (verdict.action === 'skip') {
    // A skip naming a rule that does not exist is not a skip — it is a
    // hallucination, and honouring it would silently drop the rule.
    if (!conflict) {
      console.warn('[rules] dedup said skip but named no known rule; adding instead');
      return insert(input, content, category, pool, db);
    }
    return {
      action: 'skip',
      rule: null,
      conflictRuleId: conflict.id,
      reason: reason || 'Already covered by an existing rule',
    };
  }

  if (verdict.action === 'merge' && conflict) {
    const merged = verdict.mergedContent?.trim();
    if (merged) {
      const written = rewrite(input, conflict, { content: merged }, 'merge', options, pool, db);
      if (written) {
        return {
          action: 'merge',
          rule: written,
          conflictRuleId: conflict.id,
          reason: reason || 'Merged into an existing rule',
        };
      }
    }
  }

  if (verdict.action === 'replace' && conflict) {
    const written = rewrite(input, conflict, { content, category }, 'replace', options, pool, db);
    if (written) {
      return {
        action: 'replace',
        rule: written,
        conflictRuleId: conflict.id,
        reason: reason || 'Replaced a conflicting rule',
      };
    }
  }

  return insert(input, content, category, pool, db, reason, conflict?.id ?? null);
}

/**
 * Applies a merge or a replacement, or queues it for approval.
 *
 * Which one depends on the candidate. A rule a human typed carries their
 * authority into whatever it merges with, so that edit happens. A candidate
 * the learning pass produced does not: the model wrote it with a customer's
 * email in front of it, and letting it land on an approved rule would put a
 * stranger's sentence into every draft without anybody agreeing to it — the
 * same escalation the `proposed` flag exists to stop, reached by editing a
 * rule instead of writing one.
 *
 * Returns the row a caller should report — the rewritten rule, or the proposal
 * standing in for it — or null when there was nothing to write.
 */
function rewrite(
  input: NewRule,
  conflict: Rule,
  update: { content: string; category?: ReturnType<typeof coerceCategory> },
  reason: 'merge' | 'replace',
  options: DedupOptions,
  pool: Rule[],
  db: Db,
): Rule | null {
  const context = { reason, ...(options.actor ? { actor: options.actor } : {}) };

  if (!input.proposed) {
    const updated = updateRule(conflict.id, update, context, db);
    if (updated) patchLocal(pool, updated);
    return updated;
  }

  const queued = proposeRuleUpdate(
    conflict.id,
    {
      ...update,
      sourceTaskId: input.sourceTaskId ?? null,
      rationale: input.rationale ?? null,
    },
    context,
    db,
  );
  // Into the pool either way, so the rest of the batch dedupes against what
  // was just queued rather than proposing it a second time. A proposal aimed
  // at an already-pending rule was written in place, so it is a patch; a new
  // one is an addition, and the rule it targets stays in the pool unchanged
  // because it is still the rule the drafter is being given.
  if (queued) {
    if (queued.id === conflict.id) patchLocal(pool, queued);
    else pool.push(queued);
  }
  return queued;
}

function insert(
  input: NewRule,
  content: string,
  category: ReturnType<typeof coerceCategory>,
  pool: Rule[],
  db: Db,
  reason = '',
  conflictRuleId: string | null = null,
): DedupResult {
  const rule = createRule({ ...input, content, category }, db);
  pool.push(rule);
  return { action: 'add', rule, conflictRuleId, reason: reason || 'New rule' };
}

/** Keeps the in-memory pool in step with the database during a batch. */
function patchLocal(pool: Rule[], updated: Rule): void {
  const index = pool.findIndex(r => r.id === updated.id);
  if (index >= 0) pool[index] = updated;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
