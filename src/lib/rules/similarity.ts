/**
 * A cheap shortlist of rules that might duplicate a candidate.
 *
 * The point is to bound the dedup prompt. The original implementation put
 * every enabled rule into the prompt for every candidate — at 135 rules that
 * is already most of a context window, and it grows without limit precisely
 * because the system is working. Scoring locally and sending the top handful
 * turns an O(all rules) prompt into a fixed one.
 *
 * This is deliberately not embeddings. Rules are short, written by the same
 * model in the same register, and near-duplicates share obvious vocabulary;
 * token overlap with IDF weighting finds them, costs nothing, needs no
 * service, and — unlike a similarity threshold — never makes the final call.
 * The LLM still decides. This only chooses whom it gets to consider.
 */

/**
 * Words too common in this corpus to distinguish anything. Not a general
 * English stopword list — these are the words that appear in a support rule
 * *because* it is a support rule.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'dont', 'for', 'from', 'if',
  'in', 'into', 'is', 'it', 'its', 'must', 'never', 'not', 'of', 'on', 'or', 'should', 'that',
  'the', 'their', 'them', 'then', 'they', 'this', 'to', 'use', 'was', 'we', 'what', 'when',
  'which', 'with', 'you', 'your',
  // Domain filler: every other rule says one of these.
  'always', 'customer', 'email', 'reply', 'user', 'message', 'response', 'support',
]);

/**
 * Splits on non-word characters, and additionally treats each CJK character as
 * its own token — CJK does not delimit words with spaces, so a whitespace
 * tokeniser reduces a Chinese rule to one enormous token that matches nothing.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(raw)) {
      for (const char of raw) tokens.push(char);
      continue;
    }
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    tokens.push(raw);
  }

  return tokens;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Ranks `items` by weighted token overlap with `query`.
 *
 * Rare shared tokens count for more than common ones (IDF), and the score is
 * normalised by the candidate's own weight so that a long rule cannot outrank
 * a short exact duplicate just by containing more words.
 */
export function rankBySimilarity<T>(
  query: string,
  items: T[],
  text: (item: T) => string,
): Scored<T>[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0 || items.length === 0) return [];

  const documents = items.map(item => new Set(tokenize(text(item))));

  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const token of doc) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const total = documents.length;
  const idf = (token: string): number =>
    Math.log(1 + total / (1 + (documentFrequency.get(token) ?? 0)));

  let queryWeight = 0;
  for (const token of queryTokens) queryWeight += idf(token);
  if (queryWeight === 0) return [];

  const scored: Scored<T>[] = [];
  for (const [index, doc] of documents.entries()) {
    let shared = 0;
    let docWeight = 0;
    for (const token of doc) {
      const weight = idf(token);
      docWeight += weight;
      if (queryTokens.has(token)) shared += weight;
    }
    if (shared === 0) continue;

    // Symmetric: penalises a candidate that merely contains the query as much
    // as one the query merely contains.
    const score = (2 * shared) / (queryWeight + docWeight);
    scored.push({ item: items[index]!, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * The rules worth asking the model about. `limit` bounds the prompt; `floor`
 * drops candidates with nothing meaningful in common, so a genuinely novel
 * rule can produce an empty shortlist and skip the call entirely.
 */
export function shortlist<T>(
  query: string,
  items: T[],
  text: (item: T) => string,
  { limit = 12, floor = 0.05 }: { limit?: number; floor?: number } = {},
): T[] {
  return rankBySimilarity(query, items, text)
    .filter(s => s.score >= floor)
    .slice(0, limit)
    .map(s => s.item);
}
