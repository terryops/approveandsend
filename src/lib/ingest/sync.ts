import type { Db } from '../db';
import { getDb } from '../db';
import { mailProvider } from '../mail/config';
import type { MailMessage, MailProvider } from '../mail/types';
import { enqueueDraftReply } from '../queue/handlers/draft-reply';
import { createTask, updateTask } from '../tasks/store';
import { htmlToText, trimEmailBody } from '../thread-context';

/**
 * Pulling the inbox into tasks.
 *
 * The dedupe is `createTask`'s unique index on the provider message id, not a
 * "last synced at" watermark. Watermarks lose mail whenever a message arrives
 * out of order or a sync half-fails, and the failure is silent — the mail
 * simply never gets a reply. Re-reading a window of the inbox every time and
 * letting the database reject what it has already seen is cheap and cannot
 * lose anything.
 */

export interface SyncOptions {
  /** How many of the newest messages to consider. */
  limit?: number;
  /** ISO 8601; only messages at or after this are considered. */
  since?: string;
  provider?: MailProvider;
  db?: Db;
  /** Off when you want tasks created but no drafting to start. */
  draft?: boolean;
}

export interface SyncResult {
  scanned: number;
  created: number;
  /** Already had a task. The normal case on every sync after the first. */
  skipped: number;
  /** Message ids we could not turn into a task, with the reason. */
  failures: { messageId: string; error: string }[];
}

function bodyOf(detail: { text?: string | undefined; html?: string | undefined }): string {
  const text = detail.text?.trim();
  if (text) return trimEmailBody(text);
  return detail.html ? trimEmailBody(htmlToText(detail.html)) : '';
}

async function ingest(
  message: MailMessage,
  provider: MailProvider,
  db: Db,
  draft: boolean,
): Promise<'created' | 'skipped'> {
  // Created from the summary first: the detail fetch is the expensive call and
  // there is no point paying it for mail we have already seen.
  const { task, existed } = createTask(
    {
      messageId: message.id,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.messageIdHeader ? { messageIdHeader: message.messageIdHeader } : {}),
      subject: message.subject,
      fromAddress: message.from.address,
      ...(message.from.name ? { fromName: message.from.name } : {}),
      receivedAt: message.receivedAt,
      body: message.snippet ?? '',
    },
    db,
  );

  if (existed) return 'skipped';

  const detail = await provider.getMessage(message.id);
  updateTask(task.id, { body: bodyOf(detail) }, db);

  if (draft) enqueueDraftReply(task.id, { db });
  return 'created';
}

export async function syncInbox(options: SyncOptions = {}): Promise<SyncResult> {
  const db = options.db ?? getDb();
  const provider = options.provider ?? mailProvider();
  const draft = options.draft !== false;

  const messages = await provider.listInbox({
    limit: options.limit ?? 50,
    ...(options.since ? { since: options.since } : {}),
  });

  const result: SyncResult = { scanned: messages.length, created: 0, skipped: 0, failures: [] };

  // Sequential on purpose. Concurrency here buys nothing — the provider is the
  // bottleneck and IMAP connections are single-flight anyway — and it would
  // turn one bad message into a burst of retries.
  for (const message of messages) {
    try {
      if ((await ingest(message, provider, db, draft)) === 'created') result.created += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failures.push({
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
