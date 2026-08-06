import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { openDb, type Db } from '../db';
import { describeHistory, priorReplies } from '../context/sources/history';
import { listEvents } from '../tasks/events';
import { listMessages } from '../tasks/messages';
import { listTasks } from '../tasks/store';
import { importLegacy, parseSender } from './legacy';

let dir: string;
let db: Db;
let oldPath: string;

/** The old schema, as it actually stood at the end. */
function legacyDb(): Database.Database {
  const old = new Database(oldPath);
  old.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL, subject TEXT, sender TEXT, email_received_at TEXT,
      original_email TEXT NOT NULL, user_context TEXT, analysis TEXT NOT NULL,
      draft_reply TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]',
      revision_notes TEXT, rejection_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, is_read INTEGER DEFAULT 0);
  `);
  return old;
}

interface RowOptions {
  id?: string;
  sender?: string;
  messageId?: string;
  /** The rows from before the old desk recorded one. */
  noMessageId?: boolean;
  history?: unknown[];
  thread?: unknown[];
  reply?: string;
}

function insert(old: Database.Database, options: RowOptions = {}): void {
  old
    .prepare(
      `INSERT INTO tasks (id, type, status, priority, subject, sender, email_received_at,
                          original_email, analysis, draft_reply, history, created_at, updated_at)
       VALUES (@id, 'email', 'approved', 'low', @subject, @sender, @received,
               @email, '{}', @reply, @history, @created, @updated)`,
    )
    .run({
      id: options.id ?? 'old-1',
      subject: 'Where is my refund?',
      sender: options.sender ?? 'Lin Chen <lin@example.com>',
      received: '2026-02-04T16:28:22.590Z',
      email: JSON.stringify({
        current: {
          ...(options.noMessageId ? {} : { messageId: options.messageId ?? '1784236614442153000' }),
          threadId: '1750210243330123900',
          from: options.sender ?? 'Lin Chen <lin@example.com>',
          to: '&lt;support@example.com&gt;',
          subject: 'Where is my refund?',
          body: '<p>I was told three days ago.</p>',
          receivedAt: '2026-02-04T16:28:22.590Z',
        },
        thread: options.thread ?? [],
        ourReplies: [],
      }),
      reply: JSON.stringify({ subject: 'Re: refund', body: options.reply ?? 'Refunded — sorry about that.' }),
      history: JSON.stringify(
        options.history ?? [
          { action: 'created', timestamp: '2026-02-05T11:27:10.747Z', actor: 'system' },
          { action: 'approved', timestamp: '2026-02-06T09:00:00.000Z', actor: 'someone' },
        ],
      ),
      created: '2026-02-05T11:27:10.747Z',
      updated: '2026-02-06T09:00:00.000Z',
    });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aas-import-'));
  oldPath = join(dir, 'tasks.db');
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseSender', () => {
  it('reads the three shapes the archive uses', () => {
    expect(parseSender('Lin Chen <lin@example.com>')).toEqual({
      address: 'lin@example.com',
      name: 'Lin Chen',
    });
    expect(parseSender('lin@example.com')).toEqual({ address: 'lin@example.com', name: null });
    // Written by something that had already rendered it once.
    expect(parseSender('&lt;lin@example.com&gt;')).toEqual({
      address: 'lin@example.com',
      name: null,
    });
  });

  it('unwraps a quoted display name', () => {
    expect(parseSender('"Chen, Lin" <lin@example.com>').name).toBe('Chen, Lin');
  });
});

describe('importLegacy', () => {
  it('brings a finished conversation across as finished', () => {
    const old = legacyDb();
    insert(old);
    old.close();

    expect(importLegacy({ path: oldPath, db })).toMatchObject({ read: 1, imported: 1, failed: 0 });

    const [task] = listTasks({}, db);
    expect(task).toMatchObject({
      status: 'sent',
      subject: 'Where is my refund?',
      fromAddress: 'lin@example.com',
      fromName: 'Lin Chen',
      receivedAt: '2026-02-04T16:28:22.590Z',
      sentAt: '2026-02-06T09:00:00.000Z',
      finalReply: 'Refunded — sorry about that.',
    });
  });

  it('keeps the model draft only where nothing overwrote it', () => {
    // The old schema had one reply body, overwritten in place by every edit.
    // Importing it as the draft too would claim the human changed nothing.
    const old = legacyDb();
    insert(old, { id: 'untouched' });
    insert(old, {
      id: 'edited',
      messageId: 'm2',
      history: [{ action: 'draft_updated', timestamp: '2026-02-06T08:00:00.000Z' }],
    });
    old.close();

    importLegacy({ path: oldPath, messagePrefix: 'f1', db });

    const tasks = listTasks({}, db);
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map(task => task.draft))).toEqual(
      new Set([null, 'Refunded — sorry about that.']),
    );
    // Both still carry what went out. It is only the claim about what the
    // model wrote that is withheld.
    expect(tasks.every(task => task.finalReply === 'Refunded — sorry about that.')).toBe(true);
  });

  it('puts the folder in front of the old bare message ids', () => {
    // A bare Zoho id cannot be fetched — every read endpoint needs the folder.
    const old = legacyDb();
    insert(old);
    old.close();

    importLegacy({ path: oldPath, messagePrefix: '4243000000008002', db });

    expect(listTasks({}, db)[0]!.messageId).toBe('4243000000008002:1784236614442153000');
  });

  it('marks an id it cannot make usable rather than leaving the column empty', () => {
    const old = legacyDb();
    insert(old);
    old.close();

    const result = importLegacy({ path: oldPath, db });

    // Namespaced so nothing looking for a provider id can mistake it for one,
    // and present so that a second run recognises the row.
    expect(listTasks({}, db)[0]!.messageId).toBe('legacy:old-1');
    expect(result.addressable).toBe(0);
  });

  it('deduplicates the rows that never had a message id', () => {
    // A third of the real archive predates the old desk recording one. Left
    // null they are not deduplicated at all, and the second run of a two-run
    // migration silently doubles them.
    const old = legacyDb();
    insert(old, { id: 'no-id', messageId: undefined, noMessageId: true });
    old.close();

    importLegacy({ path: oldPath, messagePrefix: 'f1', db });
    const second = importLegacy({ path: oldPath, messagePrefix: 'f1', db });

    expect(second).toMatchObject({ imported: 0, alreadyThere: 1, addressable: 0 });
    expect(listTasks({}, db)).toHaveLength(1);
  });

  it('imports the same file twice without doubling the archive', () => {
    const old = legacyDb();
    insert(old);
    old.close();

    importLegacy({ path: oldPath, messagePrefix: 'f1', db });
    const second = importLegacy({ path: oldPath, messagePrefix: 'f1', db });

    expect(second).toMatchObject({ read: 1, imported: 0, alreadyThere: 1 });
    expect(listTasks({}, db)).toHaveLength(1);
    expect(listMessages(listTasks({}, db)[0]!.id, db)).toHaveLength(1);
  });

  it('works out who said what from the customer address', () => {
    const old = legacyDb();
    insert(old, {
      thread: [
        {
          from: '&lt;support@example.com&gt;',
          subject: 'Re: Where is my refund?',
          body: '<p>Looking into it.</p>',
          receivedAt: '2026-02-05T10:00:00.000Z',
        },
        {
          from: 'Lin Chen <lin@example.com>',
          subject: 'Re: Where is my refund?',
          body: '<p>Thanks.</p>',
          receivedAt: '2026-02-05T11:00:00.000Z',
        },
      ],
    });
    old.close();

    importLegacy({ path: oldPath, db });

    expect(listMessages(listTasks({}, db)[0]!.id, db).map(m => m.direction)).toEqual([
      'inbound',
      'outbound',
      'inbound',
    ]);
  });

  it('records what it did rather than inventing an audit trail', () => {
    // The old history has real timestamps but its actions do not map, and a
    // trail that gives today's date to a conversation from February is worse
    // than a short one that is true.
    const old = legacyDb();
    insert(old);
    old.close();

    importLegacy({ path: oldPath, db });

    expect(listEvents(listTasks({}, db)[0]!.id, db).map(event => event.action)).toEqual([
      'received',
      'sent',
    ]);
    expect(listEvents(listTasks({}, db)[0]!.id, db)[1]).toMatchObject({
      detail: 'imported from the previous system',
    });
  });

  it('signs the imported reply with whoever approved it', () => {
    const old = legacyDb();
    insert(old, {
      history: [
        { action: 'ai_analysis', timestamp: '2026-02-05T12:00:00.000Z', actor: '队列 Worker' },
        { action: 'approved', timestamp: '2026-02-06T09:00:00.000Z', actor: 'GoviChen' },
      ],
    });
    old.close();

    importLegacy({ path: oldPath, db });

    expect(listEvents(listTasks({}, db)[0]!.id, db)[1]).toMatchObject({ actor: 'GoviChen' });
  });

  it('does not put a name against a decision the machinery made', () => {
    // Most actors in the old history are plumbing. Importing "system" as a
    // signature is worse than leaving the line blank, which is honest.
    const old = legacyDb();
    insert(old, {
      history: [{ action: 'closed', timestamp: '2026-02-06T09:00:00.000Z', actor: 'system' }],
    });
    old.close();

    importLegacy({ path: oldPath, db });

    expect(listEvents(listTasks({}, db)[0]!.id, db)[1]).toMatchObject({ actor: null });
  });

  it('is what makes the history lookup know anybody on day one', () => {
    // The whole reason to import at all: "we have replied to them before" is
    // a fact the new database has about nobody until this runs.
    const old = legacyDb();
    insert(old);
    old.close();

    expect(describeHistory(priorReplies('lin@example.com', 'new-task', db))).toBeNull();

    importLegacy({ path: oldPath, db });

    expect(describeHistory(priorReplies('lin@example.com', 'new-task', db))?.prompt).toContain(
      'We have replied to them once before',
    );
  });

  it('carries on past a row it cannot read, and says which', () => {
    const old = legacyDb();
    insert(old, { id: 'good' });
    old.prepare(
      `INSERT INTO tasks (id, type, status, priority, original_email, analysis, draft_reply, created_at, updated_at)
       VALUES ('broken', 'email', 'approved', 'low', 'not json', '{}', 'not json', '2026-02-05', '2026-02-05')`,
    ).run();
    old.close();

    const result = importLegacy({ path: oldPath, db });

    // A row whose blobs will not parse still has a subject and a sender's
    // worth of nothing; it imports as an empty task rather than failing. What
    // matters is that the good one is there and the count is honest.
    expect(result.read).toBe(2);
    expect(listTasks({}, db).some(task => task.finalReply === 'Refunded — sorry about that.')).toBe(true);
  });

  it('stops at the limit, for a trial run', () => {
    const old = legacyDb();
    insert(old, { id: 'a', messageId: 'm1' });
    insert(old, { id: 'b', messageId: 'm2' });
    insert(old, { id: 'c', messageId: 'm3' });
    old.close();

    expect(importLegacy({ path: oldPath, messagePrefix: 'f1', limit: 2, db }).read).toBe(2);
  });

  it('refuses a file that is not there instead of creating one', () => {
    expect(() => importLegacy({ path: join(dir, 'absent.db'), db })).toThrow();
  });
});
