import type { Db } from '../db';
import { getDb } from '../db';
import { mailProvider, sendsHtmlReplies } from '../mail/config';
import { replyHtml } from '../mail/render';
import type { MailProvider } from '../mail/types';
import { enqueueLearnFromSent } from '../queue/handlers/learn-from-sent';
import { enqueueForTranslation } from '../queue/handlers/translate-task';
import { markHandled } from './mark-read';
import { addMessage } from './messages';
import { getTask, updateTask } from './store';
import type { Task } from './types';

/**
 * Sending the reply, and — separately — learning from it.
 *
 * The order matters and is not negotiable: the mail goes out first, the task
 * is marked sent second, the learning job is enqueued third. If enqueueing
 * fails we have still sent the right mail and recorded it; if it were the
 * other way round a queue hiccup would lose a customer reply.
 *
 * Clearing the mailbox's unread flag hangs off the end of that, after the row
 * is safe and before the learning, and cannot fail the send — see markHandled.
 */

export interface SendReplyInput {
  /** What the reviewer actually approved, edits included. */
  finalReply: string;
  reviewerNotes?: string;
  /**
   * Who approved it. Omitted means nobody in particular — the shared password,
   * or a caller with no session at all, like the demo seed.
   */
  sentBy?: string | null;
}

export interface SendReplyOptions {
  provider?: MailProvider;
  db?: Db;
  /** Off for tests that only care about the mail. */
  learn?: boolean;
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return 'Re:';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export async function sendReply(
  taskId: string,
  input: SendReplyInput,
  options: SendReplyOptions = {},
): Promise<Task> {
  const db = options.db ?? getDb();
  const reply = input.finalReply.trim();
  if (!reply) throw new Error('Refusing to send an empty reply');

  const task = getTask(taskId, db);
  if (!task) throw new Error(`No such task: ${taskId}`);
  // Not an error: a double-clicked Send should be a no-op, not a second email.
  if (task.status === 'sent') return task;

  const provider = options.provider ?? mailProvider();

  // Both parts, from the same string. `text` is what the reviewer read; the
  // HTML is that text with paragraph breaks in it, so the two cannot disagree.
  const html = sendsHtmlReplies() ? replyHtml(reply) : '';

  await provider.send({
    to: [{ address: task.fromAddress, ...(task.fromName ? { name: task.fromName } : {}) }],
    subject: replySubject(task.subject),
    text: reply,
    ...(html ? { html } : {}),
    ...(task.messageIdHeader
      ? { inReplyTo: task.messageIdHeader, references: [task.messageIdHeader] }
      : {}),
    // Backends that reply by their own id rather than by header need this one
    // instead; the ones that build their own MIME ignore it.
    ...(task.messageId ? { inReplyToProviderId: task.messageId } : {}),
    ...(task.threadId ? { threadId: task.threadId } : {}),
  });

  const updated = updateTask(
    taskId,
    {
      status: 'sent',
      finalReply: reply,
      reviewerNotes: input.reviewerNotes ?? task.reviewerNotes,
      sentAt: new Date().toISOString(),
      sentBy: input.sentBy ?? null,
      error: null,
    },
    db,
  );

  // What we said, kept against the conversation rather than only in
  // `final_reply`. When this thread comes back — and support threads do — the
  // next draft has to know what was already promised, and the only record of
  // that is this row.
  try {
    addMessage(
      taskId,
      {
        direction: 'outbound',
        fromAddress: '',
        subject: replySubject(task.subject),
        body: reply,
        receivedAt: new Date().toISOString(),
      },
      db,
    );
  } catch (error) {
    // Cosmetic next to a mail that has already gone out.
    console.warn('[tasks] could not record the sent reply against the thread:', error);
  }

  // Reusing the provider we just sent through rather than asking for another:
  // on IMAP that is the difference between one connection and two.
  await markHandled(task, { provider });

  if (options.learn !== false) {
    try {
      enqueueLearnFromSent(
        {
          taskId,
          topic: task.scope,
          incomingSubject: task.subject,
          incomingBody: task.body,
          ...(task.draft ? { originalDraft: task.draft } : {}),
          sentReply: reply,
          ...(input.reviewerNotes ? { reviewerNotes: input.reviewerNotes } : {}),
        },
        { db },
      );
    } catch (error) {
      // The mail is gone. Failing the request now would tell the reviewer the
      // send failed, and they would send it again.
      console.warn('[tasks] could not enqueue the learning job:', error);
    }
  }

  // What actually went out, in the reviewer's language. Only worth a call when
  // a human changed the reply — an untouched draft was already translated
  // before they approved it, and `hasTranslation` would skip this anyway.
  if (reply !== (task.draft ?? '').trim()) {
    try {
      enqueueForTranslation(taskId, { db });
    } catch (error) {
      console.warn('[tasks] could not enqueue the translation job:', error);
    }
  }

  return updated ?? task;
}
