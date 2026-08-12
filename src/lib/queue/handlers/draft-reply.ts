import { getDb, type Db } from '../../db';
import { draftReply } from '../../drafting/draft';
import { listRules } from '../../rules/store';
import { t } from '../../i18n';
import {
  addAlternative,
  listAlternatives,
  updateAlternativeBody,
} from '../../tasks/alternatives';
import { newlines } from '../../text';
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

  // What is being rewritten, read before it is overwritten. Empty on the first
  // draft of a mail, which is the whole of the difference between "write this
  // reply" and "write it again" as far as this job is concerned — and it is
  // what decides, below, whether an option is updated or a set is generated.
  //
  // Normalised the way the review screen normalises it, because the comparison
  // is against option text: a draft that has been through a textarea holds CRLF
  // and a model's option holds LF, and untreated they never match.
  const previous = newlines(task.draft ?? '').trim();

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

    // A rewrite of the reply that was in the box, and the box is one of the
    // options — so the option is what changed.
    //
    // Redraft is not a request for a different set of approaches: the reviewer
    // sitting on B who asks for it shorter wants B shorter, and A and C left
    // alone. Regenerating all three instead threw away two approaches nobody
    // complained about, cost three more model calls, and — for the minutes that
    // took — left tab A offering the very draft that had just been rejected.
    //
    // Which option it was is matched on the text, the same way the screen lights
    // the tab: nothing records a selection, because picking one only ever put it
    // in the box. No match means the reviewer had edited by hand, and then the
    // rewrite is a genuine further approach rather than a correction to one on
    // the strip.
    if (previous) {
      const mine = listAlternatives(taskId, context.db).find(
        option => newlines(option.body).trim() === previous,
      );
      if (mine) updateAlternativeBody(mine.id, result.draft, context.db);
      else addAlternative(taskId, { strategy: t('task.optionRedrafted'), body: result.draft }, context.db);
    }

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
    //
    // Once per email, not once per draft. A redraft has just been folded back
    // into the option it came from a few lines up, and asking for a fresh set
    // on top of that is both the three wasted calls and the wrong answer: the
    // reviewer asked for one option changed, not for the other two to be
    // replaced by approaches they have not read.
    if (!previous) enqueueAlternatives(taskId, { db: context.db });

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
