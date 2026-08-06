import type { Db } from '../db';
import { getDb } from '../db';
import { mailboxAddress, mailProvider } from '../mail/config';
import type { MailMessage, MailMessageDetail, MailProvider } from '../mail/types';
import { enqueueForDrafting } from '../queue/handlers/enrich-context';
import { addMessage } from '../tasks/messages';
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
  /**
   * Off to skip the per-message thread fetch.
   *
   * On by default, because a drafter with no thread answers a follow-up as a
   * first contact and nothing about that looks wrong until a customer points
   * it out. Worth one extra provider call per new task.
   */
  thread?: boolean;
  /** Our own address, for deciding which messages in a thread are ours. */
  self?: string;
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

function detailBody(detail: MailMessageDetail): string {
  const text = detail.text?.trim();
  if (text) return trimEmailBody(text);
  return detail.html ? trimEmailBody(htmlToText(detail.html)) : (detail.snippet ?? '');
}

/**
 * Record the rest of the conversation against the task.
 *
 * Best-effort on purpose. A thread fetch that fails should cost the drafter its
 * context, not cost the customer their reply — the task is already created and
 * a mail with no thread is exactly what every task looked like before this
 * existed.
 */
async function captureThread(
  taskId: string,
  message: MailMessage,
  provider: MailProvider,
  db: Db,
  self: string | undefined,
): Promise<void> {
  let thread: MailMessageDetail[];
  try {
    thread = await provider.getThread(message);
  } catch (error) {
    console.warn(`[ingest] could not read the thread for ${message.id}:`, error);
    return;
  }

  for (const item of thread) {
    // The message being replied to is already the task body; repeating it as
    // history would show the drafter the same text twice and invite a reply to
    // the wrong one.
    if (item.id === message.id) continue;

    const from = item.from?.address?.toLowerCase() ?? '';
    addMessage(
      taskId,
      {
        direction: self && from === self ? 'outbound' : 'inbound',
        messageId: item.id,
        fromAddress: from,
        ...(item.from?.name ? { fromName: item.from.name } : {}),
        subject: item.subject ?? '',
        body: detailBody(item),
        receivedAt: item.receivedAt,
      },
      db,
    );
  }
}

async function ingest(
  message: MailMessage,
  provider: MailProvider,
  db: Db,
  draft: boolean,
  thread: boolean,
  self: string | undefined,
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

  // Before drafting is queued, not after: the drafting job reads the thread,
  // and a worker that claims the job first would build its prompt without one.
  if (thread) await captureThread(task.id, message, provider, db, self);

  if (draft) await enqueueForDrafting(task.id, { db });
  return 'created';
}

export async function syncInbox(options: SyncOptions = {}): Promise<SyncResult> {
  const db = options.db ?? getDb();
  const provider = options.provider ?? mailProvider();
  const draft = options.draft !== false;
  const thread = options.thread !== false;
  const self = options.self?.toLowerCase() ?? mailboxAddress();

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
      if ((await ingest(message, provider, db, draft, thread, self)) === 'created') result.created += 1;
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
