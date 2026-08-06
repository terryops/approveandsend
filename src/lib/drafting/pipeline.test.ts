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
  type WorkspaceConfig,
} from '../config/workspace';
import { openDb, type Db } from '../db';
import { enqueueDraftReply, DRAFT_REPLY, draftReplyHandler } from '../queue/handlers';
import { enqueue, listJobs } from '../queue/store';
import { createWorker } from '../queue/worker';
import { createRule, listRules } from '../rules/store';
import { countTasksByStatus, createTask, deleteTask, getTask, listTasks, updateTask } from '../tasks/store';
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
      voice: 'Terse.',
      facts: ['Refunds take 5-10 business days.'],
      signature: '',
      replyLanguage: 'match',
      reviewLanguage: '',
    language: 'en',
      topics: [],
      neverPromise: ['a refund date'],
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

    expect(countTasksByStatus(db)).toEqual({ pending: 1, sent: 1 });
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

  it('takes the critic’s rewrite when the critic rejects the draft', async () => {
    queued.push(GOOD_DRAFT);
    queued.push(JSON.stringify({ approved: false, issues: ['Promises a date'], revised: 'A safer reply.' }));

    const result = await draftReply(createTask(INCOMING, db).task, { critic: true, db });

    expect(prompts).toHaveLength(2);
    expect(result.critique?.approved).toBe(false);
    expect(result.draft).toBe('A safer reply.');
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
