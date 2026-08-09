import { randomUUID } from 'node:crypto';

import { getDb, type Db } from '../db';
import type { CatalogItem, CatalogSource, SyncedItem } from './types';
import { isCatalogSource } from './types';

interface CatalogRow {
  id: string;
  source: string;
  external_id: string | null;
  name: string;
  description: string | null;
  pricing: string | null;
  available: number;
  note: string | null;
  enabled: number;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function toItem(row: CatalogRow): CatalogItem {
  return {
    id: row.id,
    source: isCatalogSource(row.source) ? row.source : 'manual',
    externalId: row.external_id,
    name: row.name,
    description: row.description,
    pricing: row.pricing,
    available: row.available === 1,
    note: row.note,
    enabled: row.enabled === 1,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListCatalogOptions {
  /** Only the rows that are allowed into a prompt. */
  enabledOnly?: boolean;
}

/**
 * The catalogue, in the order it should be read.
 *
 * Sold things first, then the discontinued ones. A list sorted purely by name
 * interleaves the two, and the reviewer scanning for "what do we actually sell"
 * has to read the badge on every row to find out.
 */
export function listCatalog(options: ListCatalogOptions = {}, db: Db = getDb()): CatalogItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM catalog_items
        ${options.enabledOnly ? 'WHERE enabled = 1' : ''}
        ORDER BY available DESC, name COLLATE NOCASE ASC`,
    )
    .all() as CatalogRow[];

  return rows.map(toItem);
}

export function getCatalogItem(id: string, db: Db = getDb()): CatalogItem | null {
  const row = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id) as CatalogRow | undefined;
  return row ? toItem(row) : null;
}

export function countCatalog(db: Db = getDb()): { total: number; enabled: number } {
  const row = db
    .prepare('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM catalog_items')
    .get() as { total: number; enabled: number | null };
  return { total: row.total, enabled: row.enabled ?? 0 };
}

export interface NewCatalogItem {
  name: string;
  description?: string | null;
  pricing?: string | null;
  note?: string | null;
  source?: CatalogSource;
  externalId?: string | null;
  available?: boolean;
}

export function createCatalogItem(input: NewCatalogItem, db: Db = getDb()): CatalogItem {
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO catalog_items
       (id, source, external_id, name, description, pricing, available, note, enabled, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(
    id,
    input.source ?? 'manual',
    input.externalId ?? null,
    input.name.trim(),
    input.description?.trim() || null,
    input.pricing?.trim() || null,
    input.available === false ? 0 : 1,
    input.note?.trim() || null,
    now,
    now,
  );

  return getCatalogItem(id, db)!;
}

/**
 * The operator's half of a row.
 *
 * Only ever the note and the switch. There is no path here that writes a name
 * or a price, because those belong to Stripe and the next sync would overwrite
 * an edit made here — which is worse than refusing it, since the edit would
 * appear to work and then quietly revert hours later.
 */
export interface CatalogEdit {
  note?: string | null;
  enabled?: boolean;
}

export function updateCatalogItem(id: string, edit: CatalogEdit, db: Db = getDb()): CatalogItem | null {
  const existing = getCatalogItem(id, db);
  if (!existing) return null;

  db.prepare('UPDATE catalog_items SET note = ?, enabled = ?, updated_at = ? WHERE id = ?').run(
    edit.note === undefined ? existing.note : edit.note?.trim() || null,
    (edit.enabled === undefined ? existing.enabled : edit.enabled) ? 1 : 0,
    new Date().toISOString(),
    id,
  );

  return getCatalogItem(id, db);
}

/**
 * A hand-written row's own details, which no sync will overwrite.
 *
 * Separate from `updateCatalogItem` so that the "Stripe owns this" rule is
 * enforced by which function the caller can reach for rather than by an `if`
 * somebody has to remember to write.
 */
export function editManualItem(
  id: string,
  fields: { name?: string; description?: string | null; pricing?: string | null },
  db: Db = getDb(),
): CatalogItem | null {
  const existing = getCatalogItem(id, db);
  if (!existing || existing.source !== 'manual') return null;

  db.prepare(
    'UPDATE catalog_items SET name = ?, description = ?, pricing = ?, updated_at = ? WHERE id = ?',
  ).run(
    fields.name?.trim() || existing.name,
    fields.description === undefined ? existing.description : fields.description?.trim() || null,
    fields.pricing === undefined ? existing.pricing : fields.pricing?.trim() || null,
    new Date().toISOString(),
    id,
  );

  return getCatalogItem(id, db);
}

export function deleteCatalogItem(id: string, db: Db = getDb()): boolean {
  return db.prepare('DELETE FROM catalog_items WHERE id = ?').run(id).changes > 0;
}

export interface SyncCounts {
  added: number;
  updated: number;
  /** Rows Stripe no longer sells. Kept, and marked. */
  discontinued: number;
}

/**
 * Write what Stripe said, and nothing else.
 *
 * The insert carries `enabled = 1` and the update does not mention `enabled` or
 * `note` at all — that asymmetry is the feature. A new product arrives switched
 * on and unannotated; an existing one keeps whatever the desk decided about it,
 * however many times this runs.
 *
 * Products that have vanished from Stripe entirely are marked unavailable
 * rather than deleted, for the same reason an archived one is: the answer to
 * "do you still sell it" is a sentence, and a deleted row cannot say it.
 */
export function applySync(items: SyncedItem[], db: Db = getDb()): SyncCounts {
  const now = new Date().toISOString();
  const counts: SyncCounts = { added: 0, updated: 0, discontinued: 0 };

  const find = db.prepare(
    "SELECT * FROM catalog_items WHERE source = 'stripe' AND external_id = ?",
  );
  const insert = db.prepare(
    `INSERT INTO catalog_items
       (id, source, external_id, name, description, pricing, available, note, enabled, synced_at, created_at, updated_at)
     VALUES (?, 'stripe', ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE catalog_items
        SET name = ?, description = ?, pricing = ?, available = ?, synced_at = ?, updated_at = ?
      WHERE id = ?`,
  );

  const run = db.transaction(() => {
    const seen = new Set<string>();

    for (const item of items) {
      seen.add(item.externalId);
      const existing = find.get(item.externalId) as CatalogRow | undefined;

      if (existing) {
        update.run(
          item.name,
          item.description,
          item.pricing,
          item.available ? 1 : 0,
          now,
          now,
          existing.id,
        );
        counts.updated += 1;
      } else {
        insert.run(
          randomUUID(),
          item.externalId,
          item.name,
          item.description,
          item.pricing,
          item.available ? 1 : 0,
          now,
          now,
          now,
        );
        counts.added += 1;
      }
    }

    const orphans = db
      .prepare("SELECT * FROM catalog_items WHERE source = 'stripe' AND available = 1")
      .all() as CatalogRow[];

    for (const row of orphans) {
      if (row.external_id && seen.has(row.external_id)) continue;
      db.prepare('UPDATE catalog_items SET available = 0, updated_at = ? WHERE id = ?').run(now, row.id);
      counts.discontinued += 1;
    }
  });

  run();
  return counts;
}
