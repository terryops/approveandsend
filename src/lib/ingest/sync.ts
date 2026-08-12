import type { Db } from '../db';
import { getDb } from '../db';
import { mailboxAddress, mailProvider } from '../mail/config';
import type { MailMessage, MailMessageDetail, MailProvider } from '../mail/types';
import { enqueueForDrafting } from '../queue/handlers/enrich-context';
import { addAttachment } from '../tasks/attachments';
import { markHandled } from '../tasks/mark-read';
import { addMessage } from '../tasks/messages';
import { createTask, supersedeThread, updateTask } from '../tasks/store';
import { trimEmailBody } from '../thread-context';
import { answeredMessageIds } from './answered';
import { junkVerdict } from './junk';

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
  /**
   * Off to draft a reply to mail that has already been answered.
   *
   * On by default. Leaving it off on an established mailbox means the first
   * sync queues a draft for every message a human already dealt with.
   */
  skipAnswered?: boolean;
  /**
   * Off to draft a reply to newsletters and bounces as well.
   *
   * On by default. See `junk.ts` — nothing is deleted either way, so the cost
   * of leaving it on is a dismissed row and the cost of turning it off is
   * three model calls per newsletter.
   */
  skipJunk?: boolean;
}

export interface SyncResult {
  scanned: number;
  created: number;
  /** Already had a task. The normal case on every sync after the first. */
  skipped: number;
  /**
   * Somebody had already replied, so no task was made. Reported rather than
   * folded into `skipped`: on a first sync this number is most of the mailbox,
   * and "we ignored 300 emails" needs to be visible instead of inferred.
   */
  answered: number;
  /**
   * Newsletters, bounces and the like. Dismissed on arrival rather than
   * drafted; the row still exists, so a desk can check what it decided.
   */
  junk: number;
  /** Message ids we could not turn into a task, with the reason. */
  failures: { messageId: string; error: string }[];
}

/**
 * How much of a letter's own markup is worth keeping.
 *
 * Mail HTML is not written by hand and is not sized like prose: a two-sentence
 * reply from a phone arrives as forty kilobytes of nested tables, and a thread
 * quoted ten deep multiplies that. The largest real one this desk has seen was
 * 193 KB inside a 1.4 MB thread — see `thread-context.ts`, which exists because
 * of it. Half a megabyte clears every letter anybody actually writes and stops
 * a mail bomb from becoming a row that has to be walked on every page render.
 *
 * Past the cap nothing is stored and the reviewer reads the text, which is what
 * every letter looked like before this column existed.
 */
const MAX_HTML_BYTES = 512_000;

function htmlOf(detail: { html?: string | undefined }): string | null {
  const html = detail.html?.trim();
  if (!html || html.length > MAX_HTML_BYTES) return null;
  return html;
}

/**
 * The letter as text, for the drafter, the search index and the fallback.
 *
 * `trimEmailBody` already runs `htmlToText`, and this used to hand it text that
 * had been through `htmlToText` once already. Twice is not idempotent: the
 * second pass decodes the entities the first one produced, so a customer who
 * wrote `&amp;lt;` — the way you quote a literal `&lt;` — had it read as a tag
 * and deleted, and any `<` that survived the first pass took the rest of its
 * line with it. Once, now.
 */
function bodyOf(detail: { text?: string | undefined; html?: string | undefined }): string {
  const text = detail.text?.trim();
  if (text) return trimEmailBody(text);
  return detail.html ? trimEmailBody(detail.html) : '';
}

function detailBody(detail: MailMessageDetail): string {
  const text = detail.text?.trim();
  if (text) return trimEmailBody(text);
  return detail.html ? trimEmailBody(detail.html) : (detail.snippet ?? '');
}

/**
 * Record what came attached to a message.
 *
 * Best-effort like the thread capture, and for the same reason: a customer
 * whose reply is held up because we could not write down the name of their
 * screenshot is worse off than one whose reviewer does not see it listed.
 */
function captureAttachments(
  taskId: string,
  detail: MailMessageDetail,
  db: Db,
): void {
  for (const attachment of detail.attachments ?? []) {
    try {
      addAttachment(
        taskId,
        {
          messageId: detail.id,
          attachmentId: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          inline: attachment.inline,
          contentId: attachment.contentId,
        },
        db,
      );
    } catch (error) {
      console.warn(`[ingest] could not record attachment ${attachment.id}:`, error);
    }
  }
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
        bodyHtml: htmlOf(item),
        receivedAt: item.receivedAt,
      },
      db,
    );

    captureAttachments(taskId, item, db);
  }
}

async function ingest(
  message: MailMessage,
  provider: MailProvider,
  db: Db,
  draft: boolean,
  thread: boolean,
  self: string | undefined,
  skipJunk: boolean,
): Promise<'created' | 'skipped' | 'junk'> {
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

  // Before the detail fetch and before any job: everything below this line
  // costs either a provider call or a model call.
  //
  // The mailbox flag goes with it, the same way every other dismissal clears
  // it — see `markHandled`. This was the one path that did not: the filter
  // threw a newsletter out, the desk never showed it again, and it stayed bold
  // in Zoho forever. Which is the failure that flag has: an inbox with three
  // hundred unread pitches in it is an inbox where the one real unread
  // customer cannot be seen, so somebody clears it by hand, and clearing it by
  // hand means reading three hundred subject lines the filter already read.
  //
  // Handed our own provider rather than letting `markHandled` open one: this
  // runs inside a sync that already holds a connection, and on IMAP a second
  // one is a second login per newsletter.
  const dismiss = async (junk: { reason: string }): Promise<'junk'> => {
    updateTask(task.id, { status: 'dismissed', error: junk.reason }, db);
    await markHandled({ ...task, status: 'dismissed' }, { provider });
    return 'junk';
  };

  const early = skipJunk ? junkVerdict(message) : null;
  if (early) return dismiss(early);

  const detail = await provider.getMessage(message.id);

  // Again, now that the detail is in hand. Backends differ on where headers
  // live — Zoho serves them from a separate per-message endpoint, so a listing
  // there carries none and the first check only ever saw the address. Running
  // it twice costs nothing the second time and is the difference between the
  // bulk filter working everywhere and working on two providers out of three.
  const late = skipJunk ? junkVerdict(detail) : null;
  if (late) return dismiss(late);

  // Anything still waiting to be answered on this conversation was answering
  // the message before this one. After the junk checks, so a newsletter that
  // happens to land in a thread cannot retire a real customer's draft; before
  // the draft is queued, so the superseded task's own drafting job — which
  // skips dismissed tasks — never spends the call.
  if (message.threadId) supersedeThread(message.threadId, task.id, db);

  updateTask(task.id, { body: bodyOf(detail), bodyHtml: htmlOf(detail) }, db);
  captureAttachments(task.id, detail, db);

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

  const limit = options.limit ?? 50;
  const messages = await provider.listInbox({
    limit,
    ...(options.since ? { since: options.since } : {}),
  });

  // One list for the whole run, not one per message. Deliberately not bounded
  // by `since`: the reply that answers the oldest mail in this window was
  // itself sent after it, but a reply to a mail from just before the window
  // can be older than every message we are looking at.
  let sent: MailMessage[] = [];
  if (options.skipAnswered !== false && messages.length > 0) {
    try {
      sent = await provider.listSent({ limit: Math.max(limit, 100) });
    } catch (error) {
      // A mailbox that will not list sent mail costs us the filter, not the
      // sync. The reviewer sees some already-handled mail, which is a nuisance;
      // failing here would mean no mail at all, which is an outage.
      console.warn('[ingest] could not list sent mail; drafting everything:', error);
    }
  }
  const answered = answeredMessageIds(messages, sent);

  const result: SyncResult = {
    scanned: messages.length,
    created: 0,
    skipped: 0,
    answered: 0,
    junk: 0,
    failures: [],
  };

  // Sequential on purpose. Concurrency here buys nothing — the provider is the
  // bottleneck and IMAP connections are single-flight anyway — and it would
  // turn one bad message into a burst of retries.
  for (const message of messages) {
    // Checked before `createTask`, so an answered mail leaves no row at all.
    // A dismissed task would say the same thing and would also have to be
    // scrolled past, once per message, by everyone who ever opens the inbox.
    if (answered.has(message.id)) {
      result.answered += 1;
      continue;
    }

    try {
      const outcome = await ingest(
        message, provider, db, draft, thread, self, options.skipJunk !== false,
      );
      if (outcome === 'created') result.created += 1;
      else if (outcome === 'junk') result.junk += 1;
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
