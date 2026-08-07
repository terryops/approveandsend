import { randomUUID } from 'node:crypto';

import { normaliseTopicSlug } from '../config/workspace';
import { getDb, type Db } from '../db';
import {
  coerceCategory,
  type NewRule,
  type Rule,
  type RuleCategory,
  type RuleChangeReason,
  type RuleRevision,
} from './types';

interface RuleRow {
  seq: number;
  id: string;
  content: string;
  summary: string | null;
  category: string;
  enabled: number;
  proposed: number;
  replaces: string | null;
  source_task_id: string | null;
  rationale: string | null;
  applied_count: number;
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
  /** Comma-joined by the query below, because SQLite has no array type. */
  topics: string | null;
}

/**
 * Whatever was handed in, reduced to a set of real slugs in a fixed order.
 *
 * Sorted rather than as-given: a rule's topic list is rendered on a page and
 * compared against another rule's in the deduper, and neither should depend
 * on which order somebody happened to tick the boxes.
 */
export function normaliseTopics(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];
  const slugs = new Set<string>();
  for (const value of values) {
    const slug = normaliseTopicSlug(value);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    seq: row.seq,
    content: row.content,
    summary: row.summary,
    category: coerceCategory(row.category),
    topics: row.topics ? row.topics.split(',').sort() : [],
    enabled: row.enabled === 1,
    proposed: row.proposed === 1,
    replaces: row.replaces,
    sourceTaskId: row.source_task_id,
    rationale: row.rationale,
    appliedCount: row.applied_count,
    lastAppliedAt: row.last_applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListRulesOptions {
  enabledOnly?: boolean;
  /**
   * What to do about rules waiting for approval. Excluded unless asked for,
   * which is the whole point: every existing caller feeds a prompt, and the
   * safe answer for a prompt is "a human has not seen this yet, so no".
   * 'include' is for the deduper, which should compare a new proposal against
   * the ones already queued; 'only' is for the page that approves them.
   */
  proposed?: 'exclude' | 'include' | 'only';
  /**
   * Return rules that carry no topic *or* carry this one. Omit to return
   * every rule — which is what an admin listing wants and what a drafting
   * prompt does not.
   */
  topic?: string;
  category?: RuleCategory;
  /**
   * Only rules with no summary yet. The indexing pass's work queue: a rule
   * whose content changed had its summary cleared, so it reappears here.
   */
  unsummarisedOnly?: boolean;
  /** For the indexing pass, which works in batches rather than all at once. */
  limit?: number;
}

// SQLite's implicit rowid is the insertion counter and `rules` is not WITHOUT
// ROWID, so it is exactly the stable ordering we need. The topic list comes
// back joined rather than as extra rows: a rule with three topics must stay
// one rule, and fanning it out here would mean de-duplicating it again in
// every caller.
const SELECT_RULE =
  `SELECT r.rowid AS seq, r.*,
          (SELECT group_concat(topic) FROM rule_topics WHERE rule_id = r.id) AS topics
     FROM rules r`;

export function listRules(options: ListRulesOptions = {}, db: Db = getDb()): Rule[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.enabledOnly) where.push('r.enabled = 1');
  if (options.proposed === 'only') where.push('r.proposed = 1');
  else if (options.proposed !== 'include') where.push('r.proposed = 0');
  if (options.unsummarisedOnly) where.push('r.summary IS NULL');
  if (options.category) {
    where.push('r.category = ?');
    params.push(options.category);
  }
  if (options.topic !== undefined) {
    // A rule with no topics is about everything, so it belongs in every
    // topic's result. This is the clause that does the actual routing.
    where.push(
      `(NOT EXISTS (SELECT 1 FROM rule_topics WHERE rule_id = r.id)
        OR EXISTS (SELECT 1 FROM rule_topics WHERE rule_id = r.id AND topic = ?))`,
    );
    params.push(options.topic);
  }

  const sql =
    SELECT_RULE +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    // Insertion order. Not a quality signal, but it is stable, which matters
    // more than it sounds: reordering the rule block between two otherwise
    // identical generations makes their outputs impossible to compare.
    ' ORDER BY r.rowid ASC' +
    (options.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(options.limit))}` : '');

  return db.prepare(sql).all(...params).map(row => toRule(row as RuleRow));
}

export function getRule(id: string, db: Db = getDb()): Rule | null {
  const row = db.prepare(`${SELECT_RULE} WHERE r.id = ?`).get(id) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

/** Replaces a rule's topics wholesale. Callers pass the full intended set. */
function setTopics(id: string, topics: string[], db: Db): void {
  db.prepare('DELETE FROM rule_topics WHERE rule_id = ?').run(id);
  if (topics.length === 0) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO rule_topics (rule_id, topic) VALUES (?, ?)');
  for (const topic of topics) stmt.run(id, topic);
}

export function createRule(input: NewRule, db: Db = getDb()): Rule {
  const content = input.content.trim();
  if (!content) throw new Error('A rule needs content');

  const now = input.createdAt ?? new Date().toISOString();
  const id = randomUUID();
  const topics = normaliseTopics(input.topics);

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO rules
         (id, content, summary, category, scope, enabled, proposed, replaces, source_task_id,
          rationale, applied_count, last_applied_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    ).run(
      id,
      content,
      input.summary?.trim() || null,
      input.category ?? 'general',
      input.proposed ? 1 : 0,
      // Only a proposal can be aimed at another rule. An approved rule that
      // claimed to replace something would be a rewrite that had already
      // happened, wearing the label of one that had not.
      (input.proposed && input.replaces) || null,
      input.sourceTaskId ?? null,
      input.rationale ?? null,
      now,
      now,
    );
    setTopics(id, topics, db);
  });
  write();

  return getRule(id, db)!;
}

/**
 * A direct edit. Everything here happens immediately and is injected from the
 * next draft onwards, so this is for changes somebody made on purpose — a form
 * on the rules page, or the consolidation pass rewording rules that were all
 * approved already.
 *
 * There is deliberately no `proposed` here. A rewrite that needs approval is
 * not a half-applied update, it is a separate row that has not been applied at
 * all: see `proposeRuleUpdate`.
 */
export interface RuleUpdate {
  content?: string;
  /** Null clears it, which is what a rewritten rule wants until it is resummarised. */
  summary?: string | null;
  category?: RuleCategory;
  /** The complete intended set, not an addition. Empty clears every topic. */
  topics?: string[];
  enabled?: boolean;
}

export interface UpdateContext {
  /** Why this changed. Recorded on the revision when content moves. */
  reason?: RuleChangeReason;
  actor?: string;
}

/**
 * Updates a rule, recording a revision whenever the content actually changes.
 *
 * Returns null for an unknown id rather than throwing: the ids handed to this
 * come from an LLM often enough that a miss is a normal outcome, not an
 * exception.
 */
export function updateRule(
  id: string,
  update: RuleUpdate,
  context: UpdateContext = {},
  db: Db = getDb(),
): Rule | null {
  const existing = getRule(id, db);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  const content = update.content?.trim();
  const contentChanged = content !== undefined && content !== '' && content !== existing.content;
  if (contentChanged) {
    sets.push('content = ?');
    params.push(content);
  }
  if (update.summary !== undefined) {
    sets.push('summary = ?');
    params.push(update.summary?.trim() || null);
  } else if (contentChanged) {
    // A rewritten rule with its old summary still attached is worse than one
    // with no summary: whoever is scanning the list, or choosing which rules
    // to read, is told about a rule that no longer exists. Clearing it puts
    // the rule back in the queue to be summarised again.
    sets.push('summary = NULL');
  }
  if (update.category !== undefined) {
    sets.push('category = ?');
    params.push(update.category);
  }
  if (update.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(update.enabled ? 1 : 0);
  }

  // Topics live in their own table, so they are compared rather than pushed
  // into the SET list — and compared as a set, so that saving a form without
  // touching the checkboxes is not recorded as a change.
  const topics = update.topics === undefined ? null : normaliseTopics(update.topics);
  const topicsChanged = topics !== null && topics.join(',') !== existing.topics.join(',');

  if (sets.length === 0 && !topicsChanged) return existing;

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    if (sets.length > 0) {
      db.prepare(`UPDATE rules SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...params,
        now,
        id,
      );
    } else {
      db.prepare('UPDATE rules SET updated_at = ? WHERE id = ?').run(now, id);
    }

    if (topics && topicsChanged) setTopics(id, topics, db);

    if (content !== undefined && content !== '' && content !== existing.content) {
      db.prepare(
        `INSERT INTO rule_revisions
           (rule_id, previous_content, new_content, reason, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, existing.content, content, context.reason ?? 'manual', context.actor ?? null, now);
    }
  });
  apply();

  return getRule(id, db);
}

export interface ProposedUpdate {
  content: string;
  /** Defaults to the target's, so a rewrite does not silently recategorise it. */
  category?: RuleCategory;
  sourceTaskId?: string | null;
  rationale?: string | null;
}

/**
 * Queues a rewrite of an existing rule instead of performing one.
 *
 * This is what every model-driven change to an approved rule goes through —
 * the learning pass's amendments, and the deduper's merges and replacements.
 * All three take text a model wrote while reading a stranger's email and point
 * it at a rule that is already in every prompt, which is the same escalation
 * as writing a new rule and was not gated as one.
 *
 * The rewrite lands as an ordinary proposal carrying `replaces`, so it is
 * stored, visible, deduped against, and inert. `approveRule` is the only thing
 * that moves it onto the target.
 *
 * Returns null when there is nothing to queue, matching `updateRule`: the ids
 * reaching this come from an LLM, so a miss is a normal outcome.
 */
export function proposeRuleUpdate(
  targetId: string,
  update: ProposedUpdate,
  context: UpdateContext = {},
  db: Db = getDb(),
): Rule | null {
  const target = getRule(targetId, db);
  if (!target) return null;

  const content = update.content.trim();
  if (!content || content === target.content) return null;

  // A target that is itself waiting for approval is not injected anywhere, so
  // there is nothing to protect: rewrite it in place. Stacking a proposal on a
  // proposal would only ask a human to approve the same sentence twice.
  if (target.proposed) {
    return updateRule(
      targetId,
      { content, ...(update.category ? { category: update.category } : {}) },
      context,
      db,
    );
  }

  return createRule(
    {
      content,
      category: update.category ?? target.category,
      // The target's topics, not the candidate's: a rewrite must not quietly
      // widen which mail the rule governs.
      topics: target.topics,
      proposed: true,
      replaces: target.id,
      sourceTaskId: update.sourceTaskId ?? null,
      rationale: update.rationale ?? null,
    },
    db,
  );
}

/**
 * A human has read the proposal and wants it.
 *
 * A proposal that stands on its own becomes an ordinary rule: injected,
 * revisable, and no longer distinguishable from one somebody typed — which is
 * right, because somebody has now agreed to it.
 *
 * A proposal aimed at an existing rule is applied to that rule as a normal
 * revision and then removed, so the target keeps its id, its usage counts and
 * its history, and the text it used to say is recoverable. Either way this
 * function is the single point where text a model wrote becomes text the
 * drafter is told to obey.
 */
export function approveRule(id: string, db: Db = getDb()): Rule | null {
  const proposal = getRule(id, db);
  if (!proposal || !proposal.proposed) return null;

  const target = proposal.replaces ? getRule(proposal.replaces, db) : null;

  // Nothing to apply it to — either it was always standalone, or the rule it
  // was aimed at has since been deleted. The second case still approves the
  // text on its own rather than discarding it: a human is reading this
  // sentence and saying yes to it, and that is the whole test.
  if (!target) {
    const changed = db
      .prepare(
        'UPDATE rules SET proposed = 0, replaces = NULL, updated_at = ? WHERE id = ? AND proposed = 1',
      )
      .run(new Date().toISOString(), id).changes;
    return changed ? getRule(id, db) : null;
  }

  const apply = db.transaction(() => {
    // 'learned' rather than the merge/replace the deduper originally called
    // it: by the time this runs the reason it lands is that somebody approved
    // it, and the mechanism that suggested it is already recorded on the
    // proposal's rationale and source task.
    updateRule(
      target.id,
      { content: proposal.content, category: proposal.category },
      { reason: 'learned', ...(proposal.sourceTaskId ? { actor: proposal.sourceTaskId } : {}) },
      db,
    );
    deleteRule(proposal.id, db);
  });
  apply();

  return getRule(target.id, db);
}

/**
 * Disable rather than delete. A rule absorbed by a merge is evidence about how
 * the merge went, and hard-deleting it means a bad consolidation pass cannot
 * be undone.
 */
export function disableRule(id: string, db: Db = getDb()): Rule | null {
  return updateRule(id, { enabled: false }, {}, db);
}

/** Hard delete. Only for rules a human explicitly wants gone. */
export function deleteRule(id: string, db: Db = getDb()): boolean {
  // No foreign key on rule_topics — see the migration — so the tags are swept
  // here. Left behind they would be invisible rows that a later rule reusing
  // the id would silently inherit.
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM rule_topics WHERE rule_id = ?').run(id);
    return db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
  });
  return remove();
}

/**
 * Records that these rules were put in front of the model.
 *
 * "Was injected" is a weaker signal than "changed the output", but it is the
 * one that can be measured without a second model call, and a rule with a
 * count of zero after a thousand generations is unambiguously dead.
 */
export function recordApplied(ids: string[], db: Db = getDb()): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE rules SET applied_count = applied_count + 1, last_applied_at = ? WHERE id = ?',
  );
  const run = db.transaction((list: string[]) => {
    for (const id of list) stmt.run(now, id);
  });
  run(ids);
}

/**
 * Every revision for a page full of rules, in one query.
 *
 * The rules page needs the history of each rule it renders, and asking per
 * rule is a statement whose cost grows with the rulebook — which is the one
 * thing in this app designed to grow forever. Returns a Map so a rule with no
 * history is a missing key rather than a query that found nothing.
 */
export function revisionsByRule(
  ruleIds: string[],
  db: Db = getDb(),
): Map<string, RuleRevision[]> {
  const grouped = new Map<string, RuleRevision[]>();
  if (ruleIds.length === 0) return grouped;

  const placeholders = ruleIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM rule_revisions WHERE rule_id IN (${placeholders})
       ORDER BY created_at DESC, id DESC`,
    )
    .all(...ruleIds) as RevisionRow[];

  for (const row of rows) {
    const revision = toRevision(row);
    const existing = grouped.get(revision.ruleId);
    if (existing) existing.push(revision);
    else grouped.set(revision.ruleId, [revision]);
  }
  return grouped;
}

interface RevisionRow {
  id: number;
  rule_id: string;
  previous_content: string;
  new_content: string;
  reason: string;
  actor: string | null;
  created_at: string;
}

function toRevision(row: RevisionRow): RuleRevision {
  return {
    id: row.id,
    ruleId: row.rule_id,
    previousContent: row.previous_content,
    newContent: row.new_content,
    reason: row.reason as RuleChangeReason,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export function listRevisions(ruleId: string, db: Db = getDb()): RuleRevision[] {
  const rows = db
    .prepare('SELECT * FROM rule_revisions WHERE rule_id = ? ORDER BY created_at DESC, id DESC')
    .all(ruleId) as RevisionRow[];

  return rows.map(toRevision);
}
