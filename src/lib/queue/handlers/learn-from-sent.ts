import { createHash } from 'node:crypto';

import { getDb, type Db } from '../../db';
import { learnFromSentReply, type LearningInput, type LearningOutcome } from '../../rules/learn';
import { enqueue, type EnqueueResult } from '../store';
import { enqueueSummariseRules } from './summarise-rules';
import { PermanentJobError, type JobHandler } from '../types';

/**
 * The trigger the learning loop was missing: approving a reply enqueues this,
 * and this turns the human's edit into rules.
 *
 * It runs off the request rather than inside it because extraction plus dedup
 * is two or three LLM calls — up to a minute against a self-hosted model — and
 * nobody should watch a spinner after clicking Send. The mail has already
 * gone; whether we learn from it is not the user's problem.
 */

export const LEARN_FROM_SENT = 'learn-from-sent';

/** The payload is a snapshot: what was on screen when the human pressed Send. */
export interface LearnFromSentPayload extends LearningInput {}

function digest(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

export function enqueueLearnFromSent(
  input: LearnFromSentPayload,
  options: { priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    LEARN_FROM_SENT,
    {
      payload: input,
      // Keyed on the text that was sent, not on the task alone: a
      // double-clicked Approve must learn once, but a reviewer who revises and
      // sends again has produced a genuinely different lesson.
      dedupeKey: `${LEARN_FROM_SENT}:${input.taskId}:${digest(input.sentReply)}`,
      // Behind anything a human is waiting on.
      priority: options.priority ?? 7,
      maxAttempts: 3,
    },
    options.db ?? getDb(),
  );
}

function parsePayload(payload: unknown): LearnFromSentPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new PermanentJobError('Payload is not an object');
  }

  const value = payload as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  const sentReply = typeof value.sentReply === 'string' ? value.sentReply.trim() : '';

  // Both are permanent: a payload missing them will still be missing them on
  // the third attempt, and each attempt costs LLM calls.
  if (!taskId) throw new PermanentJobError('Payload is missing taskId');
  if (!sentReply) throw new PermanentJobError('Payload is missing sentReply');

  return {
    taskId,
    topic: typeof value.topic === 'string' ? value.topic : null,
    incomingSubject: typeof value.incomingSubject === 'string' ? value.incomingSubject : '',
    incomingBody: typeof value.incomingBody === 'string' ? value.incomingBody : '',
    ...(typeof value.originalDraft === 'string' ? { originalDraft: value.originalDraft } : {}),
    sentReply,
    ...(typeof value.reviewerNotes === 'string' ? { reviewerNotes: value.reviewerNotes } : {}),
  };
}

export const learnFromSentHandler: JobHandler = async (payload, context): Promise<LearningOutcome> => {
  const input = parsePayload(payload);
  const outcome = await learnFromSentReply(input, { db: context.db });

  // A pass that added or rewrote anything has left rules with no summary, or
  // with one that has just been cleared for describing text that no longer
  // exists. Deduped, so a busy afternoon's learning costs one indexing pass.
  const changed =
    outcome.amended.length > 0 || outcome.results.some(result => result.action !== 'skip');
  if (changed) enqueueSummariseRules({ db: context.db });

  return outcome;
};

