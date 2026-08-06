import { getDb, type Db } from '../../db';
import { getTask } from '../../tasks/store';
import { hasTranslation, saveTranslation, type TranslationKind } from '../../translation/store';
import { reviewLanguage, translateForReview, translationEnabled } from '../../translation/translate';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';

/**
 * Rendering an email and its reply into the reviewer's language.
 *
 * Runs after drafting rather than before, so one job covers both halves of what
 * a reviewer needs to read: the customer's message and the answer they are
 * about to approve.
 *
 * Its own job, and the lowest priority of anything task-shaped, because it is
 * the one step here that is purely for a human. Nothing downstream consumes it
 * — the draft is already written, the rules already applied — so a translation
 * backlog delays a person's reading and nothing else.
 */

export const TRANSLATE_TASK = 'translate-task';

export function enqueueTranslateTask(
  taskId: string,
  options: { priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    TRANSLATE_TASK,
    {
      payload: { taskId },
      dedupeKey: `${TRANSLATE_TASK}:${taskId}`,
      // Behind drafting (5) and enrichment (4). Today's mail getting drafted
      // matters more than yesterday's getting a second reading.
      priority: options.priority ?? 7,
      maxAttempts: 2,
    },
    options.db ?? getDb(),
  );
}

/**
 * Queue a translation only where one is wanted.
 *
 * Callers should not have to know whether this install has a review language,
 * for the same reason they do not have to know whether it has context sources:
 * a no-op job per email would clutter the queue of every install that reads
 * its own mail perfectly well.
 */
export function enqueueForTranslation(taskId: string, options: { db?: Db } = {}): void {
  if (!translationEnabled()) return;
  enqueueTranslateTask(taskId, options);
}

export const translateTaskHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const language = reviewLanguage();
  if (!language) return { skipped: 'no review language configured' };

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);

  // What is on screen: after sending, that is the reply that actually went.
  const parts: { kind: TranslationKind; text: string }[] = [
    { kind: 'body', text: task.body ?? '' },
    { kind: 'draft', text: task.finalReply ?? task.draft ?? '' },
  ];

  const translated: string[] = [];
  const sameLanguage: string[] = [];
  const failed: string[] = [];

  for (const part of parts) {
    if (!part.text.trim()) continue;
    // The body never changes and a draft usually has not; re-translating what
    // is already current is the easiest money to stop spending.
    if (hasTranslation(taskId, part.kind, part.text, language, context.db)) continue;

    try {
      const content = await translateForReview(part.text, language);
      if (content === null) {
        sameLanguage.push(part.kind);
        continue;
      }
      saveTranslation(taskId, part.kind, language, part.text, content, context.db);
      translated.push(part.kind);
    } catch (error) {
      // One half failing must not cost the other. A reviewer with the incoming
      // mail translated and the draft not is better served than one with
      // neither.
      failed.push(`${part.kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed.length > 0 && translated.length === 0) {
    throw new Error(failed.join('; '));
  }

  return {
    language,
    translated,
    ...(sameLanguage.length > 0 ? { alreadyInLanguage: sameLanguage } : {}),
    ...(failed.length > 0 ? { failed } : {}),
  };
};
