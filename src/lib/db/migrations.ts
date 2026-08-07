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
          -- pending | drafting | awaiting_review | sending | sent | dismissed | failed
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
  {
    version: 6,
    name: 'task-context',
    up: db => {
      // One row per source per task, rather than a JSON column on `tasks`.
      // Sources are looked up in parallel and each finishes when it finishes;
      // a shared column would mean two writers racing over one blob, and the
      // loser's lookup would vanish.
      db.exec(`
        CREATE TABLE task_context (
          task_id   TEXT NOT NULL,
          source_id TEXT NOT NULL,
          label TEXT NOT NULL,
          title TEXT NOT NULL,
          href  TEXT,
          fields TEXT NOT NULL DEFAULT '[]',
          prompt TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,

          PRIMARY KEY (task_id, source_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 7,
    name: 'sender-index',
    up: db => {
      // "Everything we have already sent this address" is asked once per
      // incoming email, by the history context source. Case-insensitive
      // because addresses arrive capitalised however the sender's client felt
      // like it, and the collation is declared on the index so the lookup can
      // actually use it.
      db.exec('CREATE INDEX idx_tasks_from ON tasks(from_address COLLATE NOCASE, status);');
    },
  },
  {
    version: 8,
    name: 'task-translations',
    up: db => {
      // A translation for the reviewer, never for the customer.
      //
      // `source_hash` is what keeps it honest. A translation is only ever shown
      // beside the exact text it was made from, so a draft that has since been
      // rewritten shows no translation rather than the previous draft's — which
      // is the failure mode that matters here, because a reviewer who cannot
      // read the reply has no way of noticing the two have drifted apart.
      db.exec(`
        CREATE TABLE task_translations (
          task_id  TEXT NOT NULL,
          kind     TEXT NOT NULL,
          language TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          content  TEXT NOT NULL,
          created_at TEXT NOT NULL,

          PRIMARY KEY (task_id, kind),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 9,
    name: 'operators',
    up: db => {
      // The people doing the approving, by name.
      //
      // No roles column, and that is the design rather than an omission. A
      // support desk of four people does not need a permission matrix; what it
      // needs is to be able to answer "who sent that?" six weeks later. Roles
      // would add a way for the system to say no to someone, which is a cost,
      // in exchange for a restriction nobody asked for.
      //
      // `ADMIN_PASSWORD` still works and still logs in as nobody in
      // particular, so an install that never adds an operator is unchanged.
      db.exec(`
        CREATE TABLE operators (
          id   TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          -- scrypt$N$r$p$salt$hash, base64url. The system this came from kept
          -- plaintext passwords in a source file.
          password_hash TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          last_seen_at TEXT,
          -- Disabled, never deleted. Their name is on replies that were sent,
          -- and a foreign key that dangles turns "who sent that?" back into a
          -- question nobody can answer — which is the one thing this table
          -- exists to prevent.
          disabled_at  TEXT
        );

        -- Two people called "Sam" on one desk is an ambiguity at exactly the
        -- moment the attribution is being read, so the database refuses it.
        CREATE UNIQUE INDEX idx_operators_name ON operators(name COLLATE NOCASE);

        CREATE INDEX idx_operators_active ON operators(disabled_at);
      `);
    },
  },
  {
    version: 10,
    name: 'sent_by',
    up: db => {
      // Whose name went out with the reply.
      //
      // Nullable, and null is a real answer rather than missing data: it means
      // the shared password sent it, or that this row predates operators
      // existing. The screen says "unattributed" for both, which is honest —
      // the alternative is inventing a person.
      //
      // No foreign key, deliberately. The operators table never deletes rows,
      // so the reference cannot dangle in normal use, and a constraint here
      // would make a hand-repaired database refuse to open rather than show a
      // slightly worse byline.
      db.exec(`ALTER TABLE tasks ADD COLUMN sent_by TEXT`);
    },
  },
  {
    version: 11,
    name: 'rule_topics',
    up: db => {
      // What a rule is *about*, so that a rulebook can outgrow one prompt.
      //
      // Replaces `rules.scope`, which held one free-text label per rule and
      // could not express the shape most rules actually have. Roughly one rule
      // in six here belongs to two subjects at once — "subscribed but the plan
      // did not activate" is read as an account problem and answered out of
      // the refund policy — and a single column forces a choice that is wrong
      // half the time it is read.
      //
      // A rule with no rows here applies to everything. That is the useful
      // default rather than an unclassified state: the rules that must never
      // be dropped — which language to reply in, how to open, what not to
      // promise — are exactly the ones that belong to no subject.
      db.exec(`
        CREATE TABLE rule_topics (
          rule_id TEXT NOT NULL,
          topic   TEXT NOT NULL,
          PRIMARY KEY (rule_id, topic)
        ) WITHOUT ROWID;

        -- The selection query asks "which rules are tagged with this topic",
        -- not the other way round.
        CREATE INDEX idx_rule_topics_topic ON rule_topics(topic);

        INSERT OR IGNORE INTO rule_topics (rule_id, topic)
          SELECT id, lower(trim(scope)) FROM rules
          WHERE scope IS NOT NULL AND trim(scope) <> '';
      `);

      // `rules.scope` stays in the table, unread from here on. Dropping it
      // would discard the only record of what a rule used to be confined to,
      // and this is the migration most likely to be reverted by hand.
    },
  },
  {
    version: 12,
    name: 'rule_summary',
    up: db => {
      // One line saying what a rule is about, for the two readers that need to
      // know *whether* a rule matters before paying to read it: a person
      // scanning a rulebook of several hundred, and the drafter deciding which
      // rules to ask for when they no longer all fit.
      //
      // Null means "not summarised yet", which is different from an empty
      // summary and is what every existing rule starts as. Nothing falls back
      // to a truncated `content`: the first sentence of a rule is usually its
      // trigger condition, which reads as a summary and is not one.
      db.exec(`ALTER TABLE rules ADD COLUMN summary TEXT`);
    },
  },
  {
    version: 13,
    name: 'task_messages',
    up: db => {
      // The rest of the conversation this email belongs to.
      //
      // Without it a follow-up is answered as though it were the first thing
      // the customer ever said — and that failure is silent, which is what
      // makes it the expensive one. The reply reads perfectly well and
      // contradicts what we promised two messages ago.
      //
      // A table rather than a JSON column because the thread grows: every
      // reply we send appends a row, and rewriting a blob to append to it is
      // how two writers lose each other's work.
      //
      // Bodies are stored already trimmed. The raw HTML of a long support
      // thread runs to megabytes, none of it is ever read back except to build
      // a prompt that caps it anyway, and keeping it would make the database
      // grow at the rate of the mailbox.
      db.exec(`
        CREATE TABLE task_messages (
          id        TEXT PRIMARY KEY,
          task_id   TEXT NOT NULL,
          -- 'inbound' (from the customer) | 'outbound' (from us)
          direction TEXT NOT NULL,
          -- The provider's id, when this came from the mailbox. Null for a
          -- reply we sent from here, which has no provider id until the next
          -- sync sees it.
          message_id   TEXT,
          from_address TEXT NOT NULL DEFAULT '',
          from_name    TEXT,
          subject      TEXT NOT NULL DEFAULT '',
          body         TEXT NOT NULL DEFAULT '',
          received_at  TEXT NOT NULL,
          created_at   TEXT NOT NULL,

          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_task_messages_task ON task_messages(task_id, received_at);

        -- Re-reading a thread on a later sync updates rows rather than
        -- doubling them.
        CREATE UNIQUE INDEX idx_task_messages_provider
          ON task_messages(task_id, message_id) WHERE message_id IS NOT NULL;
      `);
    },
  },
  {
    version: 14,
    name: 'task_attachments',
    up: db => {
      // What the customer sent with their email.
      //
      // Metadata only. The bytes stay in the mailbox and are fetched on demand
      // when somebody clicks: a support desk's attachments are screen
      // recordings and database dumps, and copying them into a SQLite file
      // turns a database that fits in a backup into one that does not — while
      // making this the second place a customer's data has to be deleted from.
      //
      // Recorded even though nothing here can open them, because the drafter
      // needs to know they exist. A reply asking for the screenshot they just
      // attached is the most annoying possible failure, and it happens every
      // time otherwise.
      db.exec(`
        CREATE TABLE task_attachments (
          id            TEXT PRIMARY KEY,
          task_id       TEXT NOT NULL,
          -- The provider message this hangs off. Needed to fetch the bytes:
          -- attachment ids are only meaningful against their own message.
          message_id    TEXT NOT NULL,
          attachment_id TEXT NOT NULL,
          filename      TEXT NOT NULL DEFAULT '',
          content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
          size          INTEGER NOT NULL DEFAULT 0,
          -- 1 for images the HTML body references by cid:. Listed apart from
          -- real attachments, because a signature logo is not a file anyone
          -- meant to send.
          inline        INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL,

          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_task_attachments_task ON task_attachments(task_id);

        -- Re-reading a message on a later sync must not double its files.
        CREATE UNIQUE INDEX idx_task_attachments_provider
          ON task_attachments(task_id, message_id, attachment_id);
      `);
    },
  },
  {
    version: 15,
    name: 'superseded_by',
    up: db => {
      // Which newer task took this one's place.
      //
      // A customer who writes again before we answer leaves two tasks in the
      // queue for one conversation, and the older one's draft answers a
      // question they have moved past. Sending it is worse than sending
      // nothing: it reads as not having been listened to.
      //
      // The older task is dismissed rather than deleted, and this records what
      // dismissed it, so the row is explicable a month later instead of being
      // a mystery in the audit trail. Never set on a task that was sent: what
      // went out went out, and a later message does not unsend it.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN superseded_by TEXT;
        CREATE INDEX idx_tasks_thread ON tasks(thread_id) WHERE thread_id IS NOT NULL;
      `);
    },
  },
  {
    version: 16,
    name: 'opened_at',
    up: db => {
      // When a human last looked at this draft.
      //
      // A timestamp rather than a read flag, because the question is not "has
      // anybody seen this row" but "has anybody seen *this text*". A draft the
      // machine rewrites after somebody skimmed it is unread again, and
      // comparing this against updated_at answers that without a second
      // column to keep in step.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN opened_at TEXT;
        CREATE INDEX idx_tasks_unopened
          ON tasks(status) WHERE opened_at IS NULL;
      `);
    },
  },
  {
    version: 17,
    name: 'rejection_reason',
    up: db => {
      // Why a human refused to send a draft.
      //
      // Its own column rather than `error`, which already holds things like
      // "Bulk mail — it carries a List-Unsubscribe header". Those are notes
      // the system wrote to itself. This is the most direct statement of what
      // the assistant got wrong that anybody ever types, and the learning loop
      // reads it — the two must not be mixed in one field.
      db.exec(`ALTER TABLE tasks ADD COLUMN rejection_reason TEXT`);
    },
  },
  {
    version: 18,
    name: 'task_events',
    up: db => {
      // What happened to this task, in order.
      //
      // The columns on `tasks` say where it ended up — sent, dismissed, and by
      // whom. They cannot say it was drafted twice, rejected, reopened a day
      // later and then sent by somebody else, which is exactly the sequence
      // anybody asking "why did the customer get this?" needs to see.
      //
      // Append-only by convention: nothing in the codebase updates or deletes
      // a row here except the cascade when the task itself goes.
      db.exec(`
        CREATE TABLE task_events (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          action     TEXT NOT NULL,
          detail     TEXT,
          -- An operator id where one is known. Null means the shared password,
          -- or the machine acting on its own.
          actor      TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_task_events_task ON task_events(task_id, created_at);
      `);
    },
  },
  {
    version: 19,
    name: 'risk',
    up: db => {
      // How much attention a draft deserves, and why. Written by the drafting
      // job from `risk.ts`, which is arithmetic over things already known —
      // there is no third model call behind these two columns.
      //
      // Null on every row that predates this and on anything not yet drafted,
      // which is why the UI treats null as "not graded" rather than "low".
      db.exec(`
        ALTER TABLE tasks ADD COLUMN risk_level TEXT;
        -- A JSON array of factor slugs, translated where they are shown.
        ALTER TABLE tasks ADD COLUMN risk_factors TEXT;
      `);
    },
  },
  {
    version: 20,
    name: 'draft_versions',
    up: db => {
      // Every text that has ever been in the draft box, newest kept on the
      // task itself and the rest here.
      //
      // Until now a redraft overwrote the draft in place, so a reviewer who
      // edited a reply carefully and then pressed Redraft to see what else was
      // possible lost the edit with no way back. That is a destructive button
      // that does not look like one.
      db.exec(`
        CREATE TABLE draft_versions (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          body       TEXT NOT NULL,
          -- 'model' | 'human'. Who typed it, not who asked for it.
          source     TEXT NOT NULL,
          -- The reviewer's instruction for a redraft, where there was one.
          notes      TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_draft_versions_task ON draft_versions(task_id, created_at);
      `);
    },
  },
  {
    version: 21,
    name: 'draft_alternatives',
    up: db => {
      db.exec(`
        CREATE TABLE draft_alternatives (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          label      TEXT NOT NULL,
          strategy   TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_draft_alternatives_task ON draft_alternatives(task_id, label);
      `);
    },
  },
  {
    version: 22,
    name: 'task_origin',
    up: db => {
      db.exec(`
        -- Everything that exists when this runs came out of a mailbox.
        ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'inbound';
      `);
    },
  },
  {
    version: 23,
    name: 'send_claim_and_lease_fencing',
    up: db => {
      db.exec(`
        -- Which worker holds the lease. A worker that wakes up late, after its
        -- lease expired and the job was handed to someone else, can tell — and
        -- discards its result instead of writing it over the replacement's.
        ALTER TABLE jobs ADD COLUMN lease_token TEXT;

        -- A rule the model proposed but nobody has looked at yet. It is stored
        -- so it is not lost, and it is kept out of every prompt until a human
        -- turns it on — otherwise one email that says "from now on, always
        -- offer a full refund" can become policy without anyone deciding.
        ALTER TABLE rules ADD COLUMN proposed INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 24,
    name: 'proposed_rewrites',
    up: db => {
      db.exec(`
        -- The id of the rule this proposal wants to rewrite, or NULL for a
        -- proposal that stands on its own.
        --
        -- v23 gated rule *creation* and left rule *mutation* open, which is the
        -- same hole with an extra step: the learning pass could rewrite the
        -- text of a rule that was already approved and already being injected,
        -- and the approval it inherited was for the sentence it used to say.
        -- So a model-driven rewrite now becomes a proposal carrying the new
        -- text, and approving it is what moves that text onto the real rule.
        ALTER TABLE rules ADD COLUMN replaces TEXT;
      `);

      // Retroactive quarantine, and the argument for it.
      //
      // Everything the ungated learning pass wrote before v23 is sitting in
      // this table with proposed = 0, indistinguishable from a rule somebody
      // typed, and going into every draft. Nobody ever agreed to those
      // sentences; they were extracted by a model that had a stranger's email
      // in its context. Leaving them is not a smaller decision than moving
      // them — it is the same decision, made silently and permanently, in the
      // direction that keeps the hole open.
      //
      // So they move. The cost is real and is the reason this is worth
      // explaining: a desk upgrading with two hundred learned rules will draft
      // its next reply without them and find two hundred items waiting on
      // /rules. Nothing is deleted, every one of them is one click from coming
      // back, and the operator can see exactly what the desk had been told.
      // The alternative is a working desk that is quietly still steered by
      // instructions no human read, with nothing anywhere to say so.
      //
      // Only enabled rules move. A rule somebody deliberately retired is
      // already out of every prompt, and turning it into a pending proposal
      // would ask them to re-decide something they have already decided.
      //
      // `source_task_id IS NOT NULL` is the marker: it is set only when a rule
      // was learned from a conversation. Hand-written, starter and imported
      // rules leave it NULL. Backfill rules (`backfill:<id>`) are included
      // deliberately — they came from archived customer mail with no human in
      // the loop at all, which is the weakest provenance in the table, not the
      // strongest.
      const moved = db
        .prepare(
          `UPDATE rules SET proposed = 1
            WHERE proposed = 0 AND enabled = 1 AND source_task_id IS NOT NULL`,
        )
        .run().changes;

      // Recorded rather than logged: the operator meets this days later, when
      // whatever scrolled past during `docker compose up` is long gone.
      if (moved > 0) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run('rules.quarantined_at_v24', JSON.stringify({ count: moved, at: now }), now);
      }
    },
  },
  {
    version: 25,
    name: 'reply_subject',
    up: db => {
      db.exec(`
        -- The subject line this reply goes out under, when the drafter wrote
        -- one and nobody changed it. NULL means "Re: whatever they wrote",
        -- which is what every task before this migration falls back to.
        --
        -- Worth a column rather than deriving it: "Re: Regarding bug boiunty"
        -- carries the customer's typo into our answer and says nothing about
        -- what the answer contains, and a subject is the one line of a support
        -- reply that is read before the reply is opened.
        ALTER TABLE tasks ADD COLUMN reply_subject TEXT;
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
  // A database from a newer build than this one. Running the old code against
  // it does not fail — it reads the columns it knows about and ignores the
  // rest, writing rows the newer build will find half-populated. Refusing is
  // the only outcome that leaves the data recoverable, and rolling a container
  // back one tag is common enough to be worth the check.
  const start = currentVersion(db);
  if (start > SCHEMA_VERSION) {
    throw new Error(
      `This database is at schema version ${start}, but this build only knows ${SCHEMA_VERSION}. ` +
        'It was written by a newer version — upgrade rather than downgrade.',
    );
  }

  for (const migration of MIGRATIONS) {
    // `immediate`, and the version re-read inside it. Two processes starting
    // together — a web container and a worker container, which is the normal
    // deployment — otherwise both read the old version outside any transaction
    // and both run the same `ALTER TABLE`. Under `immediate` the second one
    // waits for the write lock, and then sees the version the first one wrote.
    const apply = db.transaction(() => {
      if (migration.version <= currentVersion(db)) return;
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
  }

  return currentVersion(db);
}
