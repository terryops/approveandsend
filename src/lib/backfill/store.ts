import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import { isBackfillStatus, type BackfillItem, type BackfillStatus, type NewBackfillItem } from './types';

interface Row {
  id: string;
  sent_message_id: string;
  incoming_message_id: string | null;
  subject: string;
  counterparty: string;
  sent_at: string | null;
  status: string;
  skip_reason: string | null;
  shadow_draft: string | null;
  rules_learned: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function map(row: Row): BackfillItem {
  return {
    id: row.id,
    sentMessageId: row.sent_message_id,
    incomingMessageId: row.incoming_message_id,
    subject: row.subject,
    counterparty: row.counterparty,
    sentAt: row.sent_at,
    status: isBackfillStatus(row.status) ? row.status : 'failed',
    skipReason: row.skip_reason,
    shadowDraft: row.shadow_draft,
    rulesLearned: row.rules_learned,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateItemResult {
  item: BackfillItem;
  /** True when this sent message had already been queued by an earlier scan. */
  existed: boolean;
}

/**
 * Records one historical reply as something to learn from.
 *
 * Idempotent on `sentMessageId`, which is what makes rescanning safe: the
 * windows people pick overlap ("last 90 days", then "last year"), and the
 * second scan must not teach the same lesson twice.
 */
export function createBackfillItem(input: NewBackfillItem, db: Db = getDb()): CreateItemResult {
  const existing = db
    .prepare('SELECT * FROM backfill_items WHERE sent_message_id = ?')
    .get(input.sentMessageId) as Row | undefined;
  if (existing) return { item: map(existing), existed: true };

  const now = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO backfill_items (id, sent_message_id, subject, counterparty, sent_at,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      randomUUID(),
      input.sentMessageId,
      input.subject ?? '',
      input.counterparty ?? '',
      input.sentAt ?? null,
      now,
      now,
    ) as Row;

  return { item: map(row), existed: false };
}

export function getBackfillItem(id: string, db: Db = getDb()): BackfillItem | null {
  const row = db.prepare('SELECT * FROM backfill_items WHERE id = ?').get(id) as Row | undefined;
  return row ? map(row) : null;
}

export interface BackfillUpdate {
  incomingMessageId?: string | null;
  subject?: string;
  counterparty?: string;
  status?: BackfillStatus;
  skipReason?: string | null;
  shadowDraft?: string | null;
  rulesLearned?: number;
  error?: string | null;
}

const COLUMNS: Record<keyof BackfillUpdate, string> = {
  incomingMessageId: 'incoming_message_id',
  subject: 'subject',
  counterparty: 'counterparty',
  status: 'status',
  skipReason: 'skip_reason',
  shadowDraft: 'shadow_draft',
  rulesLearned: 'rules_learned',
  error: 'error',
};

export function updateBackfillItem(
  id: string,
  changes: BackfillUpdate,
  db: Db = getDb(),
): BackfillItem | null {
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, column] of Object.entries(COLUMNS) as [keyof BackfillUpdate, string][]) {
    if (!(key in changes)) continue;
    sets.push(`${column} = ?`);
    params.push(changes[key] ?? null);
  }

  if (sets.length === 0) return getBackfillItem(id, db);

  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), id);

  const row = db
    .prepare(`UPDATE backfill_items SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .get(...params) as Row | undefined;

  return row ? map(row) : null;
}

export interface ListBackfillFilter {
  status?: BackfillStatus;
  limit?: number;
  offset?: number;
}

export function listBackfillItems(
  filter: ListBackfillFilter = {},
  db: Db = getDb(),
): BackfillItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM backfill_items
        ${filter.status ? 'WHERE status = ?' : ''}
        ORDER BY COALESCE(sent_at, created_at) ASC
        LIMIT ? OFFSET ?`,
    )
    .all(
      ...(filter.status ? [filter.status] : []),
      filter.limit ?? 100,
      filter.offset ?? 0,
    ) as Row[];

  return rows.map(map);
}

export function countBackfillByStatus(db: Db = getDb()): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS count FROM backfill_items GROUP BY status')
    .all() as { status: string; count: number }[];
  return Object.fromEntries(rows.map(row => [row.status, row.count]));
}

/** How many rules the whole backfill has produced so far. */
export function totalRulesLearned(db: Db = getDb()): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(rules_learned), 0) AS total FROM backfill_items')
    .get() as { total: number };
  return row.total;
}

/**
 * Stops the run: everything not yet started becomes skipped.
 *
 * Items already in `learning` are left alone. Their job holds a lease and is
 * probably mid-generation; marking the row would just disagree with what the
 * handler writes when it finishes.
 */
export function cancelPendingBackfill(db: Db = getDb()): number {
  return db
    .prepare(
      `UPDATE backfill_items
          SET status = 'skipped', skip_reason = 'Cancelled', updated_at = ?
        WHERE status = 'pending'`,
    )
    .run(new Date().toISOString()).changes;
}

/** Forgets everything about a backfill run. Rules it taught are not touched. */
export function clearBackfill(db: Db = getDb()): number {
  return db.prepare('DELETE FROM backfill_items').run().changes;
}
