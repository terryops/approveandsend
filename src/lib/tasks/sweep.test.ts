import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { DRAFT_REPLY, enqueueDraftReply } from '../queue/handlers/draft-reply';
import { listJobs } from '../queue/store';
import { createTask, getTask, updateTask } from './store';
import { sweepStuckTasks } from './sweep';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

/** A task last touched `minutes` ago, so the grace period has passed. */
function staleTask(minutes: number, status: 'pending' | 'drafting' = 'pending') {
  const { task } = createTask({ subject: 'Help', fromAddress: 'a@example.com' }, db);
  updateTask(task.id, { status }, db);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(
    new Date(Date.now() - minutes * 60_000).toISOString(),
    task.id,
  );
  return task.id;
}

describe('sweepStuckTasks', () => {
  it('puts a task with no job left back in the queue', async () => {
    const id = staleTask(60);

    const result = await sweepStuckTasks({ db });

    expect(result).toMatchObject({ found: 1, requeued: 1, failed: 0, errors: [] });
    expect(listJobs({ status: 'pending' }, db)).toHaveLength(1);
    // Still pending, not failed: nothing went wrong, it was simply dropped.
    expect(getTask(id, db)?.status).toBe('pending');
  });

  it('leaves a task alone while its job is still claimable', async () => {
    const id = staleTask(60);
    enqueueDraftReply(id, { db });

    const result = await sweepStuckTasks({ db });

    expect(result).toMatchObject({ found: 0, requeued: 0 });
  });

  it('leaves a task alone while a worker is running its job', async () => {
    const id = staleTask(60);
    enqueueDraftReply(id, { db });
    db.prepare(`UPDATE jobs SET status = 'processing' WHERE dedupe_key = ?`).run(
      `${DRAFT_REPLY}:${id}`,
    );

    const result = await sweepStuckTasks({ db });

    expect(result).toMatchObject({ found: 0 });
  });

  it('leaves a freshly created task alone', async () => {
    // The gap between createTask and enqueue is not a fault, and a sweep that
    // treated it as one would double every task ingested while it ran.
    staleTask(1);

    expect(await sweepStuckTasks({ db })).toMatchObject({ found: 0 });
  });

  it('marks a task failed when its job gave up, and says why', async () => {
    const id = staleTask(60, 'drafting');
    enqueueDraftReply(id, { db });
    db.prepare(`UPDATE jobs SET status = 'failed', error = ? WHERE dedupe_key = ?`).run(
      'Worker lease expired and no attempts remain',
      `${DRAFT_REPLY}:${id}`,
    );

    const result = await sweepStuckTasks({ db });

    expect(result).toMatchObject({ found: 1, failed: 1, requeued: 0 });

    const task = getTask(id, db);
    expect(task?.status).toBe('failed');
    // The reason has to survive: this is the one place it is ever written down,
    // because the handler never ran to write it itself.
    expect(task?.error).toContain('lease expired');
    // And no new job, which would re-spend the attempts that just ran out.
    expect(listJobs({ status: 'pending' }, db)).toHaveLength(0);
  });

  it('ignores tasks a human or the queue already finished', async () => {
    for (const status of ['awaiting_review', 'sent', 'dismissed', 'failed'] as const) {
      const { task } = createTask({ subject: status, fromAddress: 'a@example.com' }, db);
      updateTask(task.id, { status }, db);
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(
        new Date(Date.now() - 3_600_000).toISOString(),
        task.id,
      );
    }

    expect(await sweepStuckTasks({ db })).toMatchObject({ found: 0 });
  });

  it('handles the oldest first and stops at the limit', async () => {
    const first = staleTask(120);
    staleTask(60);
    staleTask(30);

    const result = await sweepStuckTasks({ db, limit: 1 });

    expect(result).toMatchObject({ found: 1, requeued: 1 });
    // Whichever job type this install starts with, it is the oldest task's.
    expect(listJobs({ status: 'pending' }, db)[0]?.dedupeKey).toMatch(new RegExp(`:${first}$`));
  });
});
