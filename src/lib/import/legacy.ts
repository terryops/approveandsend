import Database from 'better-sqlite3';

import { getDb, type Db } from '../db';
import { recordEvent } from '../tasks/events';
import { addMessage } from '../tasks/messages';
import { createTask, updateTask } from '../tasks/store';

/**
 * Reading the archive out of the system this replaced.
 *
 * The old desk kept one row per task with four JSON blobs hanging off it, and
 * by the end it held a couple of thousand answered conversations. Those are
 * worth more than they look: "we have replied to them three times before" is
 * the single most useful thing a drafter can be told, and on the day of a
 * cutover it is a fact the new database does not have about anybody.
 *
 * So this reads the old file directly rather than asking the old app for an
 * export. The app is being turned off; a migration that needs it running is a
 * migration that has to happen in one window.
 *
 * It is read-only on the old file and idempotent on the new one, because the
 * first run of an import like this always finds something the second run has
 * to fix.
 */

export interface LegacyImportOptions {
  /** Path to the old `tasks.db`. Opened read-only. */
  path: string;
  /**
   * The provider folder id to put in front of the old bare message ids.
   *
   * The old system stored Zoho's message id on its own. This one stores
   * `folderId:messageId`, because a bare Zoho id cannot be fetched at all —
   * every read endpoint needs the folder. Without the prefix the ids are
   * imported as null, which costs the one thing they are for: the next sync
   * seeing an archived conversation, not recognising it, and re-ingesting a
   * year-old answered email as a new task to review.
   */
  messagePrefix?: string;
  /** For a trial run over the first few rows. */
  limit?: number;
  db?: Db;
}

export interface LegacyImportResult {
  read: number;
  imported: number;
  /** Already present, by message id. A second run of the same import. */
  alreadyThere: number;
  /** Unreadable rows. The archive is fifteen months of a moving schema. */
  failed: number;
  /** How many carry a provider id the mail sync will recognise. */
  addressable: number;
  /** The first few failures, by old id, so a bad run can be diagnosed. */
  problems: string[];
}

interface LegacyRow {
  id: string;
  status: string;
  subject: string | null;
  sender: string | null;
  email_received_at: string | null;
  original_email: string;
  draft_reply: string;
  history: string;
  revision_notes: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyMessage {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  receivedAt?: string;
  messageId?: string;
  threadId?: string;
}

interface LegacyEvent {
  action?: string;
  timestamp?: string;
}

const MAX_PROBLEMS = 10;

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * `Name <addr@example.com>`, `<addr@example.com>`, or a bare address.
 *
 * The old rows are also HTML-escaped in places — `&lt;addr&gt;` — because they
 * were written by something that had already rendered them once.
 */
export function parseSender(raw: string | null | undefined): { address: string; name: string | null } {
  const text = (raw ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  if (!text) return { address: '', name: null };

  const angled = /^(.*?)<([^>]+)>\s*$/.exec(text);
  if (!angled) return { address: text, name: null };

  const name = (angled[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
  return { address: (angled[2] ?? '').trim(), name: name || null };
}

/** When the old desk considered the answer sent. */
function sentAt(history: LegacyEvent[], fallback: string): string {
  const closing = history.filter(event => event.action === 'approved' || event.action === 'closed');
  return closing[closing.length - 1]?.timestamp ?? fallback;
}

/**
 * Whether the model's own words survived to be sent.
 *
 * The old schema kept one reply body, overwritten in place by every human
 * edit, so what is left is what went out and nothing says what the model first
 * wrote. Where the history shows an edit, the draft is imported as null rather
 * than as a copy of the sent text — the learning loop diffs the two, and a
 * draft equal to the reply is the claim "the human changed nothing", which for
 * these rows would be a lesson learned from a record that was overwritten.
 */
function wasEdited(history: LegacyEvent[]): boolean {
  return history.some(
    event =>
      event.action === 'draft_updated' ||
      event.action === 'requested_revision' ||
      event.action === 'needs_revision' ||
      event.action === 'draft_regenerated',
  );
}

export function importLegacy(options: LegacyImportOptions): LegacyImportResult {
  const db = options.db ?? getDb();
  const result: LegacyImportResult = {
    read: 0,
    imported: 0,
    alreadyThere: 0,
    failed: 0,
    addressable: 0,
    problems: [],
  };

  const old = new Database(options.path, { readonly: true, fileMustExist: true });

  try {
    const rows = old
      .prepare(
        `SELECT * FROM tasks ORDER BY created_at ASC${options.limit ? ` LIMIT ${Number(options.limit)}` : ''}`,
      )
      .all() as LegacyRow[];

    for (const row of rows) {
      result.read += 1;
      try {
        if (importOne(row, options, db)) result.imported += 1;
        else result.alreadyThere += 1;
        if (options.messagePrefix) result.addressable += 1;
      } catch (error) {
        result.failed += 1;
        if (result.problems.length < MAX_PROBLEMS) {
          result.problems.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } finally {
    old.close();
  }

  return result;
}

/** True when a task was created, false when this row was already imported. */
function importOne(row: LegacyRow, options: LegacyImportOptions, db: Db): boolean {
  const email = parse<{ current?: LegacyMessage; thread?: LegacyMessage[] }>(row.original_email, {});
  const current = email.current ?? {};
  const reply = parse<{ body?: string }>(row.draft_reply, {});
  const history = parse<LegacyEvent[]>(row.history, []);

  const sender = parseSender(row.sender || current.from);
  const receivedAt = row.email_received_at ?? current.receivedAt ?? row.created_at;

  const { task, existed } = createTask(
    {
      ...(options.messagePrefix && current.messageId
        ? { messageId: `${options.messagePrefix}:${current.messageId}` }
        : {}),
      ...(current.threadId ? { threadId: current.threadId } : {}),
      subject: row.subject ?? current.subject ?? '',
      fromAddress: sender.address,
      ...(sender.name ? { fromName: sender.name } : {}),
      receivedAt,
      body: current.body ?? '',
    },
    db,
  );

  if (existed) return false;

  const body = (reply.body ?? '').trim();

  updateTask(
    task.id,
    {
      // Every row in the archive is a conversation that ended. Importing them
      // as anything else would put fifteen months of answered mail into the
      // review queue on the morning of the cutover.
      status: 'sent',
      sentAt: sentAt(history, row.updated_at),
      finalReply: body || null,
      draft: body && !wasEdited(history) ? body : null,
      reviewerNotes: row.revision_notes,
      rejectionReason: row.rejection_reason,
    },
    db,
  );

  // Only for a task this run created: the thread messages carry no provider
  // id, so nothing downstream could tell a re-import's copies apart from the
  // originals.
  for (const message of threadOf(email, sender.address)) addMessage(task.id, message, db);

  // One event, stamped now, saying what it is. The old history has real
  // timestamps but the actions do not map — and an audit trail that quietly
  // gives today's date to a conversation from February is worse than a short
  // one that is true.
  recordEvent(task.id, 'sent', { detail: 'imported from the previous system', db });

  return true;
}

function threadOf(
  email: { current?: LegacyMessage; thread?: LegacyMessage[] },
  customer: string,
): Parameters<typeof addMessage>[1][] {
  const messages = [...(email.current ? [email.current] : []), ...(email.thread ?? [])];

  return messages.flatMap(message => {
    const from = parseSender(message.from);
    if (!message.body && !from.address) return [];

    return [
      {
        // Nothing in the old rows records a direction, so the customer's own
        // address decides it. Everything else on the thread is us.
        direction: from.address && from.address === customer ? ('inbound' as const) : ('outbound' as const),
        fromAddress: from.address,
        ...(from.name ? { fromName: from.name } : {}),
        subject: message.subject ?? '',
        body: message.body ?? '',
        receivedAt: message.receivedAt ?? new Date().toISOString(),
      },
    ];
  });
}
