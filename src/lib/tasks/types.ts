/**
 * A task is one customer email that needs a reply, plus everything the system
 * has worked out about it and everything the human did to it.
 *
 * It is deliberately a flat row rather than a state machine object: the review
 * UI reads it, the drafting job writes half of it, and the learning job reads
 * the other half. Anything cleverer would be shared mutable state with three
 * writers.
 */

export const TASK_STATUSES = [
  'pending',
  'drafting',
  'awaiting_review',
  'sent',
  'dismissed',
  'failed',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

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
}

export interface Task {
  id: string;
  status: TaskStatus;
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

  createdAt: string;
  updatedAt: string;
}

/** What ingestion knows before anything has looked at the mail. */
export interface NewTask {
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
