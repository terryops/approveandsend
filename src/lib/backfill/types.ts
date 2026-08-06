/**
 * Learning from mail that was answered before this system existed.
 *
 * The review loop learns from a diff: what the assistant drafted against what
 * the human sent. Historical mail has no draft — only the reply a person wrote
 * unaided — so there is nothing to diff and the obvious alternative, handing
 * the reply to a model and asking what rules it implies, does not work. It
 * produces rules about one customer's order number. Every sentence in a real
 * reply looks like a policy if you squint.
 *
 * So the draft is reconstructed. Each historical email is put through the
 * current drafter, and *that* is diffed against what the human actually sent.
 * The comparison is counterfactual — "what would we get wrong today?" — which
 * means it only produces a signal where the assistant is still wrong, and goes
 * quiet on the emails it would already handle. It also gets cheaper as it goes:
 * every rule learned early makes later drafts closer, and a closer draft has
 * less to say.
 */

export const BACKFILL_STATUSES = ['pending', 'learning', 'learned', 'skipped', 'failed'] as const;

export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

export interface BackfillItem {
  id: string;
  /** Provider id of the reply we sent. Unique. */
  sentMessageId: string;
  /** Provider id of the message it answered; null until the item runs. */
  incomingMessageId: string | null;

  subject: string;
  counterparty: string;
  sentAt: string | null;

  status: BackfillStatus;
  skipReason: string | null;

  /** What the current assistant would have written instead. */
  shadowDraft: string | null;
  rulesLearned: number;
  error: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface NewBackfillItem {
  sentMessageId: string;
  subject?: string;
  counterparty?: string;
  sentAt?: string | null;
}

export function isBackfillStatus(value: unknown): value is BackfillStatus {
  return typeof value === 'string' && (BACKFILL_STATUSES as readonly string[]).includes(value);
}
