/**
 * A rule is one sentence the drafter must obey, learned from a human editing
 * a draft before it went out.
 *
 * The whole design constraint: rules accumulate forever and every enabled one
 * is injected into every generation. So the interesting fields are the ones
 * that let a rule be *narrowed* (scope, category) or *retired* (enabled,
 * applied_count) rather than the ones that let more of them in.
 */

export const RULE_CATEGORIES = ['policy', 'product', 'tone', 'general'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export function isRuleCategory(value: unknown): value is RuleCategory {
  return typeof value === 'string' && (RULE_CATEGORIES as readonly string[]).includes(value);
}

/** Anything unrecognised becomes 'general' rather than inventing a category. */
export function coerceCategory(value: unknown): RuleCategory {
  return isRuleCategory(value) ? value : 'general';
}

export interface Rule {
  id: string;
  /**
   * Insertion order. Ids are UUIDs and `created_at` has millisecond
   * resolution, so neither one orders two rules written in the same tick —
   * and a rule block whose order changes between runs makes two generations
   * impossible to compare. This is the only field that sorts reliably.
   */
  seq: number;
  content: string;
  category: RuleCategory;
  /** null = applies to every kind of mail. */
  scope: string | null;
  enabled: boolean;
  /** The conversation this was learned from, when it was learned rather than typed. */
  sourceTaskId: string | null;
  /** Why the extractor thought this was worth keeping. */
  rationale: string | null;
  appliedCount: number;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuleRevision {
  id: number;
  ruleId: string;
  previousContent: string;
  newContent: string;
  reason: RuleChangeReason;
  actor: string | null;
  createdAt: string;
}

export type RuleChangeReason = 'manual' | 'learned' | 'merge' | 'replace' | 'consolidation';

export interface NewRule {
  content: string;
  category?: RuleCategory;
  scope?: string | null;
  sourceTaskId?: string | null;
  rationale?: string | null;
}
