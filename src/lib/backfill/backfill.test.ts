import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { resetWorkspaceConfig } from '../config/workspace';
import { openDb, type Db } from '../db';
import type {
  DownloadedAttachment,
  MailMessage,
  MailMessageDetail,
  MailProvider,
  OutgoingMail,
  SendResult,
} from '../mail/types';
import {
  BACKFILL_LEARN,
  backfillLearnHandler,
  enqueueBackfillLearn,
  enqueueBackfillScan,
  enqueuePendingBackfill,
  maybeConsolidate,
} from '../queue/handlers';
import { listJobs } from '../queue/store';
import { createRule, listRules } from '../rules/store';
import { findAnsweredMessage, runBackfillItem } from './learn';
import { scanSentMail } from './scan';
import {
  cancelPendingBackfill,
  clearBackfill,
  countBackfillByStatus,
  createBackfillItem,
  listBackfillItems,
  totalRulesLearned,
} from './store';

// --- an AI server that hands back whatever the test queued ----------------

let server: Server | undefined;
const queued: string[] = [];
const prompts: string[] = [];

async function startAi(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      prompts.push(body.messages.map((m: { content: string }) => m.content).join('\n'));
      const content = queued.shift() ?? '{}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });

  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server!.address() as AddressInfo;

  process.env.AI_PROVIDER = 'openai-compatible';
  process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.AI_MODEL = 'test-model';
  process.env.AI_API_KEY = '';
  process.env.AI_MAX_RETRIES = '0';
  resetAiConfig();
}

// --- a mailbox with a history --------------------------------------------

const US = 'support@acme.test';

function msg(id: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    subject: 'Where is my refund?',
    from: { address: 'customer@example.com', name: 'Alex Customer' },
    to: [{ address: US }],
    receivedAt: '2026-01-10T09:00:00.000Z',
    isRead: true,
    hasAttachments: false,
    ...overrides,
  };
}

function ours(id: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return msg(id, {
    subject: 'Re: Where is my refund?',
    from: { address: US, name: 'Acme Support' },
    to: [{ address: 'customer@example.com' }],
    receivedAt: '2026-01-10T11:00:00.000Z',
    ...overrides,
  });
}

/**
 * Not a mocking library. These tests are about the sequence of calls between
 * the store, the queue, the provider and the model — a framework that let any
 * of those change without a test noticing would be testing nothing.
 */
class Archive implements MailProvider {
  readonly id = 'fake';
  readonly label = 'Fake';

  /** Anything appended here is a bug: the backfill must never send. */
  sends: OutgoingMail[] = [];
  bodies = new Map<string, string>();
  threads = new Map<string, string[]>();

  constructor(private readonly messages: MailMessage[] = []) {}

  async listInbox(): Promise<MailMessage[]> {
    return [];
  }

  async listSent(options: { limit?: number; since?: string } = {}): Promise<MailMessage[]> {
    let out = this.messages.filter(m => m.from.address === US);
    if (options.since) out = out.filter(m => m.receivedAt >= options.since!);
    // Newest first, the way a real Sent mailbox lists.
    out = [...out].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return out.slice(0, options.limit ?? 50);
  }

  async getMessage(id: string): Promise<MailMessageDetail> {
    const message = this.messages.find(m => m.id === id);
    if (!message) throw new Error(`no such message: ${id}`);
    return { ...message, text: this.bodies.get(id) ?? `body of ${id}`, attachments: [] };
  }

  async getThread(message: MailMessage): Promise<MailMessageDetail[]> {
    const ids = this.threads.get(message.id) ?? [message.id];
    return Promise.all(ids.map(id => this.getMessage(id)));
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    this.sends.push(mail);
    return { messageId: 'should-never-happen' };
  }

  async markAsRead(): Promise<void> {}

  async downloadAttachment(): Promise<DownloadedAttachment> {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

function archive(): Archive {
  const incoming = msg('in-1');
  const reply = ours('out-1');
  const provider = new Archive([incoming, reply]);
  provider.bodies.set('in-1', 'You promised me a refund three days ago. Where is it?');
  provider.bodies.set(
    'out-1',
    'We have escalated this to our payments team and will update you within one business day.',
  );
  provider.threads.set('out-1', ['in-1', 'out-1']);
  provider.threads.set('in-1', ['in-1', 'out-1']);
  return provider;
}

const DRAFT = JSON.stringify({
  intent: 'Wants to know why a promised refund has not arrived',
  language: 'en',
  sentiment: 'negative',
  scope: 'refund',
  keyPoints: ['Was promised a refund three days ago'],
  suggestedActions: [],
  draft: 'So sorry! Your refund will be with you within three days.',
});

const APPROVED = JSON.stringify({ approved: true, issues: [] });

const ONE_RULE = JSON.stringify({
  newRules: [
    {
      content: 'Never commit to a refund date that has not been confirmed by payments.',
      category: 'policy',
      rationale: 'The human escalated instead of promising a date',
    },
  ],
});

const NO_RULES = JSON.stringify({ newRules: [] });
/** The deduper's verdict, asked for once per proposed rule. */
const ADD = JSON.stringify({ action: 'add', reason: 'nothing like it in the rulebook' });

let db: Db;
let configDir: string;

beforeEach(async () => {
  db = openDb(':memory:');
  queued.length = 0;
  prompts.length = 0;
  configDir = mkdtempSync(join(tmpdir(), 'aas-backfill-'));
  process.env.AAS_CONFIG = join(configDir, 'absent.json');
  resetWorkspaceConfig();
  await startAi();
});

afterEach(async () => {
  db.close();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.AAS_CONFIG;
  resetWorkspaceConfig();
  resetAiConfig();
});

describe('scanning the sent folder', () => {
  it('queues one item per reply, oldest first', async () => {
    const provider = new Archive([
      msg('in-1'),
      ours('out-1', { receivedAt: '2026-03-01T10:00:00.000Z' }),
      ours('out-2', { receivedAt: '2026-01-01T10:00:00.000Z' }),
    ]);

    const result = await scanSentMail({ provider, db });

    expect(result).toMatchObject({ scanned: 2, created: 2, existed: 0 });
    // Insertion order is what the queue breaks ties on, so it decides the
    // order the rulebook is taught in.
    expect(listBackfillItems({}, db).map(i => i.sentMessageId)).toEqual(['out-2', 'out-1']);
  });

  it('is idempotent, so overlapping windows do not teach twice', async () => {
    const provider = archive();

    await scanSentMail({ provider, db });
    const second = await scanSentMail({ provider, db });

    expect(second).toMatchObject({ scanned: 1, created: 0, existed: 1 });
    expect(listBackfillItems({}, db)).toHaveLength(1);
  });

  it('honours the since window', async () => {
    const provider = new Archive([
      ours('old', { receivedAt: '2020-01-01T00:00:00.000Z' }),
      ours('new', { receivedAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    await scanSentMail({ provider, db, since: '2025-01-01T00:00:00.000Z' });

    expect(listBackfillItems({}, db).map(i => i.sentMessageId)).toEqual(['new']);
  });
});

describe('finding the message a reply answered', () => {
  const detail = (m: MailMessage): MailMessageDetail => ({ ...m, attachments: [] });

  it('takes the newest inbound message before the reply', () => {
    const reply = detail(ours('out-1', { receivedAt: '2026-01-10T11:00:00.000Z' }));
    const first = detail(msg('in-1', { receivedAt: '2026-01-09T09:00:00.000Z' }));
    const second = detail(msg('in-2', { receivedAt: '2026-01-10T10:00:00.000Z' }));
    const later = detail(msg('in-3', { receivedAt: '2026-01-11T08:00:00.000Z' }));

    expect(findAnsweredMessage(reply, [first, second, later, reply])?.id).toBe('in-2');
  });

  it('decides who is us from the reply, not from configuration', () => {
    // A shared mailbox that sends as an alias: MAIL_USER would have been wrong
    // here, and pairing the reply with itself would feed the model its own
    // output as the customer's email.
    const reply = detail(ours('out-1', { from: { address: 'alias@acme.test' } }));
    const mine = detail(msg('out-0', { from: { address: 'alias@acme.test' } }));
    const theirs = detail(msg('in-1'));

    expect(findAnsweredMessage(reply, [mine, theirs, reply])?.id).toBe('in-1');
  });

  it('returns nothing for a conversation we started', () => {
    const reply = detail(ours('out-1'));
    expect(findAnsweredMessage(reply, [reply])).toBeNull();
  });
});

describe('learning from one archived exchange', () => {
  it('diffs a counterfactual draft against what was really sent', async () => {
    const provider = archive();
    await scanSentMail({ provider, db });
    const [item] = listBackfillItems({}, db);

    queued.push(DRAFT, APPROVED, ONE_RULE, ADD);
    const result = await runBackfillItem(item!.id, { provider, db });

    expect(result.status).toBe('learned');
    expect(result.rulesLearned).toBe(1);

    const rules = listRules({}, db);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.content).toMatch(/refund date/i);
    // Provenance points at the archive, which is what the rules screen needs
    // to avoid linking to a task row that does not exist.
    expect(rules[0]!.sourceTaskId).toBe(`backfill:${item!.id}`);

    const stored = listBackfillItems({}, db)[0]!;
    expect(stored.status).toBe('learned');
    expect(stored.incomingMessageId).toBe('in-1');
    expect(stored.shadowDraft).toContain('refund');
  });

  it('never sends anything', async () => {
    const provider = archive();
    await scanSentMail({ provider, db });
    const [item] = listBackfillItems({}, db);

    queued.push(DRAFT, APPROVED, NO_RULES);
    await runBackfillItem(item!.id, { provider, db });

    expect(provider.sends).toEqual([]);
  });

  it('tells the extractor the human never saw the draft', async () => {
    const provider = archive();
    await scanSentMail({ provider, db });
    const [item] = listBackfillItems({}, db);

    queued.push(DRAFT, APPROVED, NO_RULES);
    await runBackfillItem(item!.id, { provider, db });

    const extraction = prompts[prompts.length - 1]!;
    expect(extraction).toContain('from the archive');
    expect(extraction).toMatch(/independent answers to the same message/);
    // The review framing must not leak in: it would tell the model that a
    // difference in wording is a correction, which here it is not.
    expect(extraction).not.toContain('The human edited the draft before sending');
  });

  it('does not let archived mail inflate a rule usage count', async () => {
    createRule({ content: 'Answer in the language the customer wrote in.' }, db);

    const provider = archive();
    await scanSentMail({ provider, db });
    const [item] = listBackfillItems({}, db);

    queued.push(DRAFT, APPROVED, NO_RULES);
    await runBackfillItem(item!.id, { provider, db });

    // The rule was in the prompt, but `used 0×` still means "never used on
    // real mail" — the only reading that makes the number worth having.
    expect(listRules({}, db)[0]!.appliedCount).toBe(0);
  });

  it('skips a reply that answered nothing', async () => {
    const provider = new Archive([ours('out-1')]);
    provider.threads.set('out-1', ['out-1']);
    await scanSentMail({ provider, db });
    const [item] = listBackfillItems({}, db);

    const result = await runBackfillItem(item!.id, { provider, db });

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/nothing inbound/i);
    // Skipping is not failing, and it costs no model call.
    expect(prompts).toHaveLength(0);
    expect(listBackfillItems({}, db)[0]!.skipReason).toMatch(/nothing inbound/i);
  });

  it('skips a reply with no readable body', async () => {
    const provider = archive();
    provider.bodies.set('out-1', '   ');
    await scanSentMail({ provider, db });
    const [item] = listBackfillItems({}, db);

    const result = await runBackfillItem(item!.id, { provider, db });

    expect(result.status).toBe('skipped');
    expect(prompts).toHaveLength(0);
  });
});

describe('the queue handlers', () => {
  it('a scan enqueues every pending item, not just the new ones', async () => {
    const provider = archive();
    await scanSentMail({ provider, db });

    // A row left behind by an earlier, interrupted run. Nobody else is ever
    // going to enqueue it, and a second scan is when a person expects it to
    // start moving again.
    createBackfillItem({ sentMessageId: 'orphan' }, db);

    expect(enqueuePendingBackfill(db)).toBe(2);
    expect(listJobs({ type: BACKFILL_LEARN }, db)).toHaveLength(2);
    // Running it again costs nothing.
    expect(enqueuePendingBackfill(db)).toBe(0);
  });

  it('enqueues one job per item however often it is asked', () => {
    const first = enqueueBackfillLearn('item-1', { db });
    const second = enqueueBackfillLearn('item-1', { db });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(listJobs({ type: BACKFILL_LEARN }, db)).toHaveLength(1);
  });

  it('runs behind everything a human is waiting on', () => {
    const { job } = enqueueBackfillScan({}, { db });
    expect(job.priority).toBe(9);
  });

  it('reports a missing item rather than throwing at the worker', async () => {
    const result = await runBackfillItem('gone', { provider: new Archive(), db });
    expect(result.status).toBe('failed');
  });

  it('tidies the rulebook every 25 items, and not in between', () => {
    const finish = (n: number) => {
      for (let i = 0; i < n; i += 1) {
        const { item } = createBackfillItem({ sentMessageId: `m-${i}-${n}` }, db);
        db.prepare("UPDATE backfill_items SET status = 'learned' WHERE id = ?").run(item.id);
      }
    };

    finish(24);
    expect(maybeConsolidate(db)).toBe(false);
    finish(1);
    expect(maybeConsolidate(db)).toBe(true);
  });

  it('rejects a payload with no item id, permanently', async () => {
    await expect(
      backfillLearnHandler({}, { db, job: { id: 'j', type: BACKFILL_LEARN } as never }),
    ).rejects.toThrow(/itemId/);
  });
});

describe('stopping and clearing', () => {
  it('cancels what has not started and leaves what has', () => {
    createBackfillItem({ sentMessageId: 'a' }, db);
    const { item } = createBackfillItem({ sentMessageId: 'b' }, db);
    db.prepare("UPDATE backfill_items SET status = 'learning' WHERE id = ?").run(item.id);

    expect(cancelPendingBackfill(db)).toBe(1);

    const counts = countBackfillByStatus(db);
    expect(counts.skipped).toBe(1);
    // Its job holds a lease and is probably mid-generation; whatever the
    // handler writes when it lands should win.
    expect(counts.learning).toBe(1);
  });

  it('clearing forgets the run but keeps the rules it taught', () => {
    createRule({ content: 'A rule the backfill produced.', sourceTaskId: 'backfill:x' }, db);
    createBackfillItem({ sentMessageId: 'a' }, db);

    clearBackfill(db);

    expect(listBackfillItems({}, db)).toHaveLength(0);
    expect(listRules({}, db)).toHaveLength(1);
  });

  it('counts the rules a run produced', () => {
    const { item } = createBackfillItem({ sentMessageId: 'a' }, db);
    db.prepare('UPDATE backfill_items SET rules_learned = 3 WHERE id = ?').run(item.id);
    expect(totalRulesLearned(db)).toBe(3);
  });
});
