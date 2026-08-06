/**
 * How much attention this one deserves.
 *
 * A review queue is only useful if it tells the reviewer where to start, and
 * "newest first" is not that. Risk is not a guess at whether the draft is
 * *wrong* — the critic already asked that, and if it had a confident answer
 * the draft would not need a human. It is a guess at what it costs if the
 * draft is wrong, which is a different question and one that can be answered
 * from things already on the row.
 *
 * Deliberately arithmetic, not another model call. Three reasons: it runs on
 * every draft and a third call per task is real money; a grade nobody can
 * explain is a grade nobody trusts; and a rule like "the critic refused to
 * sign this off" is not a judgement that needs judgement.
 */

import type { Analysis } from './types';

export const RISK_LEVELS = ['low', 'normal', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Why a task got the grade it did. Stable slugs, not sentences: the reviewer
 * reads these in their own language, and a factor written by last month's
 * version still resolves to a label.
 */
export const RISK_FACTORS = [
  /** The second opinion would not sign the draft off. */
  'criticRejected',
  /** The customer is angry. Getting this one wrong costs more than a refund. */
  'angry',
  /** The customer is unhappy, which is not the same as angry. */
  'unhappy',
  /** Nothing in the rulebook covered this, so the draft is the model's own. */
  'noRules',
  /** This conversation has already gone back and forth without resolving. */
  'longThread',
  /** The drafter thinks the customer found a real fault in the product. */
  'possibleBug',
] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];

export interface Risk {
  level: RiskLevel;
  factors: RiskFactor[];
}

export interface RiskInput {
  analysis?: Analysis | null;
  /** The critic's verdict. Undefined when no critic pass ran. */
  criticApproved?: boolean | undefined;
  /** How many rules made it into the prompt. */
  appliedRules?: number;
  /** Whether the rulebook has anything in it at all. */
  haveRules?: boolean;
  /** Messages on this conversation, including the one being answered. */
  threadLength?: number;
}

/** Any one of these is enough on its own. */
const SEVERE: readonly RiskFactor[] = ['criticRejected', 'angry'];

/** A conversation this long has already failed to resolve at least once. */
const LONG_THREAD = 4;

export function gradeRisk(input: RiskInput): Risk {
  const factors: RiskFactor[] = [];

  // `false`, not falsy: undefined means no critic ran, and "we did not check"
  // is not evidence of a problem. It is not evidence of safety either, but
  // grading every uncriticised draft high would grade every draft high on an
  // install that has the critic switched off to halve its bill.
  if (input.criticApproved === false) factors.push('criticRejected');

  // Not because the reply is likely wrong, but because somebody other than
  // the reviewer needs to hear about it, and the reply going out is the moment
  // the report stops being anybody's problem.
  if (input.analysis?.cause === 'system_bug') factors.push('possibleBug');

  if (input.analysis?.sentiment === 'angry') factors.push('angry');
  else if (input.analysis?.sentiment === 'negative') factors.push('unhappy');

  // Only worth saying on a desk that has a rulebook. On a fresh install every
  // draft is unruled, and a queue where everything is flagged says nothing.
  if (input.haveRules && input.appliedRules === 0) factors.push('noRules');

  if ((input.threadLength ?? 0) >= LONG_THREAD) factors.push('longThread');

  const level: RiskLevel = factors.some(f => SEVERE.includes(f))
    ? 'high'
    : factors.length > 0
      ? 'normal'
      : 'low';

  return { level, factors };
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

export function isRiskFactor(value: unknown): value is RiskFactor {
  return typeof value === 'string' && (RISK_FACTORS as readonly string[]).includes(value);
}
