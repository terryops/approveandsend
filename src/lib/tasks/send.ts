import type { Db } from '../db';
import { getDb } from '../db';
import { t } from '../i18n';
import { mailProvider, sendsHtmlReplies } from '../mail/config';
import { replyHtml } from '../mail/render';
import type { MailProvider, OutgoingAttachment } from '../mail/types';
import { describeUploads } from '../mail/uploads';
import { enqueueLearnFromSent } from '../queue/handlers/learn-from-sent';
import { clearAlternatives } from './alternatives';
import { recordEvent } from './events';
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
  /**
   * Files to send with it, already read into memory.
   *
   * Not persisted anywhere: the Sent folder keeps the copy. What survives here
   * is their names, on the `sent` event — see `describeUploads`.
   */
  attachments?: OutgoingAttachment[];
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
  // Translated at the throw site rather than thrown as a key the action
  // decodes. Every one of these ends up in `?error=` and is rendered to the
  // reviewer verbatim, so somewhere has to resolve it; `sweep.ts` already
  // reaches for `t` in lib for the same reason, and the alternative — a second
  // key-to-message table in `actions.ts` — would exist for these four lines
  // alone and would drift the first time one of them changed.
  if (!reply) throw new Error(t('task.errorEmptyReply'));

  const task = getTask(taskId, db);
  if (!task) throw new Error(t('task.errorNoSuchTask'));
  // Somebody already decided this must not go out. Saying so is better than
  // sending it, and better than pretending it was sent.
  if (task.status === 'dismissed') throw new Error(t('task.errorDismissed'));

  // Everything that can fail without changing anything, before the claim.
  //
  // Both of these throw on a misconfigured mailbox, and `mailProvider` only
  // caches on success — so run after the claim, bad SMTP credentials left the
  // task pinned at `sending` with no mail sent, and did it again to the next
  // task the operator clicked, and the one after that. Nothing below this line
  // and above the send can fail, which is what makes the claim safe to hold.
  const provider = options.provider ?? mailProvider();

  // Both parts, from the same string. `text` is what the reviewer read; the
  // HTML is that text with paragraph breaks in it, so the two cannot disagree.
  const html = sendsHtmlReplies() ? replyHtml(reply) : '';

  // Claim it before the mail server hears about it.
  //
  // The old guard read the status and trusted it, which is a check against a
  // value that stays true for the length of an SMTP round-trip: two clicks
  // 200ms apart both saw `awaiting_review` and both sent. This is a
  // conditional write, so exactly one caller can win it, and the loser finds
  // the row already claimed.
  //
  // It also survives the process dying mid-send. A task stuck in `sending` is
  // a question a human can be shown — "did this go out?" — which is strictly
  // better than a task that looks unsent and invites a second attempt.
  const claimed = db
    .prepare(
      `UPDATE tasks SET status = 'sending', updated_at = ?
        WHERE id = ? AND status <> 'sent' AND status <> 'sending'`,
    )
    .run(new Date().toISOString(), taskId).changes;

  if (!claimed) {
    const current = getTask(taskId, db);
    // The claim refuses for two reasons that read nothing alike. `sent` is a
    // double-clicked Send, and returning the row is right — the customer has
    // the mail. `sending` is somebody else's claim, or a dead attempt's, and
    // returning it told the reviewer their retry had gone out when the caller
    // then redirected to `?sent=1` having sent nothing at all.
    if (current?.status === 'sending') throw new Error(t('task.errorSending'));
    return current ?? task;
  }

  try {
    await provider.send({
      to: [{ address: task.fromAddress, ...(task.fromName ? { name: task.fromName } : {}) }],
      // A composed mail starts the conversation, so there is nothing to be
      // "Re:" about — and a subject nobody has ever seen prefixed like that is
      // how a recipient decides the sender is a bot.
      subject: task.origin === 'composed' ? task.subject : replySubject(task.subject),
      text: reply,
      ...(html ? { html } : {}),
      ...(task.messageIdHeader
        ? { inReplyTo: task.messageIdHeader, references: [task.messageIdHeader] }
        : {}),
      // Backends that reply by their own id rather than by header need this one
      // instead; the ones that build their own MIME ignore it.
      ...(task.messageId ? { inReplyToProviderId: task.messageId } : {}),
      ...(task.threadId ? { threadId: task.threadId } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
  } catch (error) {
    // Give the claim back. The reviewer is about to be told this failed, and a
    // task they cannot retry is worse than the failure itself.
    updateTask(taskId, { status: task.status }, db);
    throw error;
  }

  // The filenames, because they are the only trace of them that stays with us.
  const carried = describeUploads(input.attachments ?? []);

  // Everything the sent mail implies about our own rows, in one transaction.
  // The mail is already gone, so this cannot be undone by failing — but it can
  // be made all-or-nothing, and the alternative is the state that reads worst
  // of all: a task marked sent with no outbound message and no `sent` event,
  // which is a desk that cannot tell you what it said.
  const commit = db.transaction(() => {
    const row = updateTask(
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
    // `final_reply`. When this thread comes back — and support threads do —
    // the next draft has to know what was already promised, and the only
    // record of that is this row.
    addMessage(
      taskId,
      {
        direction: 'outbound',
        fromAddress: '',
        subject: task.origin === 'composed' ? task.subject : replySubject(task.subject),
        body: reply,
        receivedAt: new Date().toISOString(),
      },
      db,
    );

    recordEvent(taskId, 'sent', {
      ...(input.sentBy ? { actor: input.sentBy } : {}),
      ...(carried ? { detail: carried } : {}),
      db,
    });

    // The roads not taken. Nobody reads them once a reply has gone out, and a
    // desk that keeps every option it ever generated is a desk whose database
    // grows with its bill rather than its work.
    clearAlternatives(taskId, db);

    return row;
  });

  let updated: Task | null = null;
  try {
    updated = commit();
  } catch (error) {
    // The customer has the mail. Throwing here would tell the reviewer the
    // send failed and they would send it again, which is the one outcome
    // worse than a row that is out of step with reality.
    console.error('[tasks] the reply went out but could not be recorded:', error);
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
