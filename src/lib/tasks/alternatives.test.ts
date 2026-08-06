import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';

import {
  clearAlternatives,
  getAlternative,
  listAlternatives,
  replaceAlternatives,
} from './alternatives';
import { createTask, deleteTask } from './store';

let db: Db;

function task(): string {
  return createTask({ subject: 'Refund?', fromAddress: 'sam@example.com' }, db).task.id;
}

const THREE = [
  { strategy: 'refund now', body: 'Refunded, sorry about that.' },
  { strategy: 'ask first', body: 'Could you send the export id?' },
  { strategy: 'explain the policy', body: 'Refunds run to thirty days.' },
];

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('replaceAlternatives', () => {
  it('labels them by position', () => {
    const id = task();

    replaceAlternatives(id, THREE, db);

    expect(listAlternatives(id, db).map(a => `${a.label} ${a.strategy}`)).toEqual([
      'A refund now',
      'B ask first',
      'C explain the policy',
    ]);
  });

  it('replaces the previous set rather than adding to it', () => {
    // A second ask means the first set missed the point. Six options is a
    // harder choice, not a wider one.
    const id = task();
    replaceAlternatives(id, THREE, db);

    replaceAlternatives(id, [{ strategy: 'escalate', body: 'Passing this to engineering.' }], db);

    expect(listAlternatives(id, db)).toMatchObject([{ label: 'A', strategy: 'escalate' }]);
  });

  it('skips an option with no reply in it', () => {
    const id = task();

    replaceAlternatives(id, [{ strategy: 'empty', body: '  ' }, ...THREE], db);

    expect(listAlternatives(id, db).map(a => a.label)).toEqual(['A', 'B', 'C']);
  });

  it('keeps one task out of another', () => {
    const first = task();
    const second = task();

    replaceAlternatives(first, THREE, db);

    expect(listAlternatives(second, db)).toHaveLength(0);
  });

  it('goes with the task when it is deleted', () => {
    const id = task();
    replaceAlternatives(id, THREE, db);

    deleteTask(id, db);

    expect(listAlternatives(id, db)).toHaveLength(0);
  });
});

describe('getAlternative', () => {
  it('reads one back by id', () => {
    const id = task();
    const saved = replaceAlternatives(id, THREE, db);

    expect(getAlternative(saved[1]?.id ?? '', db)?.body).toBe('Could you send the export id?');
  });

  it('returns null for an id that is not one', () => {
    expect(getAlternative('nope', db)).toBeNull();
  });
});

describe('clearAlternatives', () => {
  it('drops the whole set', () => {
    const id = task();
    replaceAlternatives(id, THREE, db);

    clearAlternatives(id, db);

    expect(listAlternatives(id, db)).toHaveLength(0);
  });
});
