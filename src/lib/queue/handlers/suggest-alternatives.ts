import { getDb, type Db } from '../../db';
import { suggestAlternatives } from '../../drafting/alternatives';
import { replaceAlternatives } from '../../tasks/alternatives';
import { getTask } from '../../tasks/store';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';

/**
 * Generating the other ways a reply could have gone.
 *
 * On the queue rather than inline in the server action for the same reason
 * drafting is: it is a model call behind a button, and a reviewer who pressed
 * it should get their page back rather than a spinner. The screen shows the
 * options when they land.
 */

export const SUGGEST_ALTERNATIVES = 'suggest-alternatives';

export interface SuggestAlternativesPayload {
  taskId: string;
}

export function enqueueAlternatives(
  taskId: string,
  options: { priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    SUGGEST_ALTERNATIVES,
    {
      payload: { taskId } satisfies SuggestAlternativesPayload,
      // One set in flight per task. A reviewer who presses the button twice
      // because nothing happened yet should not pay twice.
      dedupeKey: `${SUGGEST_ALTERNATIVES}:${taskId}`,
      // Above drafting: somebody is sitting on the page waiting for this,
      // whereas a draft for mail that arrived while they were at lunch is not
      // holding anybody up.
      priority: options.priority ?? 3,
      // Not retried to death. The reviewer has a draft either way, and a
      // second attempt they are no longer waiting for is a bill for nothing.
      maxAttempts: 2,
    },
    options.db ?? getDb(),
  );
}

export const suggestAlternativesHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);

  // The reply went out, or the task was dropped, while this sat in the queue.
  // Options for a decision already made are noise on the screen.
  if (task.status === 'sent' || task.status === 'dismissed') {
    return { skipped: task.status };
  }

  const options = await suggestAlternatives(task, task.draft ?? '', { db: context.db });
  if (options.length === 0) {
    // A model that returned nothing usable is not an error worth retrying —
    // the same prompt will do the same thing — and it must not wipe a set the
    // reviewer already has.
    return { suggested: 0 };
  }

  replaceAlternatives(taskId, options, context.db);
  return { suggested: options.length };
};
