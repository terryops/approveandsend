import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { createTask, updateTask } from '../tasks/store';
import type { TaskStatus } from '../tasks/types';

import { deskToday } from './today';

let db: Db;

function task(status: TaskStatus, sentAt?: string): string {
  const { task } = createTask({ subject: 'Refund?', fromAddress: 'sam@example.com' }, db);
  updateTask(task.id, { status, ...(sentAt ? { sentAt } : {}) }, db);
  return task.id;
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('deskToday', () => {
  it('counts replies that actually went out today', () => {
    task('sent', new Date().toISOString());
    task('sent', '2020-01-01T00:00:00.000Z');

    expect(deskToday(db).sent).toBe(1);
  });

  /**
   * The one this file exists for. A mail halfway through an SMTP round-trip is
   * on the machine's side of the inbox list, and it is tempting to let the
   * done-count claim it — but the header says "sent", and nothing has been.
   */
  it('does not count a send in flight as sent', () => {
    task('sending');
    task('drafting');

    expect(deskToday(db).sent).toBe(0);
  });
});
