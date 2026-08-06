import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { openDb, type Db } from '../db';
import { listJobs } from '../queue/store';
import { listRules } from '../rules/store';
import { importLegacyRules } from './legacy-rules';

let dir: string;
let db: Db;
let oldPath: string;

function legacyDb(): Database.Database {
  const old = new Database(oldPath);
  old.exec(`
    CREATE TABLE analysis_rules (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT DEFAULT 'general',
      enabled INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return old;
}

function insert(
  old: Database.Database,
  rule: { id: string; content: string; category?: string; enabled?: number; createdAt?: string },
): void {
  old
    .prepare(
      `INSERT INTO analysis_rules (id, content, category, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rule.id,
      rule.content,
      rule.category ?? 'general',
      rule.enabled ?? 1,
      rule.createdAt ?? '2026-02-10T02:19:16.685Z',
      '2026-08-04T23:41:29.421Z',
    );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aas-rules-'));
  oldPath = join(dir, 'tasks.db');
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('importLegacyRules', () => {
  it('carries the four categories across as themselves', () => {
    // Not a coincidence worth testing for its own sake — this project was
    // extracted from that one — but it is the assumption the import rests on.
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'Never promise a refund date.', category: 'policy' });
    insert(old, { id: 'r2', content: 'Say which model transcribed it.', category: 'product' });
    insert(old, { id: 'r3', content: 'Apologise once, not three times.', category: 'tone' });
    insert(old, { id: 'r4', content: 'Answer the question first.', category: 'general' });
    old.close();

    expect(importLegacyRules({ path: oldPath, db })).toMatchObject({
      read: 4,
      imported: 4,
      byCategory: { policy: 1, product: 1, tone: 1, general: 1 },
    });
  });

  it('keeps a rule that was turned off turned off', () => {
    // Otherwise it arrives switched on, goes into every draft, and the reason
    // somebody retired it has to be rediscovered by reading a bad reply.
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'Offer the annual plan.', enabled: 0 });
    old.close();

    expect(importLegacyRules({ path: oldPath, db })).toMatchObject({ imported: 1, disabled: 1 });
    expect(listRules({}, db)[0]!.enabled).toBe(false);
    expect(listRules({ enabledOnly: true }, db)).toEqual([]);
  });

  it('keeps the date the rule was written, not the date it was moved', () => {
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'Answer first.', createdAt: '2026-02-10T02:19:16.685Z' });
    old.close();

    importLegacyRules({ path: oldPath, db });

    expect(listRules({}, db)[0]!.createdAt).toBe('2026-02-10T02:19:16.685Z');
  });

  it('leaves the summaries to the indexing job rather than inventing them', () => {
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'Answer the question first.' });
    old.close();

    importLegacyRules({ path: oldPath, db });

    expect(listRules({}, db)[0]!.summary).toBeNull();
    expect(listRules({ unsummarisedOnly: true }, db)).toHaveLength(1);
    // Queued once for the whole backlog, not once per rule.
    expect(listJobs({}, db).map(job => job.type)).toEqual(['summarise-rules']);
  });

  it('does not queue an indexing pass when it imported nothing', () => {
    const old = legacyDb();
    old.close();

    expect(importLegacyRules({ path: oldPath, db }).imported).toBe(0);
    expect(listJobs({}, db)).toEqual([]);
  });

  it('imports the same file twice without doubling the rulebook', () => {
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'Answer the question first.' });
    old.close();

    importLegacyRules({ path: oldPath, db });
    const second = importLegacyRules({ path: oldPath, db });

    expect(second).toMatchObject({ read: 1, imported: 0, alreadyThere: 1 });
    expect(listRules({}, db)).toHaveLength(1);
  });

  it('matches on what the rule says, not on how it was typed', () => {
    // The old editor was a textarea. A trailing newline is not a new policy.
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'Answer the question first.\n\n' });
    insert(old, { id: 'r2', content: '  Answer  the question   first.  ' });
    old.close();

    expect(importLegacyRules({ path: oldPath, db })).toMatchObject({
      read: 2,
      imported: 1,
      alreadyThere: 1,
    });
  });

  it('stops at the limit, for a trial run', () => {
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'One.', createdAt: '2026-02-01T00:00:00.000Z' });
    insert(old, { id: 'r2', content: 'Two.', createdAt: '2026-02-02T00:00:00.000Z' });
    insert(old, { id: 'r3', content: 'Three.', createdAt: '2026-02-03T00:00:00.000Z' });
    old.close();

    expect(importLegacyRules({ path: oldPath, limit: 2, db }).imported).toBe(2);
    expect(listRules({}, db).map(rule => rule.content)).toEqual(['One.', 'Two.']);
  });

  it('turns a category it does not recognise into general rather than a new one', () => {
    const old = legacyDb();
    insert(old, { id: 'r1', content: 'Something.', category: 'escalation' });
    old.close();

    importLegacyRules({ path: oldPath, db });

    expect(listRules({}, db)[0]!.category).toBe('general');
  });
});
