/**
 * A rule is one sentence the drafter must obey, learned from a human editing
 * a draft before it went out.
 *
 * The whole design constraint: rules accumulate forever and every enabled one
 * is injected into every generation. So the interesting fields are the ones
 * that let a rule be *narrowed* (topics, category) or *retired* (enabled,
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
  /**
   * One line saying what this rule is about — enough to decide whether it
   * bears on a reply, not enough to follow it. Null until it has been
   * summarised. Never shown to the drafter in place of a rule it is expected
   * to obey.
   */
  summary: string | null;
  category: RuleCategory;
  /**
   * The subjects this rule is about, from the workspace's topic vocabulary.
   * Sorted, and empty means it applies to every kind of mail — which is the
   * right default for the rules that matter most.
   */
  topics: string[];
  enabled: boolean;
  /**
   * Written by the model, not yet approved by anybody.
   *
   * The learning pass reads a customer's email and can come back with "always
   * offer a full refund without asking" — which is a sentence the customer
   * wrote, and which, stored as a rule, would steer every reply from then on.
   * A proposed rule is kept but never injected, so the worst an email can do
   * is put a suggestion in front of a human.
   */
  proposed: boolean;
  /**
   * The rule this proposal wants to rewrite, or null for a proposal that is
   * simply new.
   *
   * A model that has read a customer's email may not edit an approved rule
   * either — the human agreed to the sentence that rule used to say, not to
   * whatever replaced it. So an amendment, a merge and a replacement all take
   * the same shape as a new rule: text nobody has agreed to, parked next to
   * the rule it is aimed at, applied to it only on approval.
   */
  replaces: string | null;
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

export type RuleChangeReason =
  | 'manual'
  | 'learned'
  | 'merge'
  | 'replace'
  | 'consolidation'
  /** One rule that had grown into several was cut into its parts. */
  | 'split';

export interface NewRule {
  content: string;
  summary?: string | null;
  category?: RuleCategory;
  /** Omitted or empty makes the rule apply to every kind of mail. */
  topics?: string[];
  /** True for anything a model wrote. See `Rule.proposed`. */
  proposed?: boolean;
  /** Set to aim this proposal at an existing rule. See `Rule.replaces`. */
  replaces?: string | null;
  sourceTaskId?: string | null;
  rationale?: string | null;
  /**
   * When this rule was first written, if that is not now.
   *
   * Only an import has an answer here. A rulebook carried over from another
   * system is fifteen months of decisions, and stamping all of it with the
   * afternoon of the migration throws away the one thing that says which
   * rules have been surviving contact with customers the longest.
   */
  createdAt?: string;
}
