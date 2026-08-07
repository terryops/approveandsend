import { getWorkspaceConfig } from '../../config/workspace';
import { getDb, type Db } from '../../db';
import { triage } from '../../drafting/triage';
import { markHandled } from '../../tasks/mark-read';
import { rejectTask } from '../../tasks/lifecycle';
import { getTask } from '../../tasks/store';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';
import { enqueueContextThenDraft } from './enrich-context';

/**
 * The first thing that happens to a new email, and sometimes the last.
 *
 * Its own job rather than a branch inside drafting for the same reason the
 * context lookup is: what it does on a spam pitch is stop, and a step that
 * stops the pipeline is easier to reason about — and to read in the queue —
 * than a drafting job that sometimes silently declines to draft.
 *
 * Ordered ahead of everything by priority. A drain that ran the lookup first
 * would go and ask a billing API about a backlink salesman.
 */

export const TRIAGE = 'triage';

export function enqueueTriage(
  taskId: string,
  options: { priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    TRIAGE,
    {
      payload: { taskId },
      dedupeKey: `${TRIAGE}:${taskId}`,
      // Ahead of the lookup at 4 and the drafter at 5, because both of them
      // are work this can make unnecessary.
      priority: options.priority ?? 3,
      // One cheap call. A second attempt is worth it; a third is a slower way
      // of doing what a failure here already does, which is draft anyway.
      maxAttempts: 2,
    },
    options.db ?? getDb(),
  );
}

export const triageHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);

  if (task.status === 'sent' || task.status === 'dismissed') {
    return { skipped: task.status };
  }

  const verdict = await triage(task, getWorkspaceConfig());

  if (!verdict.ignore) {
    await enqueueContextThenDraft(taskId, { db: context.db });
    return { verdict: 'reply' };
  }

  // Through `rejectTask`, so an auto-dismissal is the same row, the same
  // event and the same reopen button as one a person clicked. It also gets
  // that function's guard for free: it declines to learn a rule from a
  // dismissal with no draft behind it, which is every dismissal made here.
  const dismissed = rejectTask(taskId, { reason: verdict.reason }, context.db);
  // Nobody is going to open this in the mailbox and decide it needs reading.
  if (dismissed) await markHandled(dismissed);

  return { verdict: 'ignore', reason: verdict.reason };
};
