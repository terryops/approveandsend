/**
 * A task is one customer email that needs a reply, plus everything the system
 * has worked out about it and everything the human did to it.
 *
 * It is deliberately a flat row rather than a state machine object: the review
 * UI reads it, the drafting job writes half of it, and the learning job reads
 * the other half. Anything cleverer would be shared mutable state with three
 * writers.
 */

import type { Risk } from './risk';

export const TASK_STATUSES = [
  'pending',
  'drafting',
  'awaiting_review',
  // Handed to the mail server, no answer yet. It exists because the gap
  // between "the SMTP call started" and "the row says sent" is a gap in which
  // a second click, a second tab or a browser's retry of a timed-out POST
  // sends the same reply again. A task claimed into this state cannot be
  // claimed again, so the second attempt has something to lose to.
  'sending',
  'sent',
  'dismissed',
  'failed',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * When something is not working, whose fault is it — asked in this order.
 *
 * A support desk asked "why is this person complaining?" reaches for user
 * error first, because that is the cheapest answer and it is right often
 * enough to be a habit. The habit is what makes support replies infuriating,
 * and it is how a real bug goes six weeks without being reported internally.
 *
 * So the ladder is climbed from the bottom: our bug, then a limit we know
 * about, then something confusing we built, and only then something they did.
 * `not_a_problem` is the exit for mail that reports no fault at all — most
 * sales and how-to questions — so the model is not made to blame somebody for
 * asking how exports work.
 */
export const CAUSES = [
  'system_bug',
  'known_limitation',
  'ux_issue',
  'user_error',
  'not_a_problem',
] as const;

export type Cause = (typeof CAUSES)[number];

export function isCause(value: unknown): value is Cause {
  return typeof value === 'string' && (CAUSES as readonly string[]).includes(value);
}

/**
 * Where a task came from: a mailbox, or somebody here deciding to write.
 *
 * It matters in exactly two places and both of them are things a reviewer
 * would notice immediately. A composed mail must not go out with "Re:" glued
 * to a subject nobody has ever seen, and the card at the top of the review
 * screen is the operator's own brief rather than a customer's words — calling
 * that "the customer's email" would be a lie on the one screen that has to be
 * trusted.
 */
export const TASK_ORIGINS = ['inbound', 'composed'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export function isOrigin(value: unknown): value is TaskOrigin {
  return typeof value === 'string' && (TASK_ORIGINS as readonly string[]).includes(value);
}

export const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export interface Analysis {
  /** One specific sentence. "Wants a refund because the export was silent", not "refund". */
  intent: string;
  /** ISO 639-1, as detected from the customer's text. */
  language: string;
  sentiment: Sentiment;
  keyPoints: string[];
  suggestedActions: string[];
  /** The kind of mail, which scopes the rules that apply to it. */
  scope?: string;
  /** Where the fault most likely lies, when the mail reports a fault at all. */
  cause?: Cause;
}

export interface Task {
  id: string;
  status: TaskStatus;
  origin: TaskOrigin;
  scope: string | null;
  priority: number;

  messageId: string | null;
  threadId: string | null;
  messageIdHeader: string | null;

  subject: string;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string | null;
  body: string;

  analysis: Analysis | null;
  /** What the model wrote. Kept after sending — the learning loop diffs it. */
  draft: string | null;
  /** The subject to answer under. Null falls back to "Re: " + `subject`. */
  replySubject: string | null;
  finalReply: string | null;
  reviewerNotes: string | null;
  sentAt: string | null;
  /** The operator who approved it. Null means the shared password did, which
   * is nobody in particular, or that the row predates operators. */
  sentBy: string | null;
  error: string | null;
  /** The newer task on this conversation that replaced this one. */
  supersededBy: string | null;
  /** When a human last opened it. Cleared whenever the machine rewrites the
   * draft, because what they read is no longer what is there. */
  openedAt: string | null;
  /** Why a human refused to send the draft. Their words, not the system's. */
  rejectionReason: string | null;
  /** How much attention the draft deserves. Null until one has been written. */
  risk: Risk | null;

  createdAt: string;
  updatedAt: string;
}

/** What ingestion knows before anything has looked at the mail. */
export interface NewTask {
  origin?: TaskOrigin;
  messageId?: string;
  threadId?: string;
  messageIdHeader?: string;
  subject?: string;
  fromAddress?: string;
  fromName?: string;
  receivedAt?: string;
  body?: string;
  priority?: number;
}

export function isSentiment(value: unknown): value is Sentiment {
  return typeof value === 'string' && (SENTIMENTS as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}
