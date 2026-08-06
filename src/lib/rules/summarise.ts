import { callAI } from '../ai';
import { getDb, type Db } from '../db';
import { extractJson } from '../json-repair';
import type { Rule } from './types';

/**
 * Giving every rule a one-line description of what it is about.
 *
 * Two readers need to know *whether* a rule bears on something before paying
 * to read it: a person scanning a rulebook of several hundred, and the drafter
 * choosing which rules to pull in when they no longer all fit. Neither is
 * served by the first sentence of the rule, which is almost always its trigger
 * condition — "If the customer bought through AppSumo" reads like a summary
 * and tells you nothing about what happens next.
 *
 * What a summary is not: a substitute for the rule. Nothing here is ever put
 * in front of the drafter in place of a rule it is expected to obey. A model
 * that has read "about refund windows" and not the rule will invent the
 * window.
 */

/**
 * How many rules go into one call.
 *
 * Rules average a couple of hundred characters after splitting, so forty is a
 * prompt of roughly ten thousand — big enough that the per-call overhead
 * disappears, small enough that one malformed response costs forty summaries
 * and not four hundred.
 */
export const SUMMARY_BATCH = 40;

/** Long enough to name a subject and a condition, short enough to scan. */
const MAX_SUMMARY_CHARS = 120;

function buildPrompt(rules: readonly Rule[]): string {
  const items = rules.map(rule => `[${rule.id}]\n${rule.content}`).join('\n\n');

  return `You are indexing a rulebook that an assistant follows when it drafts replies to customer email.

For each rule below, write one short line saying what the rule is ABOUT — the subject it governs and, if there is one, the situation that triggers it. Someone reading only your line must be able to decide whether the rule bears on the email in front of them.

Requirements:
- At most ${MAX_SUMMARY_CHARS} characters. One line. No trailing full stop needed.
- Describe the subject, do not restate the instruction. "When a refund is requested after the 30-day window" is right. "Tell them the window has passed" is not.
- Never include specific numbers, prices, deadlines or wording from the rule. Someone must have to open the rule to learn those.
- Write in English regardless of the language the rule is written in.
- Return every id you were given, exactly as given.

Return JSON only:
{"summaries": [{"id": "<the id>", "summary": "<one line>"}]}

Rules:

${items}`;
}

/**
 * Summaries for a batch, keyed by rule id.
 *
 * Ids the model did not answer for, or answered for with something unusable,
 * are simply absent. That is the honest outcome: the caller leaves those rules
 * unsummarised and they come round again on the next pass, which is much
 * better than storing a guess that a person will later read as fact.
 */
export async function summariseRules(rules: readonly Rule[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rules.length === 0) return out;

  const known = new Set(rules.map(rule => rule.id));
  const response = await callAI(buildPrompt(rules), { role: 'utility' });
  const parsed = extractJson<{ summaries?: unknown }>(response);
  if (!Array.isArray(parsed?.summaries)) return out;

  for (const entry of parsed.summaries) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, summary } = entry as { id?: unknown; summary?: unknown };
    if (typeof id !== 'string' || !known.has(id)) continue;
    if (typeof summary !== 'string') continue;

    // Models like to echo the bracketed id back into the text, and to answer
    // in several lines when asked for one.
    const line = summary
      .replace(/^\s*(\[[^\]]+\]\s*)+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;

    out.set(id, line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…` : line);
  }

  return out;
}

/**
 * Attaches a summary, but only while the rule still says what was summarised.
 *
 * The content is the guard rather than a timestamp because that is the thing
 * the summary describes. A rule edited between the read and the write gets no
 * summary and comes round again, which is the same outcome as the model
 * skipping it — and far better than a rule carrying a description of the text
 * it used to have.
 *
 * Deliberately does not touch `updated_at`: adding an index entry is not an
 * edit to the rule, and a rulebook that looks freshly modified every time it
 * is indexed is one nobody can scan for real changes.
 */
export function attachSummary(
  id: string,
  summary: string,
  contentSeen: string,
  db: Db = getDb(),
): boolean {
  return (
    db
      .prepare('UPDATE rules SET summary = ? WHERE id = ? AND content = ?')
      .run(summary, id, contentSeen).changes > 0
  );
}
