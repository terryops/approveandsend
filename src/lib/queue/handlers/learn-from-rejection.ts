import { createHash } from 'node:crypto';

import { getDb, type Db } from '../../db';
import { learnFromRejection, type RejectionInput, type LearningOutcome } from '../../rules/learn';
import { enqueue, type EnqueueResult } from '../store';
import { enqueueSummariseRules } from './summarise-rules';
import { PermanentJobError, type JobHandler } from '../types';

/**
 * The other half of the learning loop.
 *
 * Approving a reply teaches by comparison — what the model wrote against what
 * went out. Rejecting one teaches by statement: a human wrote a sentence
 * saying what was wrong with it. Both are worth a few model calls off the
 * request; neither is worth making somebody wait for.
 */

export const LEARN_FROM_REJECTION = 'learn-from-rejection';

export interface LearnFromRejectionPayload extends RejectionInput {}

function digest(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

export function enqueueLearnFromRejection(
  input: LearnFromRejectionPayload,
  options: { priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    LEARN_FROM_REJECTION,
    {
      payload: input,
      // Keyed on the reason, so a reviewer who rejects, reopens, and rejects
      // again with a sharper explanation is heard the second time too.
      dedupeKey: `${LEARN_FROM_REJECTION}:${input.taskId}:${digest(input.reason)}`,
      priority: options.priority ?? 7,
      maxAttempts: 3,
    },
    options.db ?? getDb(),
  );
}

function parsePayload(payload: unknown): LearnFromRejectionPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new PermanentJobError('Payload is not an object');
  }

  const value = payload as Record<string, unknown>;
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  const rejectedDraft = typeof value.rejectedDraft === 'string' ? value.rejectedDraft : '';

  if (!taskId) throw new PermanentJobError('Payload is missing taskId');
  if (!reason) throw new PermanentJobError('Payload is missing reason');

  return {
    taskId,
    topic: typeof value.topic === 'string' ? value.topic : null,
    incomingSubject: typeof value.incomingSubject === 'string' ? value.incomingSubject : '',
    incomingBody: typeof value.incomingBody === 'string' ? value.incomingBody : '',
    rejectedDraft,
    reason,
  };
}

export const learnFromRejectionHandler: JobHandler = async (
  payload,
  context,
): Promise<LearningOutcome> => {
  const input = parsePayload(payload);
  const outcome = await learnFromRejection(input, { db: context.db });

  const changed =
    outcome.amended.length > 0 || outcome.results.some(result => result.action !== 'skip');
  if (changed) enqueueSummariseRules({ db: context.db });

  return outcome;
};
