import { hasContext, listContext } from '../../context/store';
import { getDb, type Db } from '../../db';
import { deskLanguage } from '../../i18n';
import { getTask } from '../../tasks/store';
import { cardsSource, translateCards } from '../../translation/cards';
import { hasTranslation, saveTranslation, type TranslationKind } from '../../translation/store';
import {
  repliesNeedRendering,
  reviewLanguage,
  translateForReview,
  translationEnabled,
} from '../../translation/translate';
import { enqueue, isQueued, type EnqueueResult } from '../store';
import { PermanentJobError, type JobHandler } from '../types';

/**
 * Rendering an email, its reply and the cards beside them into a language the
 * reviewer reads.
 *
 * Runs after drafting rather than before, so one job covers everything a
 * reviewer has to read on that screen: the customer's message, the answer they
 * are about to approve, and what the lookups said about the person who wrote
 * in.
 *
 * Two languages, deliberately. The mail is rendered into `reviewLanguage` —
 * what the customer wrote and what we are about to send. The cards are
 * rendered into the interface language, because they are part of the interface
 * and arrive in English from a source that had no way of knowing better; see
 * `translation/cards.ts`. A desk that reads its own mail unaided still wants
 * its own furniture in its own words.
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
 *
 * Cards are the second reason to run, and they are why this asks the database
 * rather than only the config. A desk with no `reviewLanguage` and a billing
 * lookup has nothing to translate about the mail and a card in the wrong
 * language sitting above it.
 */
export function enqueueForTranslation(taskId: string, options: { db?: Db } = {}): void {
  const db = options.db ?? getDb();
  if (!translationEnabled() && !hasContext(taskId, db)) return;
  enqueueTranslateTask(taskId, { ...options, db });
}

/**
 * Whether this task's cards are missing a rendering the desk could read.
 *
 * Two database reads and no model call, so that a screen can ask it on the way
 * past. Cards only, and not the mail beside them, because the two halves store
 * a no-op differently: a letter already in the reviewer's language stores
 * nothing at all — `translateForReview` returns null and there is nothing to
 * save — so "no row" means "nothing needed" as often as it means "not done",
 * and a caller acting on that would queue a job per view forever. A card's
 * no-op is a stored rendering identical to the card, which makes the absence of
 * a row here mean exactly one thing.
 */
export function cardsAwaitingRendering(taskId: string, db: Db = getDb()): boolean {
  const cards = listContext(taskId, db);
  if (cards.length === 0) return false;
  return !hasTranslation(taskId, 'context', cardsSource(cards), deskLanguage(), db);
}

/**
 * Whether the reply on this task is still waiting to be rendered for review.
 *
 * Two database reads, so a poll can ask it on the way past — and the reason it
 * can ask at all is that a reply's no-op is written down. `translateForReview`
 * returning "already in that language" is saved as an empty row (see
 * `isSameLanguage`), so the absence of a row for the draft means "not done
 * yet" rather than "nothing to do", which is the distinction
 * `cardsAwaitingRendering` could not make about the mail.
 *
 * `isQueued` is the part that keeps this from being a promise nobody can
 * keep. A translate job that has spent its attempts is not coming back, and a
 * screen waiting on the strength of a missing row alone would spin until the
 * tab was closed. No job in flight means the wait is over however it ended.
 */
export function replyAwaitingRendering(taskId: string, db: Db = getDb()): boolean {
  const language = reviewLanguage();
  if (!language || !repliesNeedRendering()) return false;

  const task = getTask(taskId, db);
  const text = task?.finalReply ?? task?.draft ?? '';
  if (!text.trim()) return false;
  if (hasTranslation(taskId, 'draft', text, language, db)) return false;

  return isQueued(`${TRANSLATE_TASK}:${taskId}`, db);
}

export const translateTaskHandler: JobHandler = async (payload, context) => {
  const value = (payload ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');

  const task = getTask(taskId, context.db);
  if (!task) throw new PermanentJobError(`Task ${taskId} no longer exists`);

  const language = reviewLanguage();
  const cards = listContext(taskId, context.db);
  if (!language && cards.length === 0) return { skipped: 'nothing on this task needs rendering' };

  // What is on screen: after sending, that is the reply that actually went.
  //
  // The letter is always asked about — a stranger wrote it, in a language
  // nothing here chose. The reply is asked about only where it could be in a
  // language the reviewer does not read: `repliesNeedRendering` reads that off
  // `replyLanguage`, and on a desk that answers in the reviewer's own language
  // this half was a model call per draft edit whose entire output was `SAME`.
  const parts: { kind: TranslationKind; text: string }[] = language
    ? [
        { kind: 'body', text: task.body ?? '' },
        ...(repliesNeedRendering()
          ? [{ kind: 'draft' as const, text: task.finalReply ?? task.draft ?? '' }]
          : []),
      ]
    : [];

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
        // Written down rather than skipped. "Already in the reviewer's
        // language" is an answer, and one nothing used to record — so the
        // screen could not tell it from "not translated yet", and this job
        // asked again on the next edit, and the one after that. See
        // `isSameLanguage`.
        saveTranslation(taskId, part.kind, language, part.text, '', context.db);
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

  // The cards, into the language the desk is read in rather than the one the
  // mail is read in. One call for all of them — see `translateCards` — so a
  // task with three sources costs one cheap request, not three.
  //
  // `deskLanguage` rather than `operatorLanguage`, and the difference is the
  // browser. There is no request here to read `Accept-Language` from, so the
  // language the page will later *look this up* under has to be one a job can
  // arrive at on its own; see the note on `deskLanguage`.
  const desk = deskLanguage();
  const source = cardsSource(cards);
  if (cards.length > 0 && !hasTranslation(taskId, 'context', source, desk, context.db)) {
    try {
      const rendered = await translateCards(cards, desk);
      // Stored even when the model changed nothing, which is the difference
      // between paying once per desk that already reads English and paying
      // again every time somebody saves a draft. A rendering identical to the
      // card is the right answer to show, and a row saying so is the only way
      // to stop asking.
      if (rendered) {
        saveTranslation(taskId, 'context', desk, source, JSON.stringify(rendered), context.db);
        translated.push('context');
      } else {
        failed.push('context: the rendering did not line up with the cards');
      }
    } catch (error) {
      failed.push(`context: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Anything that failed fails the job, even where something else succeeded.
  //
  // The old condition — throw only when *nothing* got through — was reasoning
  // about the wrong thing. What it protected was the work already done, and
  // that work is already safe: each part is saved as it lands and every part
  // starts with a `hasTranslation` check, so a retry re-does exactly what
  // failed and nothing else. What the condition actually bought was silence.
  // A translator that 500s on the cards after rendering the mail returned a
  // job marked done, so nothing ever tried again and the reviewer's cards sat
  // in the source's language for the life of the task, with the queue's own
  // log saying the task had been translated.
  if (failed.length > 0) {
    throw new Error(failed.join('; '));
  }

  // No `failed` here: reaching this line means there was none.
  return {
    ...(language ? { language } : {}),
    ...(cards.length > 0 ? { deskLanguage: desk } : {}),
    translated,
    ...(sameLanguage.length > 0 ? { alreadyInLanguage: sameLanguage } : {}),
  };
};
