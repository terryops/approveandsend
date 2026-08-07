import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { countUnopened, createTask, getTask, markOpened, updateTask } from './store';

let db: Db;

function waiting(subject: string): string {
  const { task } = createTask({ subject, fromAddress: 'sam@example.com' }, db);
  updateTask(task.id, { status: 'awaiting_review', draft: 'A first answer' }, db);
  return task.id;
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('markOpened', () => {
  it('records that somebody read it', () => {
    const id = waiting('Help');
    expect(getTask(id, db)?.openedAt).toBeNull();

    markOpened(id, db);

    expect(getTask(id, db)?.openedAt).not.toBeNull();
  });

  it('does not count as a change to the task', () => {
    // `updated_at` is what every "has this moved since you last looked" check
    // reads. If opening a task bumped it, reading the queue would make the
    // whole queue look freshly changed.
    const id = waiting('Help');
    // Backdated on purpose: created and opened in the same millisecond, a
    // `updated_at` that did move would still read as unchanged.
    const BEFORE = '2026-01-01T00:00:00.000Z';
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(BEFORE, id);
    expect(getTask(id, db)!.updatedAt).toBe(BEFORE);

    markOpened(id, db);

    expect(getTask(id, db)?.updatedAt).toBe(BEFORE);
  });

  it('is not upset by a task that has since been deleted', () => {
    // It runs after the response, so the row can be gone by the time it lands.
    expect(() => markOpened('no-such-task', db)).not.toThrow();
  });
});

describe('countUnopened', () => {
  it('counts the drafts nobody has looked at', () => {
    waiting('One');
    const seen = waiting('Two');
    markOpened(seen, db);

    expect(countUnopened(db)).toBe(1);
  });

  it('ignores tasks with nothing to read yet', () => {
    // Pending means the draft has not been written. Counting it would put a
    // number on screen that no amount of reading could clear.
    createTask({ subject: 'Just arrived', fromAddress: 'sam@example.com' }, db);

    expect(countUnopened(db)).toBe(0);
  });

  it('ignores tasks that have already gone out', () => {
    const id = waiting('Answered');
    updateTask(id, { status: 'sent', finalReply: 'Done' }, db);

    expect(countUnopened(db)).toBe(0);
  });
});
