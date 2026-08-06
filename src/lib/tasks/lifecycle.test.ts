import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { listJobs } from '../queue';

import { deleteUnlessSent, reopenTask } from './lifecycle';
import { createTask, getTask, markOpened, updateTask } from './store';
import type { TaskStatus } from './types';

let db: Db;

function task(status: TaskStatus, draft?: string): string {
  const { task } = createTask({ subject: 'Refund?', fromAddress: 'sam@example.com' }, db);
  updateTask(task.id, { status, ...(draft ? { draft } : {}) }, db);
  return task.id;
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('reopenTask', () => {
  it('sends a dismissed task with a draft straight back to review', async () => {
    const id = task('dismissed', 'Sorry about that — here is your refund.');

    expect(await reopenTask(id, db)).toBe(true);

    expect(getTask(id, db)?.status).toBe('awaiting_review');
    // No model call: the text already exists, and rewriting it would cost
    // three calls to land somewhere very close to where we started.
    expect(listJobs({}, db)).toHaveLength(0);
  });

  it('queues a draft for a task that has none', async () => {
    const id = task('dismissed');

    expect(await reopenTask(id, db)).toBe(true);

    expect(getTask(id, db)?.status).toBe('pending');
    expect(listJobs({}, db)).toHaveLength(1);
  });

  it('reopens a failed task and clears the error', async () => {
    const id = task('failed');
    updateTask(id, { error: 'the model timed out' }, db);

    await reopenTask(id, db);

    expect(getTask(id, db)?.error).toBeNull();
  });

  it('clears the superseded pointer', async () => {
    // A later message in the thread retired this one. Reopening it means that
    // judgement is being overruled, so the banner has to go with it.
    const id = task('dismissed', 'A draft');
    const newer = task('awaiting_review');
    updateTask(id, { supersededBy: newer }, db);

    await reopenTask(id, db);

    expect(getTask(id, db)?.supersededBy).toBeNull();
  });

  it('marks it unread again', async () => {
    const id = task('dismissed', 'A draft');
    markOpened(id, db);

    await reopenTask(id, db);

    expect(getTask(id, db)?.openedAt).toBeNull();
  });

  it('refuses to reopen a task whose reply already went out', async () => {
    const id = task('sent', 'What the customer received');

    expect(await reopenTask(id, db)).toBe(false);
    expect(getTask(id, db)?.status).toBe('sent');
  });

  it('reports nothing done for a task that does not exist', async () => {
    expect(await reopenTask('nope', db)).toBe(false);
  });
});

describe('deleteUnlessSent', () => {
  it('deletes a dismissed task', () => {
    const id = task('dismissed');

    expect(deleteUnlessSent(id, db)).toBe(true);
    expect(getTask(id, db)).toBeNull();
  });

  it('keeps a sent one', () => {
    const id = task('sent', 'What the customer received');

    expect(deleteUnlessSent(id, db)).toBe(false);
    expect(getTask(id, db)).not.toBeNull();
  });

  it('reports nothing deleted for a task that does not exist', () => {
    expect(deleteUnlessSent('nope', db)).toBe(false);
  });
});
