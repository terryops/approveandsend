import { getDb, type Db } from '../../db';
import { draftReply } from '../../drafting/draft';
import { listRules } from '../../rules/store';
import { clearAlternatives } from '../../tasks/alternatives';
import { recordEvent } from '../../tasks/events';
import { listMessages } from '../../tasks/messages';
import { gradeRisk } from '../../tasks/risk';
import { recordDraft } from '../../tasks/versions';
import { getTask, updateTask } from '../../tasks/store';
import { enqueue, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';
import { enqueueAlternatives } from './suggest-alternatives';
import { enqueueForTranslation } from './translate-task';

/**
 * Turning an ingested email into a draft awaiting review.
 *
 * Unlike the learning job, this payload is only a task id. That is correct
 * here: the job's input is the customer's email, which does not change, and
 * re-reading the row means a retry picks up a scope the analysis has since
 * worked out.
 */

export const DRAFT_REPLY = 'draft-reply';

export interface DraftReplyPayload {
  taskId: string;
  /** Skip the critic pass. */
  critic?: boolean;
}

export function enqueueDraftReply(
  taskId: string,
  options: { critic?: boolean; priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    DRAFT_REPLY,
    {
      payload: { taskId, critic: options.critic ?? true } satisfies DraftReplyPayload,
      // One draft in flight per task. Two syncs noticing the same new mail
      // must not pay for two generations of the same reply.
      dedupeKey: `${DRAFT_REPLY}:${taskId}`,
      priority: options.priority ?? 5,
      maxAttempts: 3,
    },
    options.db ?? getDb(),
  );
}

export const draftReplyHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);

  // Somebody already dealt with this while it sat in the queue. Drafting over
  // a sent reply would replace what actually went out, which is the text the
  // learning loop needs.
  if (task.status === 'sent' || task.status === 'dismissed') {
    return { skipped: task.status };
  }

  updateTask(taskId, { status: 'drafting', error: null }, context.db);

  try {
    const result = await draftReply(task, { critic: value.critic !== false, db: context.db });

    // Graded here rather than in `draftReply`, because two of the inputs are
    // not the drafter's business: how long the conversation has been running,
    // and whether this desk has a rulebook at all.
    const risk = gradeRisk({
      analysis: result.analysis,
      criticApproved: result.critique?.approved,
      appliedRules: result.appliedRuleIds.length,
      haveRules: listRules({ enabledOnly: true }, context.db).length > 0,
      threadLength: task.threadId ? listMessages(task.id, context.db).length : 0,
    });

    updateTask(
      taskId,
      {
        status: 'awaiting_review',
        analysis: result.analysis,
        draft: result.draft,
        // Only when it wrote one. A redraft that comes back with nothing to
        // say about the subject must not wipe the line a reviewer has already
        // edited by hand.
        ...(result.subject ? { replySubject: result.subject } : {}),
        risk,
        // Null when no critic pass ran, and that includes the pass that errored
        // on a redraft. Carrying the previous draft's verdict over would put
        // objections on a screen next to a reply they were never made about.
        critique: result.critique ?? null,
        ...(result.analysis.scope ? { scope: result.analysis.scope } : {}),
        error: null,
        // Unread again. Whoever glanced at the previous draft — on a redraft,
        // probably the person who asked for this one — has not seen this text,
        // and a task that stayed "read" through a rewrite is one nobody is
        // told to go back to.
        openedAt: null,
      },
      context.db,
    );

    recordEvent(taskId, 'drafted', { db: context.db });
    // First, because it came first: the reply as the drafter wrote it, before
    // the second opinion replaced it. Present only when there was a rewrite.
    //
    // Until this line the rewrite was the one edit on this desk that left no
    // trace — a model changed the text a human was about to send, and the
    // version panel that exists precisely so no draft is lost silently did not
    // have it. Now it is a row like any other, which means the diff and the Put
    // this back button work on it for free.
    if (result.supersededDraft) {
      recordDraft(taskId, result.supersededDraft, {
        source: 'critic',
        notes: task.reviewerNotes,
        db: context.db,
      });
    }
    // Kept against the moment somebody presses Redraft on a reply they had
    // already rewritten by hand. The note that produced this one goes with it,
    // because "the version before I asked for it shorter" is how anybody
    // actually looks for a draft.
    recordDraft(taskId, result.draft, {
      source: 'model',
      notes: task.reviewerNotes,
      db: context.db,
    });

    // Now that both halves exist — their mail and our answer — one job can
    // render the pair for whoever has to read it.
    enqueueForTranslation(taskId, { db: context.db });

    // The set that was on the screen a moment ago belonged to the draft this
    // one just replaced, and tab A of it *was* that draft. Left in place it
    // spends the next few minutes — the whole of the new set's model call —
    // offering the reviewer who pressed Redraft the reply they had just
    // rejected, labelled as the one in the box. Cleared here rather than when
    // the job started, so a drafting attempt that fails leaves the options that
    // still match the draft the reviewer is looking at.
    clearAlternatives(taskId, context.db);

    // The other ways this could have been answered, generated now rather than
    // when somebody asks.
    //
    // This was a button, and the button was indistinguishable from a broken
    // one: pressing it bought a two-and-a-half minute wait on a page with no
    // client-side JavaScript to notice the answer arriving, so the options
    // landed on a screen the reviewer had already left. A choice that is only
    // there if you know to ask for it, and then only two minutes later, is not
    // a choice anybody makes.
    //
    // It costs roughly four model calls per mail instead of one. That is the
    // deliberate trade and the reason this line is worth finding later: delete
    // it and the desk is back to one draft per email, with the tab strip
    // simply not appearing.
    enqueueAlternatives(taskId, { db: context.db });

    return {
      appliedRules: result.appliedRuleIds.length,
      droppedRules: result.droppedRuleIds.length,
      criticApproved: result.critique?.approved,
      risk: risk.level,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lastAttempt = context.job.attempts >= context.job.maxAttempts;

    // While retries remain the task goes back to pending, so the queue owns
    // its state and the UI does not show a scary red row for thirty seconds
    // during a routine 429.
    updateTask(taskId, { status: lastAttempt ? 'failed' : 'pending', error: message }, context.db);
    // Only the attempt that gave up. A history full of "failed, retrying" for
    // a 429 that resolved itself is noise over the events that mattered.
    if (lastAttempt) recordEvent(taskId, 'failed', { detail: message, db: context.db });
    throw error;
  }
};
