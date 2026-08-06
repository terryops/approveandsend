import { RULE_CATEGORIES, type Rule, type RuleCategory } from './types';

/**
 * Turning rules into the block that goes into a generation prompt.
 *
 * The thing this file exists to prevent: a rule set that grows forever, is
 * injected in full into every call, and one day quietly becomes most of the
 * prompt. The original had no budget here at all — 135 rules in every
 * generation, with nothing stopping it reaching 500.
 */

/**
 * Roughly 6k characters. Large enough for a few hundred rules, small enough
 * that the conversation being replied to is still the bulk of the prompt.
 */
export const DEFAULT_RULE_BUDGET_CHARS = 6000;

/**
 * When the budget bites, the first rules kept are the ones whose absence is
 * most expensive. A dropped tone rule reads slightly wrong; a dropped policy
 * rule promises a refund that does not exist.
 */
const CATEGORY_PRIORITY: Record<RuleCategory, number> = {
  policy: 0,
  product: 1,
  general: 2,
  tone: 3,
};

export interface RuleBlockOptions {
  maxChars?: number;
  /** Only rules that carry no topic, or carry this one. */
  topic?: string;
  heading?: string;
}

export interface RuleBlock {
  /** Ready to interpolate. Empty string when there are no rules. */
  text: string;
  /** The rules that made it in — pass to `recordApplied`. */
  includedIds: string[];
  /** What did not fit, so the caller can log it rather than discover it later. */
  droppedIds: string[];
}

export function selectRules(rules: Rule[], options: RuleBlockOptions = {}): RuleBlock {
  const budget = options.maxChars ?? DEFAULT_RULE_BUDGET_CHARS;
  const topic = options.topic;

  const eligible = rules.filter(
    rule =>
      rule.enabled &&
      // No topics means the rule is about everything, so it survives every
      // filter. Those are the rules whose absence is most expensive.
      (rule.topics.length === 0 || topic === undefined || rule.topics.includes(topic)),
  );

  // Choose by priority, but emit in the original order: a stable rule block
  // between two runs is what makes their outputs comparable at all.
  const byPriority = [...eligible].sort((a, b) => {
    const diff = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    return diff !== 0 ? diff : a.seq - b.seq;
  });

  const kept = new Set<string>();
  const dropped: string[] = [];
  let used = 0;

  for (const rule of byPriority) {
    const cost = rule.content.length + 4; // "N. " and a newline.
    if (used + cost > budget && kept.size > 0) {
      dropped.push(rule.id);
      continue;
    }
    kept.add(rule.id);
    used += cost;
  }

  const included = eligible.filter(rule => kept.has(rule.id));
  if (included.length === 0) {
    return { text: '', includedIds: [], droppedIds: dropped };
  }

  const heading = options.heading ?? 'Rules you must follow';
  const lines = included.map((rule, index) => `${index + 1}. ${rule.content}`);

  return {
    text: `\n\n**${heading}:**\n${lines.join('\n')}\n`,
    includedIds: included.map(rule => rule.id),
    droppedIds: dropped,
  };
}

/**
 * The rule set as the learning extractor sees it — categorised and with ids,
 * because that prompt asks the model to reason about which rules already
 * exist rather than simply obey them.
 */
export function formatRulesForReview(rules: Rule[]): string {
  if (rules.length === 0) return '(no rules yet)';

  const sections: string[] = [];
  for (const category of RULE_CATEGORIES) {
    const inCategory = rules.filter(rule => rule.category === category);
    if (inCategory.length === 0) continue;
    sections.push(
      `### ${category}\n` +
        inCategory.map(rule => `- [${rule.id}] ${rule.content}`).join('\n'),
    );
  }

  return sections.join('\n\n');
}
