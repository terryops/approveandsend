import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { listJobs } from '../queue';

import { listEvents } from './events';
import { deleteUnlessSent, rejectTask, reopenTask } from './lifecycle';
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

describe('rejectTask', () => {
  it('records the reason and sends it to the learning loop', () => {
    const id = task('awaiting_review', 'Your refund will arrive within 3 days.');

    rejectTask(id, { reason: 'We never promise a refund date.' }, db);

    expect(getTask(id, db)).toMatchObject({
      status: 'dismissed',
      rejectionReason: 'We never promise a refund date.',
    });
    const [job] = listJobs({}, db);
    expect(job?.type).toBe('learn-from-rejection');
    expect(job?.payload).toMatchObject({
      reason: 'We never promise a refund date.',
      rejectedDraft: 'Your refund will arrive within 3 days.',
    });
  });

  it('learns nothing from a dismissal with no reason', () => {
    const id = task('awaiting_review', 'A draft');

    rejectTask(id, {}, db);

    expect(getTask(id, db)?.status).toBe('dismissed');
    expect(listJobs({}, db)).toHaveLength(0);
  });

  it('learns nothing when there was no draft to reject', () => {
    // Clearing an email that never needed answering. There is no assistant
    // output here to have been wrong about.
    const id = task('pending');

    rejectTask(id, { reason: 'Not a support request.' }, db);

    expect(getTask(id, db)?.rejectionReason).toBe('Not a support request.');
    expect(listJobs({}, db)).toHaveLength(0);
  });

  it('leaves the reviewer notes alone when none are passed', () => {
    // What the bulk bar does. It has no notes box, and reading that as "the
    // notes are now empty" would erase what somebody typed on the task.
    const id = task('awaiting_review', 'A draft');
    updateTask(id, { reviewerNotes: 'Ask billing about this one' }, db);

    rejectTask(id, {}, db);

    expect(getTask(id, db)?.reviewerNotes).toBe('Ask billing about this one');
  });

  it('puts the reason and the person on the record', () => {
    const id = task('awaiting_review', 'A draft');

    rejectTask(id, { reason: 'We never promise a date.', actor: 'op-1' }, db);

    expect(listEvents(id, db).at(-1)).toMatchObject({
      action: 'dismissed',
      detail: 'We never promise a date.',
      actor: 'op-1',
    });
  });

  it('returns null for a task that does not exist', () => {
    expect(rejectTask('nope', { reason: 'why' }, db)).toBeNull();
  });
});

describe('reopenTask', () => {
  it('sends a dismissed task with a draft straight back to review', async () => {
    const id = task('dismissed', 'Sorry about that — here is your refund.');

    expect(await reopenTask(id, { db })).toBe(true);

    expect(getTask(id, db)?.status).toBe('awaiting_review');
    // No model call: the text already exists, and rewriting it would cost
    // three calls to land somewhere very close to where we started.
    expect(listJobs({}, db)).toHaveLength(0);
  });

  it('queues a draft for a task that has none', async () => {
    const id = task('dismissed');

    expect(await reopenTask(id, { db })).toBe(true);

    expect(getTask(id, db)?.status).toBe('pending');
    expect(listJobs({}, db)).toHaveLength(1);
  });

  it('reopens a failed task and clears the error', async () => {
    const id = task('failed');
    updateTask(id, { error: 'the model timed out' }, db);

    await reopenTask(id, { db });

    expect(getTask(id, db)?.error).toBeNull();
  });

  it('clears the superseded pointer', async () => {
    // A later message in the thread retired this one. Reopening it means that
    // judgement is being overruled, so the banner has to go with it.
    const id = task('dismissed', 'A draft');
    const newer = task('awaiting_review');
    updateTask(id, { supersededBy: newer }, db);

    await reopenTask(id, { db });

    expect(getTask(id, db)?.supersededBy).toBeNull();
  });

  it('marks it unread again', async () => {
    const id = task('dismissed', 'A draft');
    markOpened(id, db);

    await reopenTask(id, { db });

    expect(getTask(id, db)?.openedAt).toBeNull();
  });

  it('refuses to reopen a task whose reply already went out', async () => {
    const id = task('sent', 'What the customer received');

    expect(await reopenTask(id, { db })).toBe(false);
    expect(getTask(id, db)?.status).toBe('sent');
  });

  it('records who overruled the dismissal', async () => {
    const id = task('dismissed', 'A draft');

    await reopenTask(id, { actor: 'op-2', db });

    expect(listEvents(id, db).at(-1)).toMatchObject({ action: 'reopened', actor: 'op-2' });
  });

  it('reports nothing done for a task that does not exist', async () => {
    expect(await reopenTask('nope', { db })).toBe(false);
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
