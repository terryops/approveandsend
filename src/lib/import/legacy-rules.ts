import Database from 'better-sqlite3';

import { getDb, type Db } from '../db';
import { enqueueSummariseRules } from '../queue/handlers/summarise-rules';
import { createRule, listRules } from '../rules/store';
import { coerceCategory } from '../rules/types';

/**
 * Reading the rulebook out of the system this replaced.
 *
 * The archive of answered mail is the obvious thing to carry over. The rules
 * are the valuable one. A conversation from March is context; a rule from
 * March is a decision somebody made after getting a reply wrong, and there is
 * no way to regenerate it from the mail — the reasoning that produced it lived
 * in a person's head on the day.
 *
 * The old desk's `analysis_rules` and this project's `rules` are close enough
 * to copy across field by field, including the four categories, because one
 * was extracted from the other. What is missing is the summary line, and that
 * is deliberate: they are left null and the indexing job writes them, which is
 * one model call per batch against text that is already sitting there. Nothing
 * blocks on it — an unsummarised rule is injected in full and obeyed in full;
 * it is only missing from the scannable list until the pass catches up.
 */

export interface LegacyRulesOptions {
  /** Path to the old `tasks.db`. Opened read-only. */
  path: string;
  /** For a trial run over the first few rows. */
  limit?: number;
  db?: Db;
}

export interface LegacyRulesResult {
  read: number;
  imported: number;
  /** Same text already present. A second run of the same import. */
  alreadyThere: number;
  /** Imported with `enabled = 0`, as they were. */
  disabled: number;
  byCategory: Record<string, number>;
}

interface LegacyRuleRow {
  id: string;
  content: string;
  category: string | null;
  enabled: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Two rules are the same rule when they say the same thing.
 *
 * Not by id: the old ids are `rule_<millis>_<random>` and this project's are
 * UUIDs, so carrying them across would mean a second id column that exists
 * only to make a re-import idempotent. Whitespace is normalised because the
 * old editor was a textarea and a trailing newline is not a different policy.
 */
function fingerprint(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function importLegacyRules(options: LegacyRulesOptions): LegacyRulesResult {
  const db = options.db ?? getDb();
  const result: LegacyRulesResult = {
    read: 0,
    imported: 0,
    alreadyThere: 0,
    disabled: 0,
    byCategory: {},
  };

  // Including proposals: a re-import that adds a rule already queued for
  // approval is not idempotent, it just puts the same sentence in front of the
  // operator twice.
  const seen = new Set(
    listRules({ proposed: 'include' }, db).map(rule => fingerprint(rule.content)),
  );
  const old = new Database(options.path, { readonly: true, fileMustExist: true });

  try {
    const rows = old
      .prepare(
        `SELECT id, content, category, enabled, created_at, updated_at
           FROM analysis_rules
          ORDER BY created_at ASC${options.limit ? ` LIMIT ${Number(options.limit)}` : ''}`,
      )
      .all() as LegacyRuleRow[];

    for (const row of rows) {
      result.read += 1;

      const content = (row.content ?? '').trim();
      const mark = fingerprint(content);
      if (!content || seen.has(mark)) {
        result.alreadyThere += 1;
        continue;
      }
      seen.add(mark);

      const category = coerceCategory(row.category);
      const rule = createRule(
        {
          content,
          category,
          // Fifteen months of decisions, not one afternoon's. The dates are
          // what say which of these have been surviving contact with
          // customers the longest.
          createdAt: row.created_at,
        },
        db,
      );

      // A rule somebody turned off is a decision too, and one that is easy to
      // lose: it arrives switched on, gets injected into every draft, and the
      // reason it was retired has to be rediscovered by reading a bad reply.
      if (row.enabled === 0) {
        db.prepare('UPDATE rules SET enabled = 0 WHERE id = ?').run(rule.id);
        result.disabled += 1;
      }

      result.imported += 1;
      result.byCategory[category] = (result.byCategory[category] ?? 0) + 1;
    }
  } finally {
    old.close();
  }

  // Once, at the end. The job is deduped on a fixed key and works the whole
  // backlog in batches, re-enqueuing itself until there is none — so two
  // hundred rules cost one enqueue here and nothing on the review path.
  if (result.imported > 0) enqueueSummariseRules({ db });

  return result;
}
