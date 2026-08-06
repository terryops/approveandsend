import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDb, type Db } from '../db';

import { createTask, deleteTask } from './store';
import { getVersion, listVersions, recordDraft } from './versions';

let db: Db;

function task(): string {
  return createTask({ subject: 'Refund?', fromAddress: 'sam@example.com' }, db).task.id;
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('recordDraft', () => {
  it('keeps the text, who typed it and what was asked for', () => {
    const id = task();

    recordDraft(id, 'A shorter reply.', { source: 'model', notes: 'make it shorter', db });

    expect(listVersions(id, db)).toMatchObject([
      { body: 'A shorter reply.', source: 'model', notes: 'make it shorter' },
    ]);
  });

  it('does not keep the same text twice in a row', () => {
    // Saving without touching the draft is the most common thing anybody does
    // on the review screen, and twenty identical entries hide the one edit
    // that mattered.
    const id = task();

    recordDraft(id, 'The same words', { source: 'human', db });
    recordDraft(id, 'The same words', { source: 'human', db });

    expect(listVersions(id, db)).toHaveLength(1);
  });

  it('keeps text that comes back after something else', () => {
    const id = task();

    recordDraft(id, 'First', { source: 'model', db });
    recordDraft(id, 'Second', { source: 'model', db });
    recordDraft(id, 'First', { source: 'human', db });

    expect(listVersions(id, db).map(v => v.body)).toEqual(['First', 'Second', 'First']);
  });

  it('keeps nothing for an empty draft', () => {
    const id = task();

    expect(recordDraft(id, '   ', { source: 'model', db })).toBeNull();
    expect(listVersions(id, db)).toHaveLength(0);
  });

  it('drops the oldest once twenty are kept', () => {
    const id = task();
    for (let i = 0; i < 25; i++) recordDraft(id, `Draft ${i}`, { source: 'model', db });

    const versions = listVersions(id, db);
    expect(versions).toHaveLength(20);
    expect(versions[0]?.body).toBe('Draft 24');
    expect(versions.at(-1)?.body).toBe('Draft 5');
  });

  it('does not throw for a task that no longer exists', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(recordDraft('nope', 'Orphan', { source: 'model', db })).toBeNull();
  });
});

describe('listVersions', () => {
  it('reads newest first', () => {
    const id = task();
    recordDraft(id, 'First', { source: 'model', db });
    recordDraft(id, 'Second', { source: 'human', db });

    expect(listVersions(id, db).map(v => v.body)).toEqual(['Second', 'First']);
  });

  it('goes with the task when it is deleted', () => {
    const id = task();
    recordDraft(id, 'First', { source: 'model', db });

    deleteTask(id, db);

    expect(listVersions(id, db)).toHaveLength(0);
  });
});

describe('getVersion', () => {
  it('reads one back by id', () => {
    const id = task();
    const saved = recordDraft(id, 'First', { source: 'model', db });

    expect(getVersion(saved?.id ?? '', db)?.body).toBe('First');
  });

  it('returns null for an id that is not one', () => {
    expect(getVersion('nope', db)).toBeNull();
  });
});
