import type { Db } from '../db';
import { getDb } from '../db';
import { mailProvider } from '../mail/config';
import type { MailMessage, MailProvider } from '../mail/types';
import { createBackfillItem } from './store';

/**
 * Finding the mail to learn from.
 *
 * One provider call: the Sent mailbox, newest first, which the provider
 * already knows how to page. Everything expensive — locating the message each
 * reply answered, fetching both bodies, generating the counterfactual draft —
 * belongs to the per-item job, not here. A scan that made a thread fetch per
 * message would take minutes inside a form post and would have to start over
 * from the beginning if it timed out half way.
 */

export interface ScanOptions {
  /** How many of the most recent sent messages to consider. */
  limit?: number;
  /** ISO 8601. Only replies sent at or after this. */
  since?: string;
  provider?: MailProvider;
  db?: Db;
}

export interface ScanResult {
  scanned: number;
  /** Queued to learn from. */
  created: number;
  /** Already queued by an earlier scan over an overlapping window. */
  existed: number;
}

/** 200 is roughly a year of a small support mailbox, and a few hours of model time. */
export const DEFAULT_SCAN_LIMIT = 200;

const oldestFirst = (a: MailMessage, b: MailMessage) =>
  new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime();

function counterpartyOf(message: MailMessage): string {
  // The Sent mailbox's recipient is the customer. `to` is normally one
  // address; when it is not, the first is the one the reply was addressed to
  // and the rest were copied.
  return message.to?.[0]?.address ?? '';
}

export async function scanSentMail(options: ScanOptions = {}): Promise<ScanResult> {
  const db = options.db ?? getDb();
  const provider = options.provider ?? mailProvider();

  const messages = await provider.listSent({
    limit: options.limit ?? DEFAULT_SCAN_LIMIT,
    ...(options.since ? { since: options.since } : {}),
  });

  const result: ScanResult = { scanned: messages.length, created: 0, existed: 0 };

  // Oldest first, so the rows — and therefore the jobs, which the queue breaks
  // ties on by rowid — run in the order the mail was answered. It matters:
  // each item learns against the rulebook the items before it produced, which
  // is the same order a human working through the year would have taught them.
  for (const message of [...messages].sort(oldestFirst)) {
    const { existed } = createBackfillItem(
      {
        sentMessageId: message.id,
        subject: message.subject,
        counterparty: counterpartyOf(message),
        sentAt: message.receivedAt,
      },
      db,
    );
    if (existed) result.existed += 1;
    else result.created += 1;
  }

  return result;
}
