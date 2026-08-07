/**
 * Undoing a decision.
 *
 * Dismissing a task and deleting a task are the two ways something leaves the
 * review queue without an answer being sent, and both of them are sometimes
 * wrong — the wrong tab was open, the junk filter was too eager, a colleague
 * cleared the queue at the end of a shift. What follows is how a task comes
 * back, and the one case where it cannot.
 *
 * The single-task buttons and the bulk bar both call these, so there is one
 * definition of what reopening means rather than two that drift.
 */

import { getDb, type Db } from '../db';
import { enqueueForDrafting } from '../queue/handlers/enrich-context';
import { enqueueLearnFromRejection } from '../queue/handlers/learn-from-rejection';

import { recordEvent } from './events';
import { deleteTask, getTask, updateTask } from './store';
import type { Task } from './types';

/**
 * Dismiss a draft, optionally saying why.
 *
 * The reason is the point. Approving a reply teaches the rulebook by
 * comparison — what the model wrote against what a human sent instead — but
 * until now the opposite decision taught it nothing at all, even though a
 * reviewer refusing to send something is the strongest evidence there is that
 * the draft was wrong. When they say why, that sentence goes to the learning
 * loop as well as onto the record.
 *
 * Returns null when there was nothing to dismiss — no such task, or one whose
 * reply is already on its way out.
 */
export function rejectTask(
  id: string,
  input: { reason?: string; notes?: string; actor?: string | null } = {},
  db: Db = getDb(),
): Task | null {
  const before = getTask(id, db);
  if (!before) return null;
  // `sending` is a claim somebody else is holding, not a status. Writing
  // `dismissed` over it does not stop the mail — the provider already has it —
  // it just leaves a task that says it was refused next to a customer holding
  // the reply, and `sendReply` overwrites the dismissal seconds later anyway.
  if (before.status === 'sending') return null;

  const reason = input.reason?.trim() ?? '';
  const actor = input.actor ?? null;
  const task = updateTask(
    id,
    {
      status: 'dismissed',
      // Only when the caller was in a position to know. The bulk bar passes no
      // notes because it has no box to type them in, and reading that as "the
      // notes are now empty" would erase what somebody wrote on the task
      // itself before ticking it.
      ...(input.notes === undefined ? {} : { reviewerNotes: input.notes.trim() || null }),
      rejectionReason: reason || null,
    },
    db,
  );

  recordEvent(id, 'dismissed', { detail: reason, ...(actor ? { actor } : {}), db });

  // Only with both a reason and a draft to attach it to. "Wrong" about nothing
  // in particular is not a lesson, and a dismissal with no draft behind it is
  // somebody clearing an email that never needed answering.
  if (reason && before.draft?.trim()) {
    try {
      enqueueLearnFromRejection(
        {
          taskId: id,
          topic: before.scope,
          incomingSubject: before.subject,
          incomingBody: before.body,
          rejectedDraft: before.draft,
          reason,
        },
        { db },
      );
    } catch (error) {
      // The dismissal itself stands. Failing here would tell the reviewer
      // their decision did not take, and they would make it again.
      console.warn('[tasks] could not enqueue the rejection learning job:', error);
    }
  }

  return task;
}

/**
 * Put a task back in front of a human. Returns false when there was nothing to
 * reopen — no such task, or one that has already been answered.
 *
 * A task that still has a draft goes straight back to `awaiting_review`: the
 * text is on disk and asking a model to write it a second time would cost
 * three calls to arrive somewhere very close to where we already are. One with
 * no draft goes to `pending` and is queued, because an empty review screen is
 * not a thing anybody can act on.
 */
export async function reopenTask(
  id: string,
  options: { actor?: string | null; db?: Db } = {},
): Promise<boolean> {
  const db = options.db ?? getDb();
  const actor = options.actor ?? null;
  const task = getTask(id, db);

  // Sent is the one status with no way back. The customer has the reply; the
  // task is now the record of that, and a record you can edit is not one.
  //
  // `sending` is refused for the nearer reason: the send is mid-flight and
  // about to write its own status, so anything written here is overwritten or
  // — worse — queues a drafting job that lands on top of what went out. The
  // sweep hands a claim nobody came back for to `awaiting_review`, and it is
  // reopenable from there.
  if (!task || task.status === 'sent' || task.status === 'sending') return false;

  const hasDraft = Boolean(task.draft?.trim());
  updateTask(
    id,
    {
      status: hasDraft ? 'awaiting_review' : 'pending',
      error: null,
      // Whatever retired it no longer applies. Leaving the pointer would put a
      // "replaced by" banner on a task that is live again.
      supersededBy: null,
      // Unread, whatever it was before. Somebody is being asked to look at this
      // again precisely because the last look at it reached the wrong answer.
      openedAt: null,
    },
    db,
  );

  recordEvent(id, 'reopened', { ...(actor ? { actor } : {}), db });

  if (!hasDraft) await enqueueForDrafting(id, { db });
  return true;
}

/**
 * Delete, unless the task is the record of a reply that went out. Returns false
 * when nothing was removed.
 *
 * Note what deletion costs: the row carries the `message_id` that stops the
 * same mail being ingested twice, so removing it means the next sync fetches
 * that email again and drafts it again. That is usually what somebody deleting
 * a mangled task wants. It is never what somebody wants for a sent one.
 */
export function deleteUnlessSent(id: string, db: Db = getDb()): boolean {
  if (getTask(id, db)?.status === 'sent') return false;
  return deleteTask(id, db);
}
