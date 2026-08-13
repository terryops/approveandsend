import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import {
  DEFAULT_WORKSPACE,
  describeTopics,
  describeWorkspace,
  loadWorkspaceConfig,
  resetWorkspaceConfig,
  topicLabel,
  type WorkspaceConfig,
} from '../config/workspace';
import { openDb, type Db } from '../db';
import {
  enqueueDraftReply,
  DRAFT_REPLY,
  draftReplyHandler,
  SUGGEST_ALTERNATIVES,
  alternativesKey,
} from '../queue/handlers';
import { enqueue, isQueued, listJobs } from '../queue/store';
import { createWorker } from '../queue/worker';
import { createRule, listRules } from '../rules/store';
import { listAlternatives, replaceAlternatives } from '../tasks/alternatives';
import { addMessage, countMessages, listMessages } from '../tasks/messages';
import { countTasksByStatus, createTask, deleteTask, getTask, listTasks, markOpened, updateTask } from '../tasks/store';
import { listVersions } from '../tasks/versions';
import { draftReply } from './draft';

// --- an AI server that returns whatever the test queues -------------------

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

let db: Db;
let configDir: string;

const WORKSPACE_ENV = [
  'AAS_CONFIG',
  'AAS_ORGANIZATION',
  'AAS_PRODUCT',
  'AAS_VOICE',
  'AAS_SIGNATURE',
  'AAS_REPLY_LANGUAGE',
  'AAS_AUTO_APPROVE_RULES',
  'AAS_LANGUAGE',
];

beforeEach(async () => {
  db = openDb(':memory:');
  queued.length = 0;
  prompts.length = 0;
  configDir = mkdtempSync(join(tmpdir(), 'aas-'));
  // Point at a path that does not exist, so a stray config file in the repo
  // root cannot change what these tests assert.
  process.env.AAS_CONFIG = join(configDir, 'absent.json');
  resetWorkspaceConfig();
  await startAi();
});

afterEach(async () => {
  db.close();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  rmSync(configDir, { recursive: true, force: true });
  for (const key of WORKSPACE_ENV) delete process.env[key];
  resetWorkspaceConfig();
  resetAiConfig();
});

function writeConfig(value: unknown): void {
  const path = join(configDir, 'aas.config.json');
  writeFileSync(path, JSON.stringify(value));
  process.env.AAS_CONFIG = path;
  resetWorkspaceConfig();
}

const INCOMING = {
  messageId: 'INBOX:1:42',
  messageIdHeader: '<abc@mail.example.com>',
  subject: 'Where is my refund?',
  fromAddress: 'customer@example.com',
  fromName: 'Alex Customer',
  body: '<p>I was told three days ago that a refund was on its way.</p>',
  receivedAt: '2026-08-01T10:00:00.000Z',
};

const GOOD_DRAFT = JSON.stringify({
  intent: 'Wants to know why a promised refund has not arrived',
  language: 'en',
  sentiment: 'negative',
  scope: 'refund',
  keyPoints: ['Was told three days ago a refund was coming'],
  suggestedActions: ['Check the payment provider for the refund status'],
  draft: 'We have escalated this and will update you shortly.',
});

describe('workspace config', () => {
  it('starts from bland defaults rather than refusing to run', () => {
    const config = loadWorkspaceConfig();
    expect(config.organization).toBe(DEFAULT_WORKSPACE.organization);
    expect(config.replyLanguage).toBe('match');
  });

  it('reads a config file', () => {
    writeConfig({ organization: 'Acme', product: 'Acme Cloud', facts: ['Refunds take 5-10 business days.'] });

    const config = loadWorkspaceConfig();
    expect(config.organization).toBe('Acme');
    expect(config.product).toBe('Acme Cloud');
    expect(config.facts).toEqual(['Refunds take 5-10 business days.']);
  });

  it('lets the environment override one field without a rebuild', () => {
    writeConfig({ organization: 'Acme' });
    process.env.AAS_ORGANIZATION = 'Acme Europe';
    resetWorkspaceConfig();

    expect(loadWorkspaceConfig().organization).toBe('Acme Europe');
  });

  it('throws on a malformed config rather than silently losing the policy facts', () => {
    const path = join(configDir, 'broken.json');
    writeFileSync(path, '{ not json');
    process.env.AAS_CONFIG = path;
    resetWorkspaceConfig();

    expect(() => loadWorkspaceConfig()).toThrow(/Could not read/);
  });

  it('ignores non-string entries in the facts list', () => {
    writeConfig({ facts: ['real fact', 42, null, '  '] });
    expect(loadWorkspaceConfig().facts).toEqual(['real fact']);
  });

  it('teaches itself without asking unless the desk says otherwise', () => {
    expect(loadWorkspaceConfig().autoApproveRules).toBe(true);
    writeConfig({ autoApproveRules: false });
    expect(loadWorkspaceConfig().autoApproveRules).toBe(false);
  });

  it('takes the approval gate from the environment, spelled any of the usual ways', () => {
    writeConfig({ autoApproveRules: true });
    for (const [text, expected] of [
      ['false', false],
      ['0', false],
      ['no', false],
      ['off', false],
      ['true', true],
      ['1', true],
      ['YES', true],
    ] as const) {
      process.env.AAS_AUTO_APPROVE_RULES = text;
      resetWorkspaceConfig();
      expect(loadWorkspaceConfig().autoApproveRules, text).toBe(expected);
    }
  });

  it('falls through to the file rather than guessing at a value it cannot read', () => {
    // A typo here decides whether a stranger's email can rewrite the rulebook,
    // so an unreadable answer is no answer — not a quiet "no".
    writeConfig({ autoApproveRules: false });
    process.env.AAS_AUTO_APPROVE_RULES = 'maybe';
    resetWorkspaceConfig();
    expect(loadWorkspaceConfig().autoApproveRules).toBe(false);

    writeConfig({ autoApproveRules: 'nonsense' });
    expect(loadWorkspaceConfig().autoApproveRules).toBe(true);
  });

  it('normalises the topic vocabulary and drops entries that are not topics', () => {
    writeConfig({
      topics: [
        { slug: '  Refunds ', description: 'money back' },
        { slug: 'refunds', description: 'money back, disputes' },
        { slug: 'no description' },
        { slug: '' },
        'not an object',
        { description: 'no slug' },
      ],
    });

    // The duplicate is a correction, not an error: last one wins.
    expect(loadWorkspaceConfig().topics).toEqual([
      { slug: 'refunds', description: 'money back, disputes' },
      { slug: 'no-description', description: '' },
    ]);
  });

  it('keeps a reviewer-facing label and leaves it off when there is none', () => {
    writeConfig({
      topics: [
        { slug: 'refunds', label: '  退款与取消  ', description: 'money back' },
        { slug: 'press', label: '   ', description: 'journalists' },
        { slug: 'api', description: 'integrations' },
      ],
    });

    expect(loadWorkspaceConfig().topics).toEqual([
      { slug: 'refunds', label: '退款与取消', description: 'money back' },
      // A blank label is no label, not an empty one that renders as a gap.
      { slug: 'press', description: 'journalists' },
      { slug: 'api', description: 'integrations' },
    ]);
  });

  it('shows the label, and falls back to the slug for anything unlabelled', () => {
    const config: WorkspaceConfig = {
      ...DEFAULT_WORKSPACE,
      topics: [
        { slug: 'refunds', label: '退款与取消', description: 'money back' },
        { slug: 'api', description: 'integrations' },
      ],
    };

    expect(topicLabel('refunds', config)).toBe('退款与取消');
    expect(topicLabel('api', config)).toBe('api');
    // A scope with no topic behind it: a free-form slug, or a topic somebody
    // deleted from the config while tasks were still tagged with it.
    expect(topicLabel('churn', config)).toBe('churn');
  });

  it('gives the classifier slugs and descriptions, never the label', () => {
    const config: WorkspaceConfig = {
      ...DEFAULT_WORKSPACE,
      topics: [{ slug: 'refunds', label: '退款与取消', description: 'money back' }],
    };

    // The label is for the reviewer. Offering it here would invite the model
    // to answer with it, and a scope of "退款与取消" matches no rule.
    const block = describeTopics(config);
    expect(block).toContain('- refunds: money back');
    expect(block).not.toContain('退款与取消');
  });

  it('tells the classifier to choose a name rather than invent one', () => {
    const config: WorkspaceConfig = {
      ...DEFAULT_WORKSPACE,
      topics: [{ slug: 'refunds', description: 'money back' }],
    };

    const block = describeTopics(config);
    expect(block).toContain('- refunds: money back');
    expect(block).toContain('rather than inventing a name');

    // No vocabulary configured is not "no topics" — it is the feature off,
    // and the prompt must not grow an empty list.
    expect(describeTopics(DEFAULT_WORKSPACE)).toBe('');
  });

  it('puts the facts and the never-promise list into the persona block', () => {
    const config: WorkspaceConfig = {
      organization: 'Acme',
      appName: '',
      voice: 'Terse.',
      facts: ['Refunds take 5-10 business days.'],
      signature: '',
      timeZone: '',
      replyLanguage: 'match',
      reviewLanguage: '',
    language: 'en',
      topics: [],
      neverPromise: ['a refund date'],
      autoApproveRules: true,
      refundOnDisputeWithdrawal: true,
      contextSources: [],
    };

    const text = describeWorkspace(config);
    expect(text).toContain('Acme');
    expect(text).toContain('Refunds take 5-10 business days.');
    expect(text).toContain('a refund date');
    expect(text).toContain('same language');
  });

  it('states the forced language when one is configured', () => {
    expect(describeWorkspace({ ...DEFAULT_WORKSPACE, replyLanguage: 'en' })).toContain('Reply in en');
  });
});

describe('task store', () => {
  it('ingests an email', () => {
    const { task, existed } = createTask(INCOMING, db);
    expect(existed).toBe(false);
    expect(task.status).toBe('pending');
    expect(task.subject).toBe('Where is my refund?');
    expect(task.analysis).toBeNull();
  });

  it('ingesting the same message twice returns the first task', () => {
    const first = createTask(INCOMING, db);
    const second = createTask({ ...INCOMING, subject: 'changed' }, db);

    expect(second.existed).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.subject).toBe('Where is my refund?');
  });

  it('keeps a dismissed email dismissed across the next sync', () => {
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { status: 'dismissed' }, db);

    expect(createTask(INCOMING, db).task.status).toBe('dismissed');
    expect(listTasks({}, db)).toHaveLength(1);
  });

  it('does not treat two messages without ids as the same one', () => {
    createTask({ subject: 'a' }, db);
    createTask({ subject: 'b' }, db);
    expect(listTasks({}, db)).toHaveLength(2);
  });

  it('round-trips the analysis', () => {
    const { task } = createTask(INCOMING, db);
    const analysis = {
      intent: 'Wants a refund',
      language: 'en',
      sentiment: 'angry' as const,
      keyPoints: ['a', 'b'],
      suggestedActions: [],
      scope: 'refund',
    };

    updateTask(task.id, { analysis }, db);
    expect(getTask(task.id, db)?.analysis).toEqual(analysis);
  });

  it('survives an analysis column that is not valid JSON', () => {
    const { task } = createTask(INCOMING, db);
    db.prepare('UPDATE tasks SET analysis = ? WHERE id = ?').run('{broken', task.id);
    expect(getTask(task.id, db)?.analysis).toBeNull();
  });

  it('filters by status and scope', () => {
    const a = createTask({ subject: 'a' }, db).task;
    createTask({ subject: 'b' }, db);
    updateTask(a.id, { status: 'sent', scope: 'refund' }, db);

    expect(listTasks({ status: 'sent' }, db)).toHaveLength(1);
    expect(listTasks({ scope: 'refund' }, db)).toHaveLength(1);
    expect(listTasks({ status: 'pending' }, db)).toHaveLength(1);
  });

  it('counts by status for the queue badge', () => {
    createTask({ subject: 'a' }, db);
    const b = createTask({ subject: 'b' }, db).task;
    updateTask(b.id, { status: 'sent' }, db);

    expect(countTasksByStatus({}, db)).toEqual({ pending: 1, sent: 1 });
  });

  it('leaves untouched fields alone on a partial update', () => {
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { draft: 'hello' }, db);
    updateTask(task.id, { status: 'awaiting_review' }, db);

    const updated = getTask(task.id, db);
    expect(updated?.draft).toBe('hello');
    expect(updated?.status).toBe('awaiting_review');
  });

  it('is a no-op for an unknown id', () => {
    expect(updateTask('nope', { draft: 'x' }, db)).toBeNull();
    expect(deleteTask('nope', db)).toBe(false);
  });
});

describe('the reviewer steering a redraft', () => {
  it('puts the note in the prompt, after the rules and before the email', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { reviewerNotes: 'Too formal. Say the refund is already on its way.' }, db);

    await draftReply(getTask(task.id, db)!, { db });

    const prompt = prompts[0]!;
    expect(prompt).toContain('What the reviewer said about the last attempt');
    expect(prompt).toContain('the refund is already on its way');
    // Precedence stated rather than inferred, and it runs the reviewer's way:
    // the person looking at this customer beats a rule written for the general
    // case. Without this, a note asking for something the rulebook forbids was
    // silently dropped and the same draft came back.
    expect(prompt).toContain('the instruction wins');
    // Last thing before the email, which is what makes it the most specific
    // instruction in the prompt.
    expect(prompt.indexOf('What the reviewer said')).toBeLessThan(
      prompt.indexOf("The customer's email"),
    );
  });

  it('says nothing at all when there is no note', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);

    await draftReply(task, { db });

    expect(prompts[0]!).not.toContain('What the reviewer said');
  });

  it('shows the drafter the reply that is already on the table', async () => {
    // The bug this fixes: Redraft rebuilt the prompt from the mail and the
    // rules alone, so a draft somebody had edited by hand — or swapped for an
    // option off the strip — was written again from the first version, and the
    // only way to keep an edit was to stop asking for help.
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    updateTask(
      task.id,
      { draft: 'We have already refunded you in full.', reviewerNotes: 'Warmer, please.' },
      db,
    );

    await draftReply(getTask(task.id, db)!, { db });

    const prompt = prompts[0]!;
    expect(prompt).toContain('The reply already on the table');
    expect(prompt).toContain('We have already refunded you in full.');
    expect(prompt).toContain('Revise this.');
    // Before the note, which is the thing that says what to do with it.
    expect(prompt.indexOf('The reply already on the table')).toBeLessThan(
      prompt.indexOf('What the reviewer said'),
    );
  });

  it('asks for a different attempt when the reviewer said nothing', async () => {
    // Redraft with an empty box is a verdict on the draft, not a request to
    // keep it: handing back the same reply reworded is the failure.
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { draft: 'We have already refunded you in full.' }, db);

    await draftReply(getTask(task.id, db)!, { db });

    expect(prompts[0]!).toContain('Write a different attempt');
    expect(prompts[0]!).not.toContain('Revise this.');
  });

  it('says nothing about a previous reply on a first draft', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);

    await draftReply(task, { db });

    expect(prompts[0]!).not.toContain('The reply already on the table');
  });

  it('lets the caller suppress the note', async () => {
    // The backfill's case: an archived reply was not written in response to
    // anybody's review of a draft that did not exist.
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { reviewerNotes: 'shorter please' }, db);

    await draftReply(getTask(task.id, db)!, { db, steer: '' });

    expect(prompts[0]!).not.toContain('What the reviewer said');
  });

  it('asks the critic whether the note was actually honoured', async () => {
    queued.push(GOOD_DRAFT, JSON.stringify({ approved: true, issues: [] }));
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { reviewerNotes: 'Stop apologising twice.' }, db);

    await draftReply(getTask(task.id, db)!, { db, critic: true });

    const critic = prompts[1]!;
    expect(critic).toContain('Stop apologising twice');
    expect(critic).toContain('whether it actually did what the reviewer asked for');
    // And told not to undo it. The critic holds the same rulebook as the
    // drafter, so without this the second pass edited an honoured note back out
    // and the reviewer saw the rule win anyway — one pass later.
    expect(critic).toContain("The reviewer's instruction outranks the rules");
  });

  it('does not lecture the critic about precedence when there is no note', async () => {
    queued.push(GOOD_DRAFT, JSON.stringify({ approved: true, issues: [] }));
    const { task } = createTask(INCOMING, db);

    await draftReply(task, { db, critic: true });

    expect(prompts[1]!).not.toContain("The reviewer's instruction outranks");
  });

  it('survives a retry, because it is read off the task and not the payload', async () => {
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { reviewerNotes: 'Answer the second question too.' }, db);
    enqueueDraftReply(task.id, { critic: false, db });

    const worker = createWorker({
      handlers: { [DRAFT_REPLY]: draftReplyHandler },
      db,
      backoff: () => 0,
    });

    queued.push('not json at all');
    await worker.runOnce();
    queued.push(GOOD_DRAFT);
    await worker.runOnce();

    expect(prompts[1]!).toContain('Answer the second question too');
  });

  it('folds a redraft back into the option it was a rewrite of, and leaves the others alone', async () => {
    const { task } = createTask(INCOMING, db);
    replaceAlternatives(
      task.id,
      [
        { strategy: 'answer it now', body: 'The reply the reviewer just rejected.' },
        { strategy: 'refund now', body: 'Refunded in full.' },
      ],
      db,
    );
    // The box holds option A, which is what pressing Redraft on it means.
    updateTask(task.id, { draft: 'The reply the reviewer just rejected.' }, db);
    enqueueDraftReply(task.id, { critic: false, db });

    const worker = createWorker({
      handlers: { [DRAFT_REPLY]: draftReplyHandler },
      db,
      backoff: () => 0,
    });
    queued.push(GOOD_DRAFT);
    await worker.runOnce();

    const options = listAlternatives(task.id, db);
    expect(options.map(option => [option.label, option.body])).toEqual([
      ['A', 'We have escalated this and will update you shortly.'],
      ['B', 'Refunded in full.'],
    ]);
    // Its label stays with it, so the tab the reviewer was on is still the tab
    // they are on.
    expect(options[0]!.strategy).toBe('answer it now');
    // And no fresh set: they asked for one option changed, not for the other
    // two to be replaced by approaches they have not read.
    expect(isQueued(alternativesKey(task.id), db)).toBe(false);
  });

  it('adds the redraft as a further option when the reviewer had edited by hand', async () => {
    const { task } = createTask(INCOMING, db);
    replaceAlternatives(
      task.id,
      [
        { strategy: 'answer it now', body: 'As generated.' },
        { strategy: 'refund now', body: 'Refunded in full.' },
      ],
      db,
    );
    updateTask(task.id, { draft: 'Something I typed myself.' }, db);
    enqueueDraftReply(task.id, { critic: false, db });

    const worker = createWorker({
      handlers: { [DRAFT_REPLY]: draftReplyHandler },
      db,
      backoff: () => 0,
    });
    queued.push(GOOD_DRAFT);
    await worker.runOnce();

    const options = listAlternatives(task.id, db);
    expect(options.map(option => option.label)).toEqual(['A', 'B', 'C']);
    expect(options[2]!.body).toBe('We have escalated this and will update you shortly.');
    expect(options.map(option => option.body).slice(0, 2)).toEqual([
      'As generated.',
      'Refunded in full.',
    ]);
  });

  it('keeps the options when the drafting attempt fails, because the draft they match is still there', async () => {
    const { task } = createTask(INCOMING, db);
    replaceAlternatives(task.id, [{ strategy: 'what we said', body: 'Still in the box.' }], db);
    enqueueDraftReply(task.id, { critic: false, db });

    const worker = createWorker({
      handlers: { [DRAFT_REPLY]: draftReplyHandler },
      db,
      backoff: () => 0,
    });
    queued.push('not json at all');
    await worker.runOnce();

    expect(listAlternatives(task.id, db).map(option => option.body)).toEqual(['Still in the box.']);
  });
});

describe('conversation history in the prompt', () => {
  it('shows earlier messages and names which one is being answered', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);

    addMessage(
      task.id,
      {
        direction: 'inbound',
        messageId: 'm1',
        fromAddress: 'customer@example.com',
        body: 'My export finished but the file is silent.',
        receivedAt: '2026-07-29T09:00:00.000Z',
      },
      db,
    );
    addMessage(
      task.id,
      {
        direction: 'outbound',
        body: 'Sorry about that — we have issued a full refund today.',
        receivedAt: '2026-07-29T11:00:00.000Z',
      },
      db,
    );

    await draftReply(task, { db });

    const prompt = prompts[0]!;
    // Both sides of what was already said, in order, labelled.
    expect(prompt).toContain('[Customer]');
    expect(prompt).toContain('the file is silent');
    expect(prompt).toContain('[Support]');
    expect(prompt).toContain('we have issued a full refund today');
    expect(prompt.indexOf('the file is silent')).toBeLessThan(
      prompt.indexOf('we have issued a full refund today'),
    );

    // And the drafter is told which of the four messages in front of it is the
    // one to answer. Without this it answers whichever it finds most
    // interesting, which on a placated thread is the angry one.
    expect(prompt).toContain("The customer's latest message — this is what you are replying to");
    expect(prompt.indexOf('end of conversation history')).toBeLessThan(
      prompt.indexOf("The customer's latest message"),
    );
  });

  it('says nothing about a thread on a first contact', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);

    await draftReply(task, { db });

    const prompt = prompts[0]!;
    expect(prompt).not.toContain('This is a follow-up');
    expect(prompt).toContain("The customer's email");
  });

  it('tells the critic who the mail is from, so a greeting is not read as invented', async () => {
    queued.push(GOOD_DRAFT, JSON.stringify({ approved: true, issues: [] }));

    await draftReply(createTask(INCOMING, db).task, { db, critic: true });

    expect(prompts[1]).toContain('From: Alex Customer <customer@example.com>');
  });

  it('gives the critic the thread too, so it can catch a contradiction', async () => {
    queued.push(GOOD_DRAFT, JSON.stringify({ approved: true, issues: [] }));
    const { task } = createTask(INCOMING, db);
    addMessage(
      task.id,
      {
        direction: 'outbound',
        body: 'We have already refunded you in full.',
        receivedAt: '2026-07-29T11:00:00.000Z',
      },
      db,
    );

    await draftReply(task, { db, critic: true });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('We have already refunded you in full.');
    expect(prompts[1]).toContain('contradicts or repeats what we already said');
  });

  it('lets the caller force a first-contact prompt', async () => {
    // What the backfill needs: today's thread is not the conversation as it
    // stood when the archived reply was written.
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    addMessage(
      task.id,
      { direction: 'inbound', body: 'something from later', receivedAt: '2026-07-29T09:00:00.000Z' },
      db,
    );

    await draftReply(task, { db, thread: '' });

    expect(prompts[0]).not.toContain('something from later');
  });

  it('updates a message rather than duplicating it when a thread is re-read', async () => {
    const { task } = createTask(INCOMING, db);
    const first = addMessage(
      task.id,
      { direction: 'inbound', messageId: 'm1', body: 'draft body', receivedAt: '2026-07-29T09:00:00.000Z' },
      db,
    );
    const second = addMessage(
      task.id,
      { direction: 'inbound', messageId: 'm1', body: 'full body', receivedAt: '2026-07-29T09:00:00.000Z' },
      db,
    );

    expect(second.id).toBe(first.id);
    expect(countMessages(task.id, db)).toBe(1);
    expect(listMessages(task.id, db)[0]!.body).toBe('full body');
  });

  it('goes with the task when the task is deleted', () => {
    const { task } = createTask(INCOMING, db);
    addMessage(task.id, { direction: 'inbound', body: 'x', receivedAt: '2026-07-29T09:00:00.000Z' }, db);

    deleteTask(task.id, db);

    expect(countMessages(task.id, db)).toBe(0);
  });
});

describe('drafting', () => {
  it('analyses and drafts in one call', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);

    const result = await draftReply(task, { db });

    expect(prompts).toHaveLength(1);
    expect(result.draft).toBe('We have escalated this and will update you shortly.');
    expect(result.analysis.scope).toBe('refund');
    expect(result.analysis.sentiment).toBe('negative');
  });

  it('refuses a classification the vocabulary does not contain', async () => {
    // The failure this whole mechanism exists to stop. `refunds` is one
    // letter from the configured `refund`, looks entirely correct on the task
    // page, and routes the reply past every refund rule the desk has. Better
    // to have no topic — which falls back to the rules that apply to
    // everything — than a name nothing is filed under.
    writeConfig({ topics: [{ slug: 'refund', description: 'money back' }] });
    queued.push('refunds', GOOD_DRAFT);

    const result = await draftReply(createTask(INCOMING, db).task, { db });
    expect(result.analysis.scope).toBeUndefined();

    // And the vocabulary was actually offered, so this is the model
    // disobeying rather than the model never being told.
    expect(prompts[0]).toContain('- refund: money back');
  });

  it('routes the rules by the classification, before the draft exists', async () => {
    writeConfig({ topics: [{ slug: 'refund', description: 'money back' }] });
    const wanted = createRule({ content: 'Refunds take ten days.', topics: ['refund'] }, db);
    const other = createRule({ content: 'Never quote an API rate limit.', topics: ['api'] }, db);
    queued.push('refund', GOOD_DRAFT);

    const result = await draftReply(createTask(INCOMING, db).task, { db });

    expect(result.analysis.scope).toBe('refund');
    // The point of the whole exercise: a first draft, on a task that carried
    // no topic, written against the rules for what the mail is actually about.
    expect(result.appliedRuleIds).toContain(wanted.id);
    expect(result.appliedRuleIds).not.toContain(other.id);
    expect(prompts[1]).toContain('Refunds take ten days.');
    expect(prompts[1]).not.toContain('Never quote an API rate limit.');
  });

  it('does not pay to classify a task that already carries a topic', async () => {
    writeConfig({ topics: [{ slug: 'refund', description: 'money back' }] });
    const { task } = createTask(INCOMING, db);
    queued.push(GOOD_DRAFT);

    const result = await draftReply({ ...task, scope: 'refund' }, { db });

    expect(prompts).toHaveLength(1);
    expect(result.analysis.scope).toBe('refund');
  });

  it('drafts anyway when the classifier says nothing useful', async () => {
    writeConfig({ topics: [{ slug: 'refund', description: 'money back' }] });
    queued.push('none', GOOD_DRAFT);

    const result = await draftReply(createTask(INCOMING, db).task, { db });
    expect(result.analysis.scope).toBeUndefined();
    expect(result.draft).toBe('We have escalated this and will update you shortly.');
  });

  it('reads the rules the budget pushed out, instead of losing them', async () => {
    // Two rules that cannot both fit. The one that does not is offered back as
    // an index of summaries and read in full because this email needs it —
    // which is the difference between a rule that was dropped and a rule that
    // was chosen against.
    const kept = createRule({ content: `Kept: ${'x'.repeat(20_000)}`, category: 'product' }, db);
    const overflow = createRule(
      { content: 'Refunds take ten business days.', category: 'product' },
      db,
    );
    queued.push(JSON.stringify({ read: [overflow.id] }), GOOD_DRAFT);

    const result = await draftReply(createTask(INCOMING, db).task, { db });

    expect(result.appliedRuleIds).toEqual([kept.id, overflow.id]);
    expect(result.droppedRuleIds).toEqual([]);
    // The retrieval saw a summary index, and the drafter saw the full text.
    expect(prompts[0]).toContain(`[${overflow.id}]`);
    expect(prompts[1]).toContain('Refunds take ten business days.');
  });

  it('does not pay to retrieve anything when everything fits', async () => {
    createRule({ content: 'Refunds take ten business days.', category: 'product' }, db);
    queued.push(GOOD_DRAFT);

    await draftReply(createTask(INCOMING, db).task, { db });
    expect(prompts).toHaveLength(1);
  });

  it('accepts any slug when no vocabulary is configured', async () => {
    queued.push(JSON.stringify({ ...JSON.parse(GOOD_DRAFT), scope: 'Whatever It Wants' }));

    const result = await draftReply(createTask(INCOMING, db).task, { db });
    expect(result.analysis.scope).toBe('whatever-it-wants');
  });

  it('sends only the rules the mail is about, plus the ones about everything', async () => {
    writeConfig({ topics: [{ slug: 'refund', description: 'money back' }] });
    createRule({ content: 'Always sign off warmly.' }, db);
    createRule({ content: 'Never promise a refund date.', topics: ['refund'] }, db);
    createRule({ content: 'Quote the API rate limit exactly.', topics: ['api'] }, db);
    queued.push(GOOD_DRAFT);

    // The task already carries the topic, as a regeneration would.
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { scope: 'refund' }, db);
    const result = await draftReply(getTask(task.id, db)!, { db });

    expect(prompts[0]).toContain('Always sign off warmly.');
    expect(prompts[0]).toContain('Never promise a refund date.');
    expect(prompts[0]).not.toContain('Quote the API rate limit exactly.');
    expect(result.appliedRuleIds).toHaveLength(2);
  });

  it('strips HTML out of the email before it reaches the model', async () => {
    queued.push(GOOD_DRAFT);
    await draftReply(createTask(INCOMING, db).task, { db });

    expect(prompts[0]).not.toContain('<p>');
    expect(prompts[0]).toContain('refund was on its way');
  });

  it('puts the persona and the enabled rules into the prompt', async () => {
    writeConfig({ organization: 'Acme', facts: ['Refunds take 5-10 business days.'] });
    createRule({ content: 'Never promise a refund date.', category: 'policy' }, db);
    createRule({ content: 'Disabled rule.', category: 'tone' }, db);
    const rules = listRules({}, db);
    db.prepare('UPDATE rules SET enabled = 0 WHERE id = ?').run(rules[1]!.id);

    queued.push(GOOD_DRAFT);
    await draftReply(createTask(INCOMING, db).task, { db });

    expect(prompts[0]).toContain('Acme');
    expect(prompts[0]).toContain('Refunds take 5-10 business days.');
    expect(prompts[0]).toContain('Never promise a refund date.');
    expect(prompts[0]).not.toContain('Disabled rule.');
  });

  it('counts a rule as applied only once a draft exists', async () => {
    createRule({ content: 'Never promise a refund date.', category: 'policy' }, db);

    queued.push('not json at all');
    await expect(draftReply(createTask(INCOMING, db).task, { db })).rejects.toThrow(/no usable draft/);
    expect(listRules({}, db)[0]?.appliedCount).toBe(0);

    queued.push(GOOD_DRAFT);
    await draftReply(createTask({ subject: 'second' }, db).task, { db });
    expect(listRules({}, db)[0]?.appliedCount).toBe(1);
  });

  it('appends the configured signature', async () => {
    writeConfig({ signature: '— The Acme team' });
    queued.push(GOOD_DRAFT);

    const result = await draftReply(createTask(INCOMING, db).task, { db });
    expect(result.draft.endsWith('— The Acme team')).toBe(true);
  });

  it('rejects a response with no draft in it', async () => {
    queued.push(JSON.stringify({ intent: 'something', draft: '   ' }));
    await expect(draftReply(createTask(INCOMING, db).task, { db })).rejects.toThrow(/no usable draft/);
  });

  it('falls back to neutral rather than storing a sentiment nobody defined', async () => {
    queued.push(JSON.stringify({ draft: 'Hello.', sentiment: 'incandescent' }));
    const result = await draftReply(createTask(INCOMING, db).task, { db });
    expect(result.analysis.sentiment).toBe('neutral');
  });

  it('records where the fault most likely lies', async () => {
    queued.push(JSON.stringify({ draft: 'We are looking into it.', cause: 'system_bug' }));

    const result = await draftReply(createTask(INCOMING, db).task, { db });
    expect(result.analysis.cause).toBe('system_bug');
  });

  it('asks for our bug before theirs', async () => {
    // The order in the prompt is the whole feature. A desk that reaches for
    // user error first is a desk where real bugs go unreported for weeks.
    queued.push(GOOD_DRAFT);
    await draftReply(createTask(INCOMING, db).task, { db });

    const prompt = prompts[0] ?? '';
    expect(prompt.indexOf('our bug')).toBeGreaterThan(-1);
    expect(prompt.indexOf('our bug')).toBeLessThan(prompt.indexOf('something they did'));
  });

  it('stores no cause when the drafter invents one', async () => {
    queued.push(JSON.stringify({ draft: 'Hello.', cause: 'act_of_god' }));

    const result = await draftReply(createTask(INCOMING, db).task, { db });
    expect(result.analysis.cause).toBeUndefined();
  });

  it('takes the critic’s rewrite when the critic rejects the draft', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['Promises a date'], revised: 'A safer reply.' }));

    const result = await draftReply(createTask(INCOMING, db).task, { critic: true, db });

    expect(prompts).toHaveLength(2);
    expect(result.critique?.approved).toBe(false);
    expect(result.draft).toBe('A safer reply.');
  });

  it('hands back the draft the rewrite replaced, so the swap is not silent', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['Promises a date'], revised: 'A safer reply.' }));

    const result = await draftReply(createTask(INCOMING, db).task, { critic: true, db });

    expect(result.critique?.rewritten).toBe(true);
    expect(result.supersededDraft).toBe('We have escalated this and will update you shortly.');
  });

  it('is not a rewrite when the critic refuses without offering one', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['Promises a date'] }));

    const result = await draftReply(createTask(INCOMING, db).task, { critic: true, db });

    // The dangerous state, and the one the screen has to word differently:
    // nothing was fixed, and the text below the verdict is the text it objected to.
    expect(result.critique?.rewritten).toBe(false);
    expect(result.supersededDraft).toBeUndefined();
    expect(result.draft).toBe('We have escalated this and will update you shortly.');
  });

  it('asks for the objections in the language the desk is read in', async () => {
    process.env.AAS_LANGUAGE = 'zh-CN';
    resetWorkspaceConfig();
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['承诺了具体日期'], revised: 'A safer reply.' }));

    await draftReply(createTask(INCOMING, db).task, { critic: true, db });

    // The verdict card is the one place on the review screen that says why a
    // second model would not sign the draft off, and it arrived in English on
    // a desk where every other word had been translated. The drafter has been
    // told this about `intent` and `keyPoints` since there was a drafter; the
    // critic never was.
    expect(prompts[1]).toContain('issues in Simplified Chinese');
    expect(prompts[1]).toContain('in Simplified Chinese; empty when approved');
    // And the rewrite is not a translation: it is the reply, and it goes to
    // the customer in the language they wrote in.
    expect(prompts[1]).toContain('in the language of the draft');
  });

  it('ignores a rewrite that arrives with an approval', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: true, issues: [], revised: 'Gratuitous rephrasing.' }));

    const result = await draftReply(createTask(INCOMING, db).task, { critic: true, db });
    expect(result.draft).toBe('We have escalated this and will update you shortly.');
  });

  it('keeps the draft when the critic pass itself fails', async () => {
    queued.push(GOOD_DRAFT);
    queued.push('nonsense that is not json');

    const result = await draftReply(createTask(INCOMING, db).task, { critic: true, db });
    expect(result.critique).toBeUndefined();
    expect(result.draft).toBe('We have escalated this and will update you shortly.');
  });
});

describe('draft-reply job', () => {
  function worker() {
    return createWorker({ handlers: { [DRAFT_REPLY]: draftReplyHandler }, db, backoff: () => 0 });
  }

  it('takes a task from pending to awaiting review', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    enqueueDraftReply(task.id, { critic: false, db });

    const outcome = await worker().runOnce();
    expect(outcome?.status).toBe('completed');

    const updated = getTask(task.id, db);
    expect(updated?.status).toBe('awaiting_review');
    expect(updated?.draft).toBe('We have escalated this and will update you shortly.');
    expect(updated?.scope).toBe('refund');
    expect(updated?.error).toBeNull();
  });

  it('makes a redrafted task unread again', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    // Somebody read the first draft, did not like it, and asked for another.
    updateTask(task.id, { status: 'awaiting_review', draft: 'The old one' }, db);
    markOpened(task.id, db);

    enqueueDraftReply(task.id, { critic: false, db });
    await worker().runOnce();

    // Leaving it read would leave new text sitting under a row that looks
    // dealt with, which is how a redraft goes out unexamined.
    expect(getTask(task.id, db)?.openedAt).toBeNull();
  });

  it('keeps the draft it replaced, with the note that replaced it', async () => {
    queued.push(GOOD_DRAFT);
    const { task } = createTask(INCOMING, db);
    updateTask(
      task.id,
      { status: 'awaiting_review', draft: 'The old one', reviewerNotes: 'make it shorter' },
      db,
    );

    enqueueDraftReply(task.id, { critic: false, db });
    await worker().runOnce();

    // Redraft is the button that used to destroy ten minutes of somebody's
    // editing without looking like it could.
    expect(listVersions(task.id, db)).toMatchObject([
      { body: 'We have escalated this and will update you shortly.', notes: 'make it shorter' },
    ]);
  });

  it('keeps what the second opinion objected to, not only that it objected', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(
      JSON.stringify({
        approved: false,
        issues: ['Quotes a price that is not in the catalogue'],
        revised: 'A safer reply.',
      }),
    );
    const { task } = createTask(INCOMING, db);
    enqueueDraftReply(task.id, { db });

    await worker().runOnce();

    const updated = getTask(task.id, db);
    expect(updated?.draft).toBe('A safer reply.');
    // The reasons are the part a reviewer can act on. Until this was stored
    // they existed for the length of one function call and were then dropped,
    // leaving the grade to say "a second model disagreed" and nothing else.
    expect(updated?.critique).toEqual({
      approved: false,
      issues: ['Quotes a price that is not in the catalogue'],
      rewritten: true,
    });
    expect(updated?.risk?.factors).toContain('criticRejected');
  });

  it('does not keep a second copy of the rewrite on the row', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['Promises a date'], revised: 'A safer reply.' }));
    const { task } = createTask(INCOMING, db);
    enqueueDraftReply(task.id, { db });

    await worker().runOnce();

    // The rewrite is the draft. A copy of it on this column would go stale the
    // first time anybody edited the reply, and it would be the copy some later
    // screen read.
    const row = db.prepare('SELECT critique FROM tasks WHERE id = ?').get(task.id) as {
      critique: string;
    };
    expect(row.critique).not.toContain('A safer reply.');
  });

  it('keeps the draft the second opinion replaced, marked as its own kind', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['Promises a date'], revised: 'A safer reply.' }));
    const { task } = createTask(INCOMING, db);
    enqueueDraftReply(task.id, { db });

    await worker().runOnce();

    // Newest first. The rewrite is what is in the box, and under it the text it
    // replaced — which was, until this, the one edit on the desk that left no
    // trace at all.
    expect(listVersions(task.id, db)).toMatchObject([
      { body: 'A safer reply.', source: 'model' },
      { body: 'We have escalated this and will update you shortly.', source: 'critic' },
    ]);
  });

  it('clears the previous verdict when the new draft has none', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['Promises a date'], revised: 'A safer reply.' }));
    const { task } = createTask(INCOMING, db);
    enqueueDraftReply(task.id, { db });
    await worker().runOnce();
    expect(getTask(task.id, db)?.critique).not.toBeNull();

    // A redraft with the critic switched off. Carrying the old objections over
    // would put them beside a reply they were never made about.
    queued.push(GOOD_DRAFT);
    enqueueDraftReply(task.id, { critic: false, db });
    await worker().runOnce();

    expect(getTask(task.id, db)?.critique).toBeNull();
  });

  it('queues the other ways it could have answered, without being asked', async () => {
    const { task } = createTask(INCOMING, db);
    enqueueDraftReply(task.id, { critic: false, db });

    queued.push(GOOD_DRAFT);
    await worker().runOnce();

    // These were behind a button, and the button was indistinguishable from a
    // broken one: two and a half minutes on a page with no client-side
    // JavaScript to notice the answer arriving.
    const options = listJobs({ type: SUGGEST_ALTERNATIVES }, db);
    expect(options).toHaveLength(1);
    expect(options[0]!.payload).toEqual({ taskId: task.id });
    // Behind drafting, not in front of it as it was while somebody was waiting
    // on the page for it. Now it runs for every mail, and jumping the queue
    // would leave unanswered mail waiting on extra replies to answered mail.
    expect(options[0]!.priority).toBeGreaterThan(5);
  });

  it('drafts one reply per task however many times it is enqueued', () => {
    const { task } = createTask(INCOMING, db);
    enqueueDraftReply(task.id, { db });
    const second = enqueueDraftReply(task.id, { db });

    expect(second.deduped).toBe(true);
    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(1);
  });

  it('does not overwrite a reply that has already gone out', async () => {
    const { task } = createTask(INCOMING, db);
    updateTask(task.id, { status: 'sent', finalReply: 'what the human actually sent' }, db);
    enqueueDraftReply(task.id, { db });

    const outcome = await worker().runOnce();
    expect(outcome?.result).toEqual({ skipped: 'sent' });
    expect(prompts).toHaveLength(0);
    expect(getTask(task.id, db)?.finalReply).toBe('what the human actually sent');
  });

  it('does not retry a task that no longer exists', async () => {
    enqueue(DRAFT_REPLY, { payload: { taskId: 'gone' }, maxAttempts: 5 }, db);

    const outcome = await worker().runOnce();
    expect(outcome?.status).toBe('failed');
    expect(outcome?.job.attempts).toBe(1);
  });

  it('leaves the task pending while retries remain, and fails it at the end', async () => {
    const { task } = createTask(INCOMING, db);
    enqueue(DRAFT_REPLY, { payload: { taskId: task.id, critic: false }, maxAttempts: 2 }, db);
    queued.push('not json', 'not json either');

    const w = worker();
    expect((await w.runOnce())?.status).toBe('retrying');
    // Not 'failed' yet: a routine 429 should not paint the row red for the
    // thirty seconds before the retry.
    expect(getTask(task.id, db)?.status).toBe('pending');

    expect((await w.runOnce())?.status).toBe('failed');
    const failed = getTask(task.id, db);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/no usable draft/);
  });
});
