import type { Database } from 'better-sqlite3';

/**
 * Numbered migrations against `PRAGMA user_version`.
 *
 * The system this was extracted from had no migration framework — it ran
 * `ALTER TABLE … ADD COLUMN` inside a try/catch on every request and swallowed
 * the error. That works right up until a change needs a data backfill or has to
 * happen in a particular order, at which point there is no way to know what
 * state a given deployment is in.
 */

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'rules',
    up: db => {
      db.exec(`
        CREATE TABLE rules (
          id             TEXT PRIMARY KEY,
          content        TEXT NOT NULL,
          category       TEXT NOT NULL DEFAULT 'general',
          -- NULL means "applies to every kind of mail". A non-null value
          -- confines the rule to one task type, so a rule learned while
          -- handling refunds does not silently steer unrelated replies.
          scope          TEXT,
          enabled        INTEGER NOT NULL DEFAULT 1,
          -- Which conversation taught us this. Without it you cannot answer
          -- "why does the drafter believe this?", and that question gets asked
          -- the first time a rule produces a bad reply.
          source_task_id TEXT,
          -- The extractor's justification, kept for the same reason.
          rationale      TEXT,
          -- Usage telemetry. Cheap now, impossible to backfill later, and the
          -- only basis on which a rule can ever be retired automatically.
          applied_count  INTEGER NOT NULL DEFAULT 0,
          last_applied_at TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );

        CREATE INDEX idx_rules_enabled ON rules(enabled, created_at);
        CREATE INDEX idx_rules_category ON rules(category);
        CREATE INDEX idx_rules_scope ON rules(scope);

        -- Every content change, so a bad merge is recoverable. The predecessor
        -- let the learning job overwrite a rule's text from an LLM-supplied id
        -- with no record of what it had said before.
        CREATE TABLE rule_revisions (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id         TEXT NOT NULL,
          previous_content TEXT NOT NULL,
          new_content     TEXT NOT NULL,
          -- 'manual' | 'learned' | 'merge' | 'replace' | 'consolidation'
          reason          TEXT NOT NULL,
          actor           TEXT,
          created_at      TEXT NOT NULL
        );

        CREATE INDEX idx_rule_revisions_rule ON rule_revisions(rule_id, created_at);
      `);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function currentVersion(db: Database): number {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

/** Applies every migration newer than the database's recorded version. */
export function migrate(db: Database): number {
  const from = currentVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;

    // Each migration is its own transaction: a failure half way through a run
    // leaves the database at the last version that fully applied, not at some
    // state no migration describes.
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }

  return currentVersion(db);
}
