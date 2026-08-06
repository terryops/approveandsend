import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import type {
  DownloadedAttachment,
  MailMessage,
  MailMessageDetail,
  MailProvider,
  OutgoingMail,
  SendResult,
} from '../mail/types';
import { LEARN_FROM_SENT } from '../queue/handlers';
import { listJobs } from '../queue/store';
import { createTask, getTask, updateTask } from '../tasks/store';
import { createOperator } from '../operators/store';
import { replySubject, sendReply } from '../tasks/send';
import { syncInbox } from './sync';

/**
 * A mailbox that records what it was asked to do. Not a mock library: the
 * point of these tests is the sequence of calls between the store, the queue
 * and the provider, and a mocking framework would let that sequence change
 * without a test noticing.
 */
class FakeMailbox implements MailProvider {
  readonly id = 'fake';
  readonly label = 'Fake';

  sent: OutgoingMail[] = [];
  detailFetches: string[] = [];
  failNextSend: string | null = null;

  constructor(private readonly inbox: MailMessage[] = []) {}

  async listInbox(): Promise<MailMessage[]> {
    return this.inbox;
  }

  async listSent(): Promise<MailMessage[]> {
    return [];
  }

  async getMessage(id: string): Promise<MailMessageDetail> {
    this.detailFetches.push(id);
    const message = this.inbox.find(m => m.id === id);
    if (!message) throw new Error(`no such message: ${id}`);
    return { ...message, text: `full body of ${id}`, attachments: [] };
  }

  async getThread(message: MailMessage): Promise<MailMessageDetail[]> {
    return [await this.getMessage(message.id)];
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = null;
      throw new Error(error);
    }
    this.sent.push(mail);
    return { messageId: `sent-${this.sent.length}` };
  }

  async markAsRead(): Promise<void> {}

  async downloadAttachment(): Promise<DownloadedAttachment> {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

function message(id: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    subject: `Subject ${id}`,
    from: { address: `${id}@example.com`, name: `Sender ${id}` },
    to: [{ address: 'support@acme.test' }],
    receivedAt: '2026-08-01T10:00:00.000Z',
    snippet: `snippet of ${id}`,
    isRead: false,
    hasAttachments: false,
    ...overrides,
  };
}

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('syncInbox', () => {
  it('turns new mail into tasks and queues a draft for each', async () => {
    const provider = new FakeMailbox([message('a'), message('b')]);

    const result = await syncInbox({ provider, db });

    expect(result).toMatchObject({ scanned: 2, created: 2, skipped: 0, failures: [] });
    expect(provider.detailFetches).toEqual(['a', 'b']);

    const tasks = db.prepare('SELECT * FROM tasks').all() as { body: string }[];
    expect(tasks).toHaveLength(2);
    // The summary body is replaced by the real one after the detail fetch.
    expect(tasks.map(t => t.body).sort()).toEqual(['full body of a', 'full body of b']);
    // Enrichment, not drafting: looking the sender up comes first, and that
    // job is what enqueues the draft.
    expect(listJobs({ type: 'enrich-context' }, db)).toHaveLength(2);
  });

  it('does not pay for a detail fetch on mail it has already seen', async () => {
    const provider = new FakeMailbox([message('a')]);
    await syncInbox({ provider, db });
    provider.detailFetches.length = 0;

    const second = await syncInbox({ provider, db });

    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(provider.detailFetches).toEqual([]);
    expect(listJobs({ type: 'enrich-context' }, db)).toHaveLength(1);
  });

  it('carries the threading headers through so the reply can be threaded', async () => {
    const provider = new FakeMailbox([
      message('a', { threadId: 'thread-9', messageIdHeader: 'abc@mail.example.com' }),
    ]);

    await syncInbox({ provider, db });

    const task = (db.prepare('SELECT * FROM tasks').get() as { thread_id: string; message_id_header: string });
    expect(task.thread_id).toBe('thread-9');
    expect(task.message_id_header).toBe('abc@mail.example.com');
  });

  it('keeps going when one message cannot be fetched', async () => {
    const provider = new FakeMailbox([message('a'), message('b')]);
    const original = provider.getMessage.bind(provider);
    provider.getMessage = async (id: string) => {
      if (id === 'a') throw new Error('mailbox hiccup');
      return original(id);
    };

    const result = await syncInbox({ provider, db });

    expect(result.created).toBe(1);
    expect(result.failures).toEqual([{ messageId: 'a', error: 'mailbox hiccup' }]);
  });

  it('creates tasks without drafting them when asked not to', async () => {
    const provider = new FakeMailbox([message('a')]);
    await syncInbox({ provider, db, draft: false });
    expect(listJobs({}, db)).toHaveLength(0);
  });
});

describe('sendReply', () => {
  function seed(overrides: Record<string, unknown> = {}) {
    const { task } = createTask(
      {
        messageId: 'm1',
        messageIdHeader: 'abc@mail.example.com',
        subject: 'Refund please',
        fromAddress: 'customer@example.com',
        fromName: 'A Customer',
        body: 'I want my money back',
      },
      db,
    );
    return updateTask(task.id, { status: 'awaiting_review', draft: 'A draft', ...overrides }, db)!;
  }

  it('sends the reply, threads it, and records what went out', async () => {
    const task = seed();
    const provider = new FakeMailbox();

    const updated = await sendReply(task.id, { finalReply: 'The edited reply' }, { provider, db });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({
      to: [{ address: 'customer@example.com', name: 'A Customer' }],
      subject: 'Re: Refund please',
      text: 'The edited reply',
      inReplyTo: 'abc@mail.example.com',
      references: ['abc@mail.example.com'],
    });
    expect(updated.status).toBe('sent');
    expect(updated.finalReply).toBe('The edited reply');
    expect(updated.sentAt).toBeTruthy();
  });

  it('records who approved it, and that nobody did when nobody is named', async () => {
    const sam = createOperator('Sam', 'hunter2', db);

    const attributed = await sendReply(
      seed().id,
      { finalReply: 'Sam sent this', sentBy: sam.id },
      { provider: new FakeMailbox(), db },
    );
    expect(attributed.sentBy).toBe(sam.id);

    // The shared password is a real answer, and it is null.
    const anonymous = await sendReply(
      updateTask(createTask({ messageId: 'm2', fromAddress: 'b@example.com' }, db).task.id,
        { status: 'awaiting_review' }, db)!.id,
      { finalReply: 'Somebody with the password sent this' },
      { provider: new FakeMailbox(), db },
    );
    expect(anonymous.sentBy).toBeNull();
  });

  it('queues the learning job with the draft and the sent text', async () => {
    const task = seed();
    await sendReply(
      task.id,
      { finalReply: 'The edited reply', reviewerNotes: 'too apologetic' },
      { provider: new FakeMailbox(), db },
    );

    const jobs = listJobs({ type: LEARN_FROM_SENT }, db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      taskId: task.id,
      originalDraft: 'A draft',
      sentReply: 'The edited reply',
      reviewerNotes: 'too apologetic',
      incomingSubject: 'Refund please',
    });
  });

  it('does not send twice when Send is clicked twice', async () => {
    const task = seed();
    const provider = new FakeMailbox();

    await sendReply(task.id, { finalReply: 'Once' }, { provider, db });
    const second = await sendReply(task.id, { finalReply: 'Twice' }, { provider, db });

    expect(provider.sent).toHaveLength(1);
    expect(second.finalReply).toBe('Once');
  });

  it('leaves the task reviewable when the mail server refuses it', async () => {
    const task = seed();
    const provider = new FakeMailbox();
    provider.failNextSend = 'SMTP said no';

    await expect(sendReply(task.id, { finalReply: 'Hello' }, { provider, db })).rejects.toThrow(
      'SMTP said no',
    );

    // Nothing was marked sent, and nothing was learned from a reply that never left.
    expect(getTask(task.id, db)!.status).toBe('awaiting_review');
    expect(listJobs({ type: LEARN_FROM_SENT }, db)).toHaveLength(0);
  });

  it('refuses to send an empty reply', async () => {
    const task = seed();
    const provider = new FakeMailbox();
    await expect(sendReply(task.id, { finalReply: '   ' }, { provider, db })).rejects.toThrow(
      /empty reply/,
    );
    expect(provider.sent).toHaveLength(0);
  });

  it('does not stack Re: prefixes', () => {
    expect(replySubject('Refund please')).toBe('Re: Refund please');
    expect(replySubject('Re: Refund please')).toBe('Re: Refund please');
    expect(replySubject('RE: Refund please')).toBe('RE: Refund please');
    expect(replySubject('   ')).toBe('Re:');
  });
});
