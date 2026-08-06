import { randomUUID } from 'node:crypto';

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
  category: string;
  scope: string | null;
  enabled: number;
  source_task_id: string | null;
  rationale: string | null;
  applied_count: number;
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    seq: row.seq,
    content: row.content,
    category: coerceCategory(row.category),
    scope: row.scope,
    enabled: row.enabled === 1,
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
   * Return rules that are unscoped *or* scoped to this value. Omit to return
   * every scope — which is what an admin listing wants and what a drafting
   * prompt does not.
   */
  scope?: string;
  category?: RuleCategory;
}

export function listRules(options: ListRulesOptions = {}, db: Db = getDb()): Rule[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.enabledOnly) where.push('enabled = 1');
  if (options.category) {
    where.push('category = ?');
    params.push(options.category);
  }
  if (options.scope !== undefined) {
    // An unscoped rule is global, so it belongs to every scope's result.
    where.push('(scope IS NULL OR scope = ?)');
    params.push(options.scope);
  }

  const sql =
    // SQLite's implicit rowid is the insertion counter, and this table is not
    // WITHOUT ROWID, so it is exactly the stable ordering we need.
    'SELECT rowid AS seq, * FROM rules' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    // Insertion order. Not a quality signal, but it is stable, which matters
    // more than it sounds: reordering the rule block between two otherwise
    // identical generations makes their outputs impossible to compare.
    ' ORDER BY rowid ASC';

  return db.prepare(sql).all(...params).map(row => toRule(row as RuleRow));
}

export function getRule(id: string, db: Db = getDb()): Rule | null {
  const row = db.prepare('SELECT rowid AS seq, * FROM rules WHERE id = ?').get(id) as
    | RuleRow
    | undefined;
  return row ? toRule(row) : null;
}

export function createRule(input: NewRule, db: Db = getDb()): Rule {
  const content = input.content.trim();
  if (!content) throw new Error('A rule needs content');

  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO rules
       (id, content, category, scope, enabled, source_task_id, rationale,
        applied_count, last_applied_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, 0, NULL, ?, ?)`,
  ).run(
    id,
    content,
    input.category ?? 'general',
    input.scope ?? null,
    input.sourceTaskId ?? null,
    input.rationale ?? null,
    now,
    now,
  );

  return getRule(id, db)!;
}

export interface RuleUpdate {
  content?: string;
  category?: RuleCategory;
  scope?: string | null;
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
  if (content !== undefined && content !== '' && content !== existing.content) {
    sets.push('content = ?');
    params.push(content);
  }
  if (update.category !== undefined) {
    sets.push('category = ?');
    params.push(update.category);
  }
  if (update.scope !== undefined) {
    sets.push('scope = ?');
    params.push(update.scope);
  }
  if (update.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(update.enabled ? 1 : 0);
  }

  if (sets.length === 0) return existing;

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    db.prepare(`UPDATE rules SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
      ...params,
      now,
      id,
    );

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
  const result = db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  return result.changes > 0;
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
