import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import type {
  DownloadedAttachment,
  MailAttachmentRef,
  MailMessage,
  MailMessageDetail,
  MailProvider,
  OutgoingMail,
  SendResult,
} from '../mail/types';
import { resetWorkspaceConfig } from '../config/workspace';
import { LEARN_FROM_SENT, TRANSLATE_TASK } from '../queue/handlers';
import { listJobs } from '../queue/store';
import { listAttachments } from '../tasks/attachments';
import { listEvents } from '../tasks/events';
import { listMessages } from '../tasks/messages';
import { createTask, getTask, updateTask } from '../tasks/store';
import { createOperator } from '../operators/store';
import { markHandled } from '../tasks/mark-read';
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
  /** What a test wants the Sent folder to already contain. */
  sentFolder: MailMessage[] = [];
  detailFetches: string[] = [];
  marked: string[] = [];
  failNextSend: string | null = null;
  failMarkAsRead: string | null = null;

  constructor(private readonly inbox: MailMessage[] = []) {}

  async listInbox(): Promise<MailMessage[]> {
    return this.inbox;
  }

  async listSent(): Promise<MailMessage[]> {
    return this.sentFolder;
  }

  /** What a test wants hanging off a message, keyed by message id. */
  attachments = new Map<string, MailAttachmentRef[]>();

  async getMessage(id: string): Promise<MailMessageDetail> {
    this.detailFetches.push(id);
    const message = this.inbox.find(m => m.id === id);
    if (!message) throw new Error(`no such message: ${id}`);
    return { ...message, text: `full body of ${id}`, attachments: this.attachments.get(id) ?? [] };
  }

  /** Whatever a test wants the thread to be, keyed by the message asked about. */
  threads = new Map<string, MailMessageDetail[]>();
  threadFetches: string[] = [];

  async getThread(message: MailMessage): Promise<MailMessageDetail[]> {
    this.threadFetches.push(message.id);
    // Not routed through getMessage: a real provider reads a thread in one
    // call, and counting it as a detail fetch would hide the thing
    // `detailFetches` exists to prove — that we pay for a body once per new
    // email and never for one we have already seen.
    const thread = this.threads.get(message.id);
    if (thread) return thread;
    const self = this.inbox.find(m => m.id === message.id);
    if (!self) throw new Error(`no such message: ${message.id}`);
    return [{ ...self, text: `full body of ${message.id}`, attachments: [] }];
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

  async markAsRead(id: string): Promise<void> {
    if (this.failMarkAsRead) throw new Error(this.failMarkAsRead);
    this.marked.push(id);
  }

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

  it('does not queue a draft for mail somebody already answered', async () => {
    const asked = message('q', {
      threadId: 'T1',
      receivedAt: '2026-08-01T09:00:00.000Z',
    });
    const provider = new FakeMailbox([asked]);
    provider.sentFolder = [
      message('r', {
        threadId: 'T1',
        from: { address: 'support@acme.test' },
        receivedAt: '2026-08-01T10:00:00.000Z',
      }),
    ];

    const result = await syncInbox({ provider, db });

    expect(result).toMatchObject({ scanned: 1, created: 0, answered: 1 });
    // Not a dismissed row either: the point is that nobody has to look at it.
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    expect(provider.detailFetches).toEqual([]);
  });

  it('still drafts when the customer wrote back after our reply', async () => {
    // The case that makes "has this thread been replied to?" the wrong
    // question. There is a reply in this conversation; it does not answer the
    // message that arrived after it.
    const provider = new FakeMailbox([
      message('followup', { threadId: 'T1', receivedAt: '2026-08-02T09:00:00.000Z' }),
    ]);
    provider.sentFolder = [
      message('r', {
        threadId: 'T1',
        from: { address: 'support@acme.test' },
        receivedAt: '2026-08-01T10:00:00.000Z',
      }),
    ];

    const result = await syncInbox({ provider, db });

    expect(result).toMatchObject({ created: 1, answered: 0 });
  });

  it('keeps a second question with a reused subject apart from the first', async () => {
    // Same subject, same customer, different Zoho thread. Merging them would
    // read the reply to Monday's ticket as an answer to Tuesday's.
    const provider = new FakeMailbox([
      message('tue', { threadId: 'T2', subject: 'Help', receivedAt: '2026-08-02T09:00:00.000Z' }),
    ]);
    provider.sentFolder = [
      message('mon-reply', {
        threadId: 'T1',
        subject: 'Re: Help',
        from: { address: 'support@acme.test' },
        to: [{ address: 'tue@example.com' }],
        receivedAt: '2026-08-03T10:00:00.000Z',
      }),
    ];

    const result = await syncInbox({ provider, db });

    expect(result).toMatchObject({ created: 1, answered: 0 });
  });

  it('drafts answered mail anyway when asked to', async () => {
    const provider = new FakeMailbox([
      message('q', { threadId: 'T1', receivedAt: '2026-08-01T09:00:00.000Z' }),
    ]);
    provider.sentFolder = [
      message('r', { threadId: 'T1', receivedAt: '2026-08-01T10:00:00.000Z' }),
    ];

    const result = await syncInbox({ provider, db, skipAnswered: false });

    expect(result).toMatchObject({ created: 1, answered: 0 });
  });

  it('drafts everything when the mailbox will not list sent mail', async () => {
    const provider = new FakeMailbox([message('a')]);
    provider.listSent = async () => {
      throw new Error('no sent folder here');
    };

    const result = await syncInbox({ provider, db });

    // A nuisance beats an outage: some already-handled mail in the queue is
    // recoverable, a sync that returns nothing is not.
    expect(result).toMatchObject({ created: 1, answered: 0, failures: [] });
  });

  it('writes down what the customer attached', async () => {
    const provider = new FakeMailbox([message('a', { hasAttachments: true })]);
    provider.attachments.set('a', [
      { id: 'att-1', filename: 'export.log', contentType: 'text/plain', size: 4096, inline: false },
      { id: 'att-2', filename: 'logo.png', contentType: 'image/png', size: 900, inline: true, contentId: 'cid:1' },
    ]);

    await syncInbox({ provider, db });

    const task = db.prepare('SELECT id FROM tasks').get() as { id: string };
    const files = listAttachments(task.id, db);

    expect(files.map(f => [f.filename, f.inline])).toEqual([
      ['export.log', false],
      // The signature logo is stored but flagged, so the reviewer and the
      // drafter can both leave it out of what "they attached something" means.
      ['logo.png', true],
    ]);
    // The provider ids are kept: without them there is nothing to fetch with.
    expect(files[0]).toMatchObject({ messageId: 'a', attachmentId: 'att-1', size: 4096 });
  });

  it('retires the unanswered task a follow-up overtook', async () => {
    const first = message('m1', { threadId: 'T1', receivedAt: '2026-08-01T09:00:00.000Z' });
    const provider = new FakeMailbox([first]);
    await syncInbox({ provider, db, skipAnswered: false });

    const older = getTask(
      (db.prepare('SELECT id FROM tasks').get() as { id: string }).id,
      db,
    )!;
    updateTask(older.id, { status: 'awaiting_review', draft: 'An answer to the first one' }, db);

    // Same conversation, an hour later: "actually, ignore that, I worked it out".
    const second = message('m2', { threadId: 'T1', receivedAt: '2026-08-01T10:00:00.000Z' });
    await syncInbox({ provider: new FakeMailbox([first, second]), db, skipAnswered: false });

    const newer = (db.prepare('SELECT id FROM tasks WHERE message_id = ?').get('m2') as { id: string }).id;
    expect(getTask(older.id, db)).toMatchObject({ status: 'dismissed', supersededBy: newer });
    // The draft is kept. It explains why the row is there, and nobody can send
    // a dismissed task by accident anyway.
    expect(getTask(older.id, db)?.draft).toBe('An answer to the first one');
  });

  it('dismisses a newsletter instead of drafting a reply to it', async () => {
    const news = message('m1', {
      from: { address: 'news@vendor.example' },
      headers: { 'list-unsubscribe': '<https://vendor.example/unsub>' },
    });
    const provider = new FakeMailbox([news]);

    const result = await syncInbox({ provider, db, skipAnswered: false });

    expect(result).toMatchObject({ created: 0, junk: 1 });
    const task = getTask((db.prepare('SELECT id FROM tasks').get() as { id: string }).id, db)!;
    expect(task.status).toBe('dismissed');
    // The reason is on the row, not only in a log, so somebody who thinks this
    // filter is eating their mail can see what it decided and why.
    expect(task.error).toContain('List-Unsubscribe');

    // The two things junk actually costs: a body fetch and three model calls.
    expect(provider.detailFetches).toEqual([]);
    expect(listJobs({}, db)).toEqual([]);
  });

  it('catches the bulk mail whose headers only arrive with the body', async () => {
    // Zoho's listing carries no headers at all; they come from a separate
    // endpoint on the detail fetch. The second check is what makes the filter
    // work there, and this is the shape that proves it.
    const news = message('m1', { from: { address: 'hello@vendor.example' } });
    const provider = new FakeMailbox([news]);
    const original = provider.getMessage.bind(provider);
    provider.getMessage = async (id: string) => ({
      ...(await original(id)),
      headers: { precedence: 'bulk' },
    });

    const result = await syncInbox({ provider, db, skipAnswered: false });

    expect(result).toMatchObject({ created: 0, junk: 1 });
    expect(listJobs({}, db)).toEqual([]);
  });

  it('still drafts for a person, headers and all', async () => {
    const real = message('m1', {
      headers: { 'return-path': '<sam@example.com>', precedence: 'urgent' },
    });
    const result = await syncInbox({ provider: new FakeMailbox([real]), db, skipAnswered: false });

    expect(result).toMatchObject({ created: 1, junk: 0 });
    expect(listJobs({}, db)).toHaveLength(1);
  });

  it('drafts for the newsletter anyway when asked to', async () => {
    const news = message('m1', { headers: { 'list-unsubscribe': '<https://x.example/u>' } });
    const result = await syncInbox({
      provider: new FakeMailbox([news]),
      db,
      skipAnswered: false,
      skipJunk: false,
    });

    expect(result).toMatchObject({ created: 1, junk: 0 });
    expect(listJobs({}, db)).toHaveLength(1);
  });

  it('does not let a newsletter retire a customer waiting for an answer', async () => {
    const question = message('m1', { threadId: 'T1', receivedAt: '2026-08-01T09:00:00.000Z' });
    const provider = new FakeMailbox([question]);
    await syncInbox({ provider, db, skipAnswered: false });
    const waiting = (db.prepare('SELECT id FROM tasks').get() as { id: string }).id;
    updateTask(waiting, { status: 'awaiting_review', draft: 'Here is the fix' }, db);

    // A vendor's automated note filed under the same server-side thread. It
    // is not a follow-up from the customer and must not cancel their reply.
    const noise = message('m2', {
      threadId: 'T1',
      receivedAt: '2026-08-01T10:00:00.000Z',
      headers: { 'auto-submitted': 'auto-generated' },
    });
    await syncInbox({ provider: new FakeMailbox([question, noise]), db, skipAnswered: false });

    expect(getTask(waiting, db)).toMatchObject({
      status: 'awaiting_review',
      supersededBy: null,
    });
  });

  it('leaves a reply that already went out alone', async () => {
    const first = message('m1', { threadId: 'T1', receivedAt: '2026-08-01T09:00:00.000Z' });
    await syncInbox({ provider: new FakeMailbox([first]), db, skipAnswered: false });

    const older = (db.prepare('SELECT id FROM tasks').get() as { id: string }).id;
    updateTask(older, { status: 'sent', finalReply: 'Already in their inbox' }, db);

    const second = message('m2', { threadId: 'T1', receivedAt: '2026-08-01T10:00:00.000Z' });
    await syncInbox({ provider: new FakeMailbox([first, second]), db, skipAnswered: false });

    // No later message unsends a mail, and rewriting the row would lose the
    // record of what a customer was actually told.
    expect(getTask(older, db)).toMatchObject({ status: 'sent', supersededBy: null });
  });

  it('does not touch another conversation with the same customer', async () => {
    const monday = message('m1', { threadId: 'T1', receivedAt: '2026-08-01T09:00:00.000Z' });
    await syncInbox({ provider: new FakeMailbox([monday]), db, skipAnswered: false });
    const older = (db.prepare('SELECT id FROM tasks').get() as { id: string }).id;
    updateTask(older, { status: 'awaiting_review' }, db);

    const tuesday = message('m2', { threadId: 'T2', receivedAt: '2026-08-02T09:00:00.000Z' });
    await syncInbox({ provider: new FakeMailbox([monday, tuesday]), db, skipAnswered: false });

    // Two questions, two answers owed. Merging them by sender would silently
    // drop one.
    expect(getTask(older, db)?.status).toBe('awaiting_review');
  });

  it('writes down what was attached earlier in the conversation too', async () => {
    // The screenshot usually arrives with the *first* message, and the mail we
    // are replying to is the third. A drafter told only about the last one asks
    // for a file that is two messages up the thread.
    const provider = new FakeMailbox([message('c')]);
    provider.threads.set('c', [
      {
        ...message('c0', { receivedAt: '2026-07-30T09:00:00.000Z' }),
        text: 'here is the file',
        attachments: [
          { id: 'att-0', filename: 'export.log', contentType: 'text/plain', size: 12, inline: false },
        ],
      },
    ]);

    await syncInbox({ provider, db });

    const task = db.prepare('SELECT id FROM tasks').get() as { id: string };
    expect(listAttachments(task.id, db).map(f => f.filename)).toEqual(['export.log']);
  });

  it('records the rest of the conversation, and which side said what', async () => {
    const latest = message('c');
    const provider = new FakeMailbox([latest]);
    provider.threads.set('c', [
      {
        ...message('c0', { receivedAt: '2026-07-30T09:00:00.000Z' }),
        from: { address: 'c@example.com' },
        text: 'my export came out silent',
        attachments: [],
      },
      {
        ...message('c1', { receivedAt: '2026-07-30T11:00:00.000Z' }),
        from: { address: 'Support@Acme.test', name: 'Acme Support' },
        text: 'we have refunded you in full',
        attachments: [],
      },
      { ...latest, text: 'full body of c', attachments: [] },
    ]);

    await syncInbox({ provider, db, self: 'support@acme.test' });

    const task = (db.prepare('SELECT id FROM tasks').get() as { id: string }).id;
    const thread = listMessages(task, db);

    // The message being replied to is the task body, not a history entry —
    // showing it twice invites a reply to the wrong copy.
    expect(thread.map(m => m.messageId)).toEqual(['c0', 'c1']);
    expect(thread.map(m => m.direction)).toEqual(['inbound', 'outbound']);
    // Our own address arrives capitalised however the server felt like it.
    expect(thread[1]!.fromAddress).toBe('support@acme.test');
    expect(thread[0]!.body).toBe('my export came out silent');
  });

  it('still creates the task when the thread cannot be read', async () => {
    const provider = new FakeMailbox([message('a')]);
    provider.getThread = async () => {
      throw new Error('mailbox said no');
    };

    const result = await syncInbox({ provider, db });

    // A drafter with no history writes a worse reply. A customer with no task
    // gets no reply at all, which is the failure worth avoiding.
    expect(result).toMatchObject({ created: 1, failures: [] });
    const task = (db.prepare('SELECT id FROM tasks').get() as { id: string }).id;
    expect(listMessages(task, db)).toEqual([]);
    expect(listJobs({ type: 'enrich-context' }, db)).toHaveLength(1);
  });

  it('files a sent reply against the conversation', async () => {
    const provider = new FakeMailbox();
    const { task } = createTask({ messageId: 'x', fromAddress: 'them@example.com', subject: 'Help' }, db);

    await sendReply(task.id, { finalReply: 'Have a look at Settings.' }, { provider, db, learn: false });

    const thread = listMessages(task.id, db);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ direction: 'outbound', body: 'Have a look at Settings.' });
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

  it('answers with Re: on the subject the customer wrote', async () => {
    const task = seed();
    const provider = new FakeMailbox();

    await sendReply(task.id, { finalReply: 'On its way.' }, { provider, db, learn: false });

    expect(provider.sent[0]!.subject).toBe('Re: Refund please');
  });

  it('sends a composed mail under its own subject', async () => {
    // "Re:" on a subject the recipient has never seen is how somebody decides
    // the sender is a bot, and it is what happens when the reply path is the
    // only path.
    const { task } = createTask(
      {
        origin: 'composed',
        subject: 'Yesterday’s export outage is fixed',
        fromAddress: 'customer@example.com',
      },
      db,
    );
    updateTask(task.id, { status: 'awaiting_review', draft: 'All re-run.' }, db);
    const provider = new FakeMailbox();

    await sendReply(task.id, { finalReply: 'All re-run.' }, { provider, db, learn: false });

    expect(provider.sent[0]!.subject).toBe('Yesterday’s export outage is fixed');
    // Nothing to be in reply to, so nothing claiming to be.
    expect(provider.sent[0]!.inReplyTo).toBeUndefined();
  });

  it('carries the reviewer\u2019s files, and keeps only their names', async () => {
    const task = seed();
    const provider = new FakeMailbox();

    await sendReply(
      task.id,
      {
        finalReply: 'The invoice is attached.',
        attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF') }],
      },
      { provider, db, learn: false },
    );

    expect(provider.sent[0]!.attachments?.[0]).toMatchObject({ filename: 'invoice.pdf' });
    // Not stored, because the Sent folder is already holding the copy \u2014 but
    // the audit trail has to be able to answer "why does this customer have
    // our invoice", and only the event can.
    const sentEvent = listEvents(task.id, db).find(event => event.action === 'sent');
    expect(sentEvent?.detail).toBe('attached invoice.pdf');
    expect(listAttachments(task.id, db)).toEqual([]);
  });

  it('sends an HTML part saying exactly what the text part says', async () => {
    const task = seed();
    const provider = new FakeMailbox();

    await sendReply(
      task.id,
      { finalReply: 'Hi,\n\nThe refund is on its way.' },
      { provider, db },
    );

    const mail = provider.sent[0]!;
    expect(mail.text).toBe('Hi,\n\nThe refund is on its way.');
    expect(mail.html).toBe('<p>Hi,</p>\n<p>The refund is on its way.</p>');
  });

  it('sends text only when the desk has asked for text only', async () => {
    const task = seed();
    const provider = new FakeMailbox();
    process.env.MAIL_REPLY_HTML = 'false';

    try {
      await sendReply(task.id, { finalReply: 'Plain and deliberate.' }, { provider, db });
    } finally {
      delete process.env.MAIL_REPLY_HTML;
    }

    expect(provider.sent[0]!.text).toBe('Plain and deliberate.');
    // Absent, not empty: an empty html part is still a multipart/alternative
    // mail, and some clients will render the empty half.
    expect(provider.sent[0]!.html).toBeUndefined();
  });

  /** Runs `body` on an install whose reviewer reads Chinese. */
  async function withReviewLanguage(body: () => Promise<void>): Promise<void> {
    process.env.AAS_REVIEW_LANGUAGE = 'Chinese';
    resetWorkspaceConfig();
    try {
      await body();
    } finally {
      delete process.env.AAS_REVIEW_LANGUAGE;
      resetWorkspaceConfig();
    }
  }

  it('queues a rendering of the reply a human rewrote before sending', async () => {
    // Without this the "what went out" panel is empty forever for anybody who
    // does not read the reply's language: the stored translation is of the
    // draft, and the draft is not what was sent.
    const task = seed();
    const provider = new FakeMailbox();

    await withReviewLanguage(async () => {
      await sendReply(task.id, { finalReply: 'Not the draft at all' }, { provider, db, learn: false });
    });

    expect(listJobs({ type: TRANSLATE_TASK }, db)).toHaveLength(1);
  });

  it('does not pay to render a draft that was sent unchanged', async () => {
    const task = seed();
    const provider = new FakeMailbox();

    await withReviewLanguage(async () => {
      await sendReply(task.id, { finalReply: 'A draft' }, { provider, db, learn: false });
    });

    // Approving without editing is the common case, and that text was already
    // translated when it was drafted.
    expect(listJobs({ type: TRANSLATE_TASK }, db)).toHaveLength(0);
  });

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

  it('clears the unread flag on the mail it just answered', async () => {
    const task = seed();
    const provider = new FakeMailbox();

    await sendReply(task.id, { finalReply: 'The edited reply' }, { provider, db });

    expect(provider.marked).toEqual(['m1']);
  });

  it('still counts as sent when the unread flag will not clear', async () => {
    const task = seed();
    const provider = new FakeMailbox();
    provider.failMarkAsRead = 'IMAP dropped the connection';

    // The mail is already gone. Throwing here would tell the reviewer the send
    // failed and they would send it again.
    const updated = await sendReply(task.id, { finalReply: 'The edited reply' }, { provider, db });

    expect(updated.status).toBe('sent');
    expect(provider.sent).toHaveLength(1);
    expect(listJobs({ type: LEARN_FROM_SENT }, db)).toHaveLength(1);
  });

  it('does not stack Re: prefixes', () => {
    expect(replySubject('Refund please')).toBe('Re: Refund please');
    expect(replySubject('Re: Refund please')).toBe('Re: Refund please');
    expect(replySubject('RE: Refund please')).toBe('RE: Refund please');
    expect(replySubject('   ')).toBe('Re:');
  });
});

describe('markHandled', () => {
  it('marks the message read and says it did', async () => {
    const { task } = createTask({ messageId: 'm7', fromAddress: 'a@example.com' }, db);
    const provider = new FakeMailbox();

    expect(await markHandled(task, { provider })).toBe(true);
    expect(provider.marked).toEqual(['m7']);
  });

  it('does not open a mailbox for a task that came from nowhere', async () => {
    // Demo rows and hand-made tasks have no provider id — there is no message
    // to mark, and connecting only to discover that would be a waste.
    const { task } = createTask({ fromAddress: 'a@example.com' }, db);
    const provider = new FakeMailbox();

    expect(task.messageId).toBeNull();
    expect(await markHandled(task, { provider })).toBe(false);
    expect(provider.marked).toEqual([]);
  });

  it('reports failure instead of raising it', async () => {
    const { task } = createTask({ messageId: 'm8', fromAddress: 'a@example.com' }, db);
    const provider = new FakeMailbox();
    provider.failMarkAsRead = 'mailbox gone';

    expect(await markHandled(task, { provider })).toBe(false);
  });
});
