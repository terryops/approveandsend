import { callAI } from '../ai';
import { extractJson } from '../json-repair';
import type { Rule } from './types';

/**
 * Reading the rules that did not fit.
 *
 * Routing plus a 20k budget is enough for every topic on the desk this was
 * built against, so on that rulebook nothing here ever runs. It exists for the
 * desk that keeps writing rules — the one property this whole system is
 * designed around is that the rulebook grows forever — and it is what happens
 * instead of the budget silently dropping them.
 *
 * The trade being made: a rule the model chose to read is better than a rule
 * nobody chose to drop, and worse than a rule that was simply there. So this
 * engages only once the budget actually bites, and it is never allowed to
 * decide anything about policy. `selectRules` exempts policy from the budget
 * outright, so a policy rule cannot reach this code at all — the choice on
 * offer here is only ever between product, general and tone rules, where the
 * cost of a wrong pick is a reply that reads slightly off rather than one that
 * promises money back.
 *
 * The index is summaries, not text, which is the only reason this is cheap:
 * three hundred one-line summaries cost a fraction of three hundred rules, and
 * the model reads the full text of the handful it asks for.
 */

/**
 * How much full text a retrieval may add.
 *
 * Half the main budget. Generous enough that a genuinely unusual email can
 * pull in what it needs, small enough that a model answering "all of them"
 * cannot undo the budget it was working around.
 */
export const RETRIEVAL_BUDGET_CHARS = 10_000;

/** Ceiling on how many a model may ask for, before the character budget. */
const MAX_REQUESTED = 12;

/** As much of a rule as stands in for it when nothing has summarised it yet. */
const FALLBACK_CHARS = 100;

/**
 * The line a rule appears as in the index.
 *
 * A rule with no summary yet is listed by its opening rather than left out.
 * Left out it would be unreachable — invisible to the budget and invisible to
 * the model — which is the failure this file exists to end, and a bad index
 * entry is a much smaller problem than an unreachable rule.
 */
function indexLine(rule: Rule): string {
  if (rule.summary) return `[${rule.id}] ${rule.summary}`;
  const flat = rule.content.replace(/\s+/g, ' ').trim();
  const short = flat.length > FALLBACK_CHARS ? `${flat.slice(0, FALLBACK_CHARS - 1)}…` : flat;
  return `[${rule.id}] ${short}`;
}

export interface RetrievalRequest {
  subject: string;
  body: string;
  /** The rules the budget pushed out, in the order they were written. */
  available: Rule[];
}

export interface RetrievalResult {
  /** Full rules to add to the prompt, in the order they were written. */
  rules: Rule[];
  /** Asked for but not returned — over the ceiling, or over the budget. */
  refusedIds: string[];
}

function buildPrompt(request: RetrievalRequest): string {
  return `An assistant is about to answer the customer email below. It already has the guidance that applies to every reply, and to this kind of mail. The rules listed here did not fit alongside it.

Each line is one rule, summarised. Say which of them the assistant needs to read in full before it answers. Pick only the ones that bear on this particular email — an assistant given rules it does not need follows them anyway and answers a question nobody asked. Picking none is a normal answer.

Rules available:
${request.available.map(indexLine).join('\n')}

Subject: ${request.subject}

${request.body}

JSON only, at most ${MAX_REQUESTED} ids:
{"read": ["<id>", "<id>"]}`;
}

/**
 * Which of the dropped rules this email needs, in full.
 *
 * Every unhappy path returns nothing, which is exactly the behaviour before
 * this existed: the rules that fit go in and the rest do not. A retrieval that
 * fails must not cost a draft.
 */
export async function retrieveRules(request: RetrievalRequest): Promise<RetrievalResult> {
  const empty: RetrievalResult = { rules: [], refusedIds: [] };
  if (request.available.length === 0) return empty;

  let parsed: { read?: unknown } | null;
  try {
    parsed = extractJson<{ read?: unknown }>(
      await callAI(buildPrompt(request), { role: 'utility', temperature: 0 }),
    );
  } catch (error) {
    console.warn('[rules] retrieval failed, drafting without the rules that did not fit:', error);
    return empty;
  }

  if (!parsed || !Array.isArray(parsed.read)) return empty;

  const byId = new Map(request.available.map(rule => [rule.id, rule]));
  const wanted: Rule[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();

  for (const value of parsed.read) {
    if (typeof value !== 'string') continue;
    const rule = byId.get(value);
    // A rule it was not shown. Not an error worth failing over — it is a model
    // inventing an id — but not something to go looking for either.
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);

    if (wanted.length >= MAX_REQUESTED) {
      refused.push(rule.id);
      continue;
    }
    wanted.push(rule);
  }

  const kept: Rule[] = [];
  let used = 0;
  for (const rule of wanted) {
    const cost = rule.content.length + 4;
    if (used + cost > RETRIEVAL_BUDGET_CHARS && kept.length > 0) {
      refused.push(rule.id);
      continue;
    }
    kept.push(rule);
    used += cost;
  }

  // Written order, not the order it asked for. The same reason the main block
  // is ordered by insertion: a prompt that reorders itself between two runs
  // makes their outputs impossible to compare.
  kept.sort((a, b) => a.seq - b.seq);

  return { rules: kept, refusedIds: refused };
}

/** The retrieved rules as a second block, appended after the main one. */
export function formatRetrieved(rules: Rule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((rule, index) => `${index + 1}. ${rule.content}`);
  return `\n\n**Also relevant to this email:**\n${lines.join('\n')}\n`;
}
