import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDb, type Db } from '../db';

import { listEvents, recordEvent } from './events';
import { createTask, deleteTask } from './store';

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

describe('recordEvent', () => {
  it('writes an event a task can be read back by', () => {
    const id = task();

    recordEvent(id, 'sent', { detail: 'to sam@example.com', actor: 'op-1', db });

    expect(listEvents(id, db).at(-1)).toMatchObject({
      taskId: id,
      action: 'sent',
      detail: 'to sam@example.com',
      actor: 'op-1',
    });
  });

  it('leaves a blank detail null rather than empty', () => {
    const id = task();

    recordEvent(id, 'dismissed', { detail: '   ', db });

    expect(listEvents(id, db).at(-1)?.detail).toBeNull();
  });

  it('truncates a detail long enough to be someone pasting a stack trace', () => {
    const id = task();

    recordEvent(id, 'failed', { detail: 'x'.repeat(1000), db });

    expect(listEvents(id, db).at(-1)?.detail).toHaveLength(300);
  });

  it('does not throw for a task that no longer exists', () => {
    // The whole point of the best-effort contract: every caller is doing
    // something that matters more than the note about it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => recordEvent('nope', 'sent', { db })).not.toThrow();
    expect(recordEvent('nope', 'sent', { db })).toBeNull();
  });
});

describe('listEvents', () => {
  it('reads oldest first', () => {
    const id = task();
    // Same millisecond is the normal case in tests and not unusual in
    // production either, so the tie has to break on insertion order.
    // `createTask` has already written the 'received' one.
    recordEvent(id, 'drafted', { db });
    recordEvent(id, 'sent', { db });

    expect(listEvents(id, db).map(e => e.action)).toEqual(['received', 'drafted', 'sent']);
  });

  it('keeps one history out of another', () => {
    const a = task();
    const b = task();
    recordEvent(a, 'drafted', { db });
    recordEvent(b, 'failed', { db });

    expect(listEvents(a, db).map(e => e.action)).toEqual(['received', 'drafted']);
  });

  it('goes with the task when it is deleted', () => {
    const id = task();
    recordEvent(id, 'drafted', { db });

    deleteTask(id, db);

    expect(listEvents(id, db)).toHaveLength(0);
  });

  it('falls back to a known action for a row written by a newer version', () => {
    const id = task();
    db.prepare(
      `INSERT INTO task_events (id, task_id, action, detail, actor, created_at)
       VALUES ('e1', ?, 'escalated', null, null, '2026-01-01T00:00:00.000Z')`,
    ).run(id);

    // A label it does not recognise must not take the review screen down.
    expect(listEvents(id, db).find(e => e.id === 'e1')?.action).toBe('edited');
  });
});
