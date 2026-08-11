import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { t } from '../i18n';
import { resetMailProvider } from '../mail/config';
import type {
  DownloadedAttachment,
  MailMessage,
  MailMessageDetail,
  MailProvider,
  OutgoingMail,
  SendResult,
} from '../mail/types';

import { listEvents } from './events';
import { listMessages } from './messages';
import { attachToTask, listPending, pendingAttachments } from './outgoing';
import { sendReply } from './send';
import { createTask, getTask, updateTask } from './store';
import type { TaskStatus } from './types';

/**
 * A provider that records what it was handed, and can be told to fail.
 *
 * Same reasoning as the fake in `ingest.test.ts`: what these tests are about
 * is the order of the writes around the send — the claim, the restore, the
 * row — and a mocking library would let that order change unnoticed.
 */
class FakeMailbox implements MailProvider {
  readonly id = 'fake';
  readonly label = 'Fake';

  sent: OutgoingMail[] = [];
  failNextSend: string | null = null;
  /**
   * What the backend says the mail went out as, when a test cares.
   *
   * `null` leaves the counter below in charge. `''` is Zoho answering a send
   * with no id at all, which is a real reply and not an error.
   */
  sendResult: string | null = null;

  async listInbox(): Promise<MailMessage[]> {
    return [];
  }

  async listSent(): Promise<MailMessage[]> {
    return [];
  }

  async getMessage(): Promise<MailMessageDetail> {
    throw new Error('not used');
  }

  async getThread(): Promise<MailMessageDetail[]> {
    return [];
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    if (this.failNextSend) {
      const reason = this.failNextSend;
      this.failNextSend = null;
      throw new Error(reason);
    }
    this.sent.push(mail);
    return { messageId: this.sendResult ?? `sent-${this.sent.length}` };
  }

  async markAsRead(): Promise<void> {}

  async downloadAttachment(): Promise<DownloadedAttachment> {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

let db: Db;
let provider: FakeMailbox;

function task(status: TaskStatus, draft = 'Your refund is on its way.'): string {
  const { task } = createTask({ subject: 'Refund?', fromAddress: 'sam@example.com' }, db);
  updateTask(task.id, { status, draft }, db);
  return task.id;
}

beforeEach(() => {
  db = openDb(':memory:');
  provider = new FakeMailbox();
});

afterEach(async () => {
  db.close();
  delete process.env.MAIL_PROVIDER;
  await resetMailProvider();
});

describe('sendReply', () => {
  it('sends the approved text and records it', async () => {
    const id = task('awaiting_review');

    const after = await sendReply(id, { finalReply: 'Your refund is on its way.' }, {
      provider,
      db,
      learn: false,
    });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.subject).toBe('Re: Refund?');
    expect(after.status).toBe('sent');
  });

  it('writes down what the mail went out as', async () => {
    const id = task('awaiting_review');

    await sendReply(id, { finalReply: 'Your refund is on its way.' }, {
      provider,
      db,
      learn: false,
    });

    // The send is the only moment this is knowable, and it used to be thrown
    // away — every reply this desk had ever sent was a row with no id on it.
    const outbound = listMessages(id, db).filter(m => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.messageId).toBe('sent-1');
  });

  it('leaves the id unset rather than empty when the backend has none to give', async () => {
    const id = task('awaiting_review');
    provider.sendResult = '';

    await sendReply(id, { finalReply: 'Done.' }, { provider, db, learn: false });

    // Zoho answers a send with no id of its own. Writing `''` would put a value
    // in the column `addMessage` dedupes on, and the second idless reply on a
    // task would find the first and overwrite it instead of being recorded.
    const outbound = listMessages(id, db).filter(m => m.direction === 'outbound');
    expect(outbound[0]?.messageId).toBeNull();
  });

  it('answers under the subject the reviewer approved', async () => {
    const id = task('awaiting_review');

    await sendReply(id, { finalReply: 'Done.', subject: 'Your refund, issued today' }, {
      provider,
      db,
      learn: false,
    });

    // No "Re:" glued on. It is not a reply to itself, and threading rides on
    // the headers rather than on the shape of this line.
    expect(provider.sent[0]?.subject).toBe('Your refund, issued today');
    expect(getTask(id, db)?.replySubject).toBe('Your refund, issued today');
  });

  it('falls back to the subject the drafter chose, then to theirs', async () => {
    const drafted = task('awaiting_review');
    updateTask(drafted, { replySubject: 'Your refund, issued today' }, db);

    await sendReply(drafted, { finalReply: 'Done.' }, { provider, db, learn: false });
    expect(provider.sent[0]?.subject).toBe('Your refund, issued today');

    // An empty box is a real answer: the reviewer cleared it and wants the
    // customer's own line back, not the one the model came up with.
    const cleared = task('awaiting_review');
    updateTask(cleared, { replySubject: 'Ignored' }, db);

    await sendReply(cleared, { finalReply: 'Done.', subject: '  ' }, { provider, db, learn: false });
    expect(provider.sent[1]?.subject).toBe('Re: Refund?');
  });

  it('starts a composed mail under its own subject', async () => {
    const { task: composed } = createTask(
      { subject: 'Scheduled maintenance on Sunday', fromAddress: 'sam@example.com', origin: 'composed' },
      db,
    );
    updateTask(composed.id, { status: 'awaiting_review', draft: 'Heads up.' }, db);

    await sendReply(composed.id, { finalReply: 'Heads up.' }, { provider, db, learn: false });

    expect(provider.sent[0]?.subject).toBe('Scheduled maintenance on Sunday');
  });

  it('sends the marks as tags in one part and as words in the other', async () => {
    const id = task('awaiting_review');

    await sendReply(id, { finalReply: '**Issued.** We need:\n\n- the URL\n- the steps' }, {
      provider,
      db,
      learn: false,
    });

    expect(provider.sent[0]?.text).toBe('Issued. We need:\n\n- the URL\n- the steps');
    expect(provider.sent[0]?.html).toContain('<strong>Issued.</strong>');
    expect(provider.sent[0]?.html).toContain('<li>the URL</li>');
  });

  it('leaves nothing claimed when the mail provider cannot be built', async () => {
    // The defect: `mailProvider()` ran after the claim, so a desk with bad
    // credentials pinned every task the operator clicked at `sending` — one
    // per click, for good, with no mail sent and no way back.
    const id = task('awaiting_review');
    process.env.MAIL_PROVIDER = 'not-a-real-provider';

    await expect(sendReply(id, { finalReply: 'Hello' }, { db, learn: false })).rejects.toThrow(
      /MAIL_PROVIDER/,
    );

    expect(getTask(id, db)?.status).toBe('awaiting_review');
  });

  it('refuses a task somebody else is already sending', async () => {
    // Reporting this as sent is the worst answer available: the caller
    // redirects to "sent" and the reviewer stops looking for a mail that was
    // never handed to anybody.
    const id = task('sending');

    await expect(sendReply(id, { finalReply: 'Hello' }, { provider, db, learn: false })).rejects.toThrow(
      t('task.errorSending'),
    );

    expect(provider.sent).toHaveLength(0);
  });

  it('is a no-op rather than a second email when the reply already went out', async () => {
    const id = task('sent');
    updateTask(id, { finalReply: 'What the customer received' }, db);

    const after = await sendReply(id, { finalReply: 'Hello again' }, { provider, db, learn: false });

    expect(provider.sent).toHaveLength(0);
    expect(after.finalReply).toBe('What the customer received');
  });

  it('gives the claim back when the provider fails', async () => {
    const id = task('awaiting_review');
    provider.failNextSend = 'smtp said no';

    await expect(sendReply(id, { finalReply: 'Hello' }, { provider, db, learn: false })).rejects.toThrow(
      'smtp said no',
    );

    expect(getTask(id, db)?.status).toBe('awaiting_review');
  });

  it('says why through the dictionary rather than in hardcoded English', async () => {
    const id = task('dismissed');

    // The three refusals that reach the `?error=` banner. They used to arrive
    // there as untranslated English on a desk running in any other language —
    // so what is asserted is that they came out of the dictionary, not what
    // the dictionary happens to say.
    await expect(sendReply(id, { finalReply: 'Hello' }, { provider, db, learn: false })).rejects.toThrow(
      t('task.errorDismissed'),
    );
    await expect(sendReply(task('awaiting_review'), { finalReply: '   ' }, { provider, db })).rejects.toThrow(
      t('task.errorEmptyReply'),
    );
    await expect(sendReply('nope', { finalReply: 'Hello' }, { provider, db })).rejects.toThrow(
      t('task.errorNoSuchTask'),
    );
  });

  /**
   * "Don't learn from this one" is a decision, and the two things that make it
   * one are that no job runs and that the history says who decided.
   *
   * The third assertion is the one that caught the first attempt at this: the
   * opt-out was wired to `options.learn`, which is the knob every test in this
   * file uses to mean "I only care about the mail" — so every one of them
   * started recording a choice nobody had made.
   */
  describe('not learning from this one', () => {
    it('runs no learning job and says so in the history', async () => {
      const id = task('awaiting_review');

      await sendReply(id, { finalReply: 'A one-off.', skipLearning: true }, { provider, db });

      expect(provider.sent).toHaveLength(1);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'learn-from-sent'`).get(),
      ).toEqual({ n: 0 });

      const sent = listEvents(id, db).find(event => event.action === 'sent');
      expect(sent?.detail).toBe(t('task.event.sentNoLearning'));
    });

    it('queues the job and says nothing extra when it is not asked for', async () => {
      const id = task('awaiting_review');

      await sendReply(id, { finalReply: 'The usual.' }, { provider, db });

      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'learn-from-sent'`).get(),
      ).toEqual({ n: 1 });
      expect(listEvents(id, db).find(event => event.action === 'sent')?.detail).toBeNull();
    });

    it('is not the same thing as a caller that simply does not want the job', async () => {
      const id = task('awaiting_review');

      await sendReply(id, { finalReply: 'The usual.' }, { provider, db, learn: false });

      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'learn-from-sent'`).get(),
      ).toEqual({ n: 0 });
      // No job, and no claim that a person chose that.
      expect(listEvents(id, db).find(event => event.action === 'sent')?.detail).toBeNull();
    });
  });

  /*
   * The files the reviewer put on the reply while writing it.
   *
   * They live in `outgoing_attachments` only because a browser cannot refill a
   * file input across a round trip — see migration 29 — so the send is where
   * that reason expires. Cleared inside the transaction that marks the task
   * sent rather than by the action that called this, so no future caller can
   * leave a customer's invoice in the database by forgetting to.
   */
  describe('what rode along', () => {
    it('hands the files to the provider and keeps only their names', async () => {
      const id = task('awaiting_review');
      attachToTask(id, [{ filename: 'invoice.pdf', content: Buffer.alloc(64, 1) }], db);

      await sendReply(
        id,
        { finalReply: 'Attached.', attachments: pendingAttachments(id, db) },
        { provider, db, learn: false },
      );

      expect(provider.sent[0]?.attachments?.map(a => a.filename)).toEqual(['invoice.pdf']);
      expect(listPending(id, db)).toEqual([]);
      expect(listEvents(id, db).find(event => event.action === 'sent')?.detail).toBe(
        'attached invoice.pdf',
      );
    });

    it('leaves them where the reviewer can retry when the send fails', async () => {
      const id = task('awaiting_review');
      attachToTask(id, [{ filename: 'invoice.pdf', content: Buffer.alloc(64, 1) }], db);
      provider.failNextSend = 'smtp: connection refused';

      await expect(
        sendReply(
          id,
          { finalReply: 'Attached.', attachments: pendingAttachments(id, db) },
          { provider, db, learn: false },
        ),
      ).rejects.toThrow(/connection refused/);

      // A failed send that also ate the attachment would make the retry a
      // different mail from the one the reviewer approved.
      expect(listPending(id, db).map(f => f.filename)).toEqual(['invoice.pdf']);
    });
  });
});
