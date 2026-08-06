import { callAI } from '../ai';
import { getDb, type Db } from '../db';
import { getMeta, setMeta } from '../db/meta';
import { extractJson } from '../json-repair';
import { disableRule, getRule, listRules, updateRule } from './store';
import { RULE_CATEGORIES, type Rule, type RuleCategory } from './types';

/**
 * The periodic tidy of the whole rulebook.
 *
 * Dedup at write time (`dedup.ts`) compares one candidate against a shortlist,
 * which catches the obvious duplicate and cannot catch cumulative drift: ten
 * rules that each overlap the next by a third, none of them a clean duplicate
 * of any other. Left alone that is how a rulebook becomes six thousand
 * characters of near-repetition and the drafter starts ignoring all of it.
 *
 * So this looks at every enabled rule in a category at once and proposes
 * groupings. Two properties make it safe to run unattended:
 *
 *   - Every rule ends up in exactly one group. A rule the model forgot to
 *     mention is kept as-is, not dropped (see `salvageGroups`).
 *   - A group of one is left byte-identical. The model is not permitted to
 *     "keep" a rule and rewrite it on the way through, which it does
 *     constantly — reflowing text, changing quote marks, translating.
 *
 * And the result is reversible: absorbed rules are disabled, never deleted,
 * and the surviving rule's old text is in `rule_revisions`.
 */

/** What the rulebook looked like at the end of the last pass. Drives the gate. */
export const LAST_CONSOLIDATION = 'rules.lastConsolidation';

/**
 * The mark the gate counts from.
 *
 * Not a timestamp. Two rules written in the same millisecond as the stamp are
 * indistinguishable from rules written before it, and "was this rule written
 * before or after the tidy?" then has no answer — which is how a rulebook
 * gets tidied twice or never. `seq` is SQLite's insertion counter and `edits`
 * only ever goes up, so both comparisons are exact.
 */
interface Watermark {
  /** Highest rule rowid at the end of the pass. */
  seq: number;
  /** Revisions made by anything other than a consolidation. */
  edits: number;
  /** For display only. */
  at: string;
}

function watermark(db: Db): Watermark {
  const seq = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM rules').get() as { n: number }).n;
  const edits = (
    db
      .prepare("SELECT COUNT(*) AS n FROM rule_revisions WHERE reason != 'consolidation'")
      .get() as { n: number }
  ).n;
  return { seq, edits, at: new Date().toISOString() };
}

function lastWatermark(db: Db): Watermark | null {
  const raw = getMeta(LAST_CONSOLIDATION, db);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Watermark>;
    return {
      seq: Number(parsed.seq) || 0,
      edits: Number(parsed.edits) || 0,
      at: typeof parsed.at === 'string' ? parsed.at : 'unknown',
    };
  } catch {
    return null;
  }
}

export interface ConsolidationGroup {
  /** The text the surviving rule will carry. */
  content: string;
  /** Rule ids in this group. The first keeps its id; the rest are disabled. */
  absorbs: string[];
  /** The model's one-line justification, when it gave one. */
  note: string | null;
}

export interface CategoryPlan {
  category: RuleCategory;
  before: number;
  after: number;
  groups: ConsolidationGroup[];
}

export interface ConsolidationPlan {
  before: number;
  after: number;
  categories: CategoryPlan[];
}

export interface ConsolidationSummary {
  /** Groups that actually combined two or more rules. */
  merged: number;
  /** Surviving rules whose text changed. */
  rewritten: number;
  /** Rules switched off because another rule now says what they said. */
  disabled: number;
}

/**
 * How many rules one call is asked to group.
 *
 * Larger batches find more merges — a duplicate the model never sees is a
 * duplicate it cannot merge — but the output grows with the input, and a long
 * structured response is where self-hosted models start truncating. Eighteen
 * is the largest size that came back complete in practice.
 */
const BATCH_SIZE = 18;

/** The cross-batch pass emits more per rule, so it works in smaller bites. */
const CROSS_CHUNK_SIZE = 8;

function buildPrompt(category: string, rules: { id: string; content: string }[]): string {
  return `You are tidying the rulebook of a customer-support reply assistant.

Below is every rule in the "${category}" category. They were added one at a
time over months, so the set contains near-duplicates, fragments, and rules
that say the same thing in different words.

Group them. Rules that express the same instruction become one rule, worded so
that nothing any of them required is lost.

## The rules (${rules.length})
${rules.map((rule, index) => `${index + 1}. [${rule.id}] ${rule.content}`).join('\n')}

## How to group

- Same instruction in different words → one group, keeping the clearest and
  most complete wording.
- A fragment or a one-off that only makes sense as a condition on another rule
  → fold it into that rule.
- **Be conservative.** If two rules differ in when they apply or in what they
  require, they stay separate. Fewer rules is not the goal; a rulebook that
  still says everything it used to say is.
- A merged rule must still be one specific, actionable sentence.
- Every rule must appear in exactly one group — no rule twice, no rule
  missing. A rule you would not change is its own group of one, with its
  content copied across **unchanged, character for character**.

Reply with JSON only:
{
  "groups": [
    { "content": "the rule after merging", "absorbs": ["ids in this group"], "note": "why, briefly" }
  ]
}`;
}

/**
 * Turns whatever the model returned into groups that cover every input rule
 * exactly once.
 *
 * This is deliberately forgiving, because the failure it prevents is losing a
 * rule. Models return ids with trailing junk, repeat an id across two groups,
 * and quietly drop a few when the list is long. Unknown or repeated ids are
 * discarded; anything left uncovered is kept as its own group with its
 * original text.
 *
 * @param exactOnly Disables prefix matching. The cross-batch pass uses
 * synthetic ids like `g_1` and `g_12`, where a prefix match is a wrong match.
 */
export function salvageGroups(
  raw: unknown,
  rules: { id: string; content: string }[],
  { exactOnly = false }: { exactOnly?: boolean } = {},
): ConsolidationGroup[] {
  const byId = new Map(rules.map(rule => [rule.id, rule]));
  const knownIds = [...byId.keys()];

  const resolve = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string') return null;
    const id = candidate.trim();
    if (byId.has(id)) return id;
    if (exactOnly) return null;
    // The longest known id this is a prefix of — handles trailing junk.
    const matches = knownIds.filter(known => id.startsWith(known)).sort((a, b) => b.length - a.length);
    return matches[0] ?? null;
  };

  const seen = new Set<string>();
  const groups: ConsolidationGroup[] = [];

  for (const entry of Array.isArray(raw) ? raw : []) {
    const group = (entry ?? {}) as { content?: unknown; absorbs?: unknown; note?: unknown };
    const ids: string[] = [];

    for (const candidate of Array.isArray(group.absorbs) ? group.absorbs : []) {
      const id = resolve(candidate);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (ids.length === 0) continue;

    const original = byId.get(ids[0]!)!;
    const content =
      typeof group.content === 'string'
        ? // Models like to echo the id back inside the text.
          group.content.replace(/^\s*(\[[^\]]+\]\s*)+/, '').trim()
        : '';

    groups.push({
      content: content || original.content,
      absorbs: ids,
      note: typeof group.note === 'string' && group.note.trim() ? group.note.trim() : null,
    });
  }

  for (const id of knownIds) {
    if (seen.has(id)) continue;
    groups.push({ content: byId.get(id)!.content, absorbs: [id], note: 'kept (not covered)' });
  }

  return groups;
}

async function groupOnce(
  category: string,
  rules: { id: string; content: string }[],
  { exactOnly = false }: { exactOnly?: boolean } = {},
): Promise<ConsolidationGroup[]> {
  if (rules.length <= 1) {
    return rules.map(rule => ({ content: rule.content, absorbs: [rule.id], note: null }));
  }

  const response = await callAI(buildPrompt(category, rules), { role: 'utility' });
  const parsed = extractJson<{ groups?: unknown }>(response);
  return salvageGroups(parsed?.groups, rules, { exactOnly });
}

async function consolidateCategory(
  category: RuleCategory,
  rules: Rule[],
  batchSize: number,
  crossChunkSize: number,
): Promise<ConsolidationGroup[]> {
  if (rules.length <= batchSize) return groupOnce(category, rules);

  const batches: Rule[][] = [];
  for (let i = 0; i < rules.length; i += batchSize) batches.push(rules.slice(i, i + batchSize));

  // Sequential on purpose. This is a weekly job against what is often one
  // self-hosted model; wall-clock time is worth nothing here and a queue of
  // parallel requests against a single GPU is slower than going in order.
  const groups: ConsolidationGroup[] = [];
  for (const batch of batches) groups.push(...(await groupOnce(category, batch)));

  if (groups.length <= crossChunkSize) return groups;

  // Nothing has yet compared a rule in batch 1 with a rule in batch 3. Run the
  // results through a second pass, distributing by stride so that neighbours
  // from the same batch — which have already been compared — land in
  // different chunks.
  const synthetic = groups.map((group, index) => ({ id: `g_${index}`, content: group.content }));
  const chunkCount = Math.ceil(synthetic.length / crossChunkSize);
  const chunks: { id: string; content: string }[][] = Array.from({ length: chunkCount }, () => []);
  synthetic.forEach((entry, index) => chunks[index % chunkCount]!.push(entry));

  const merged: ConsolidationGroup[] = [];
  for (const chunk of chunks) {
    const metaGroups = await groupOnce(category, chunk, { exactOnly: true });
    for (const metaGroup of metaGroups) {
      const absorbs = metaGroup.absorbs.flatMap(
        id => groups[Number(id.slice('g_'.length))]?.absorbs ?? [],
      );
      if (absorbs.length > 0) merged.push({ ...metaGroup, absorbs });
    }
  }

  return merged;
}

export interface PlanOptions {
  batchSize?: number;
  crossChunkSize?: number;
  /** Restrict the pass to one category. Mostly for trying it out. */
  category?: RuleCategory;
  db?: Db;
}

export async function planConsolidation(options: PlanOptions = {}): Promise<ConsolidationPlan> {
  const db = options.db ?? getDb();
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const crossChunkSize = options.crossChunkSize ?? CROSS_CHUNK_SIZE;

  const all = listRules({ enabledOnly: true }, db);
  const categories: CategoryPlan[] = [];

  for (const category of RULE_CATEGORIES) {
    if (options.category && options.category !== category) continue;

    const rules = all.filter(rule => rule.category === category);
    if (rules.length === 0) continue;

    const groups = await consolidateCategory(category, rules, batchSize, crossChunkSize);
    categories.push({ category, before: rules.length, after: groups.length, groups });
  }

  return {
    before: categories.reduce((sum, plan) => sum + plan.before, 0),
    after: categories.reduce((sum, plan) => sum + plan.after, 0),
    categories,
  };
}

export interface ApplyOptions {
  actor?: string;
  db?: Db;
}

/**
 * Writes a plan.
 *
 * Groups of one are skipped entirely rather than written back unchanged: the
 * model was told to copy them verbatim and does not reliably do so, and a
 * silent rewrite of a rule nobody meant to change is the one outcome this pass
 * must not have.
 */
export function applyConsolidation(
  plan: ConsolidationPlan,
  options: ApplyOptions = {},
): ConsolidationSummary {
  const db = options.db ?? getDb();
  const context = { reason: 'consolidation' as const, ...(options.actor ? { actor: options.actor } : {}) };
  const summary: ConsolidationSummary = { merged: 0, rewritten: 0, disabled: 0 };

  const write = db.transaction(() => {
    for (const category of plan.categories) {
      for (const group of category.groups) {
        if (group.absorbs.length < 2) continue;

        const [primary, ...absorbed] = group.absorbs as [string, ...string[]];
        const existing = getRule(primary, db);
        if (!existing) continue;

        const content = group.content.trim();
        if (content && content !== existing.content) {
          updateRule(primary, { content }, context, db);
          summary.rewritten += 1;
        }

        summary.merged += 1;
        for (const id of absorbed) {
          if (disableRule(id, db)) summary.disabled += 1;
        }
      }
    }

    setMeta(LAST_CONSOLIDATION, JSON.stringify(watermark(db)), db);
  });
  write();

  return summary;
}

export interface GateResult {
  shouldRun: boolean;
  /** Rules added or hand-edited since the last pass. */
  changed: number;
  /** When the last pass ran, or 'never'. */
  since: string;
}

/**
 * Whether a pass is worth the LLM calls.
 *
 * Consolidating an unchanged rulebook produces the same groups it produced
 * last week, at the cost of a call per batch. The threshold is on rules
 * *written* rather than on elapsed time, because a quiet week genuinely has
 * nothing to tidy — and the pass's own rewrites are excluded, so a tidy never
 * counts as a reason to tidy again.
 */
export function consolidationGate(
  { threshold = 3, db = getDb() }: { threshold?: number; db?: Db } = {},
): GateResult {
  const last = lastWatermark(db);
  const now = watermark(db);

  const added = last
    ? (db.prepare('SELECT COUNT(*) AS n FROM rules WHERE enabled = 1 AND rowid > ?').get(last.seq) as {
        n: number;
      }).n
    : (db.prepare('SELECT COUNT(*) AS n FROM rules WHERE enabled = 1').get() as { n: number }).n;

  const changed = added + Math.max(0, now.edits - (last?.edits ?? 0));

  return { shouldRun: changed > threshold, changed, since: last?.at ?? 'never' };
}
