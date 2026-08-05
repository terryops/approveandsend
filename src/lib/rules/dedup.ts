import { callAI } from '../ai';
import { extractJson } from '../json-repair';
import type { Db } from '../db';
import { getDb } from '../db';
import { shortlist } from './similarity';
import { createRule, listRules, updateRule } from './store';
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

  const pool = options.against ?? listRules({ enabledOnly: true }, db);

  // Only rules in the same scope can duplicate each other: the same sentence
  // about refunds is not redundant with the same sentence about onboarding if
  // each is confined to its own kind of mail.
  const scope = input.scope ?? null;
  const comparable = pool.filter(r => (r.scope ?? null) === scope);

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
      const updated = updateRule(
        conflict.id,
        { content: merged },
        { reason: 'merge', actor: options.actor },
        db,
      );
      if (updated) {
        patchLocal(pool, updated);
        return {
          action: 'merge',
          rule: updated,
          conflictRuleId: conflict.id,
          reason: reason || 'Merged into an existing rule',
        };
      }
    }
  }

  if (verdict.action === 'replace' && conflict) {
    const updated = updateRule(
      conflict.id,
      { content, category },
      { reason: 'replace', actor: options.actor },
      db,
    );
    if (updated) {
      patchLocal(pool, updated);
      return {
        action: 'replace',
        rule: updated,
        conflictRuleId: conflict.id,
        reason: reason || 'Replaced a conflicting rule',
      };
    }
  }

  return insert(input, content, category, pool, db, reason, conflict?.id ?? null);
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
