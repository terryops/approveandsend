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
  {
    version: 2,
    name: 'jobs',
    up: db => {
      db.exec(`
        CREATE TABLE jobs (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          -- The job's arguments, frozen at enqueue time. The predecessor
          -- stored only a task id and re-read the row when the job ran, so a
          -- job's meaning changed depending on how long the queue was — a
          -- learning job that ran after a second edit learned from the wrong
          -- pair of drafts.
          payload     TEXT NOT NULL DEFAULT '{}',
          -- Optional. While a job with this key is unfinished, enqueuing the
          -- same key is a no-op, so a double-clicked Approve learns once.
          dedupe_key  TEXT,
          status      TEXT NOT NULL DEFAULT 'pending',
          priority    INTEGER NOT NULL DEFAULT 5,
          attempts    INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          -- Both the scheduled start and the retry backoff. One column,
          -- because "not before" is the same question in both cases.
          run_after   TEXT NOT NULL,
          -- A claim is a lease, not a flag. If the worker dies mid-job the
          -- lease expires and the job is claimable again, with no separate
          -- sweeper to remember to run.
          lease_expires_at TEXT,
          result      TEXT,
          error       TEXT,
          created_at  TEXT NOT NULL,
          started_at  TEXT,
          finished_at TEXT
        );

        CREATE INDEX idx_jobs_claim ON jobs(status, priority, run_after);
        CREATE INDEX idx_jobs_type ON jobs(type, status);

        -- Enforced by the database rather than by a check-then-insert, which
        -- two workers can both pass.
        CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key)
          WHERE dedupe_key IS NOT NULL
            AND (status = 'pending' OR status = 'processing');
      `);
    },
  },
  {
    version: 3,
    name: 'tasks',
    up: db => {
      db.exec(`
        CREATE TABLE tasks (
          id         TEXT PRIMARY KEY,
          -- pending | drafting | awaiting_review | sent | dismissed | failed
          status     TEXT NOT NULL DEFAULT 'pending',
          -- What kind of mail this is. Set by the analysis and used to scope
          -- which learned rules apply, so a refund rule does not steer a bug
          -- report.
          scope      TEXT,
          priority   INTEGER NOT NULL DEFAULT 5,

          -- The provider's id for the message we are replying to.
          message_id TEXT,
          thread_id  TEXT,
          -- The RFC 5322 Message-ID, which is what threads the reply.
          message_id_header TEXT,

          subject      TEXT NOT NULL DEFAULT '',
          from_address TEXT NOT NULL DEFAULT '',
          from_name    TEXT,
          received_at  TEXT,
          body         TEXT NOT NULL DEFAULT '',

          -- The analysis JSON: intent, sentiment, key points.
          analysis   TEXT,
          -- What the model wrote. Kept after sending: without it the learning
          -- loop has nothing to diff against.
          draft      TEXT,
          -- What the human actually sent.
          final_reply TEXT,
          reviewer_notes TEXT,
          sent_at    TEXT,
          error      TEXT,

          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX idx_tasks_status ON tasks(status, priority, created_at);
        CREATE INDEX idx_tasks_received ON tasks(received_at);

        -- Ingesting the same email twice is a no-op rather than a duplicate
        -- task. The original kept a separate table of deleted message ids to
        -- stop dismissed mail reappearing on the next sync; a uniqueness
        -- constraint plus a 'dismissed' status says the same thing with one
        -- table instead of two.
        CREATE UNIQUE INDEX idx_tasks_message ON tasks(message_id) WHERE message_id IS NOT NULL;
      `);
    },
  },
  {
    version: 4,
    name: 'meta',
    up: db => {
      db.exec(`
        -- Small, boring key/value facts about the installation itself: when
        -- the rulebook was last tidied, and whatever else turns out to need
        -- remembering. A table rather than a JSON file next to the database,
        -- because a file and a database cannot be updated in one transaction
        -- and the pair drifts apart the first time a run is interrupted.
        CREATE TABLE meta (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 5,
    name: 'backfill',
    up: db => {
      db.exec(`
        -- Historical mail the rulebook is being taught from.
        --
        -- Deliberately not the tasks table. These conversations were answered
        -- months ago and need no reply; putting them in tasks would mean five
        -- hundred rows that look actionable, an inbox nobody can read, and a
        -- status enum that has to grow a value meaning "do not offer this to a
        -- human". A separate table costs one join that nothing needs.
        CREATE TABLE backfill_items (
          id TEXT PRIMARY KEY,
          -- The provider id of the reply we sent. The unique key: rescanning
          -- an overlapping window is a no-op rather than a second lesson from
          -- the same email.
          sent_message_id     TEXT NOT NULL,
          -- The message it answered. Not known until the item runs, because
          -- finding it costs a thread fetch.
          incoming_message_id TEXT,

          subject      TEXT NOT NULL DEFAULT '',
          -- Who we were talking to, for the progress list.
          counterparty TEXT NOT NULL DEFAULT '',
          sent_at      TEXT,

          -- pending | learning | learned | skipped | failed
          status      TEXT NOT NULL DEFAULT 'pending',
          -- Why an item taught nothing: no inbound message, an empty body, a
          -- newsletter. Shown rather than hidden — "skipped 300 of 400" is a
          -- fact about your mailbox worth seeing.
          skip_reason TEXT,

          -- What the current assistant would have written. Kept because it is
          -- the evidence for every rule this item produced, and because
          -- re-deriving it costs another generation.
          shadow_draft  TEXT,
          rules_learned INTEGER NOT NULL DEFAULT 0,
          error         TEXT,

          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX idx_backfill_message ON backfill_items(sent_message_id);
        CREATE INDEX idx_backfill_status ON backfill_items(status, sent_at);
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
