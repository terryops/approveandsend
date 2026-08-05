import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { openDb, type Db } from '../db';
import { listRules } from '../rules/store';
import { DEFAULT_HANDLERS, enqueueLearnFromSent, LEARN_FROM_SENT } from './handlers/learn-from-sent';
import {
  backoffMs,
  claimNext,
  cleanupJobs,
  completeJob,
  deleteJob,
  enqueue,
  failJob,
  getJob,
  listJobs,
  queueStats,
  retryJob,
} from './store';
import { PermanentJobError, type JobHandler } from './types';
import { createWorker } from './worker';

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

beforeEach(async () => {
  db = openDb(':memory:');
  queued.length = 0;
  prompts.length = 0;
  await startAi();
});

afterEach(async () => {
  db.close();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  resetAiConfig();
});

/** A worker that retries immediately, so tests do not sleep. */
function worker(handlers: Record<string, JobHandler>, options: { leaseMs?: number } = {}) {
  return createWorker({ handlers, db, backoff: () => 0, ...options });
}

describe('enqueue', () => {
  it('stores the payload as given', () => {
    const { job } = enqueue('demo', { payload: { a: 1, nested: { b: 'two' } } }, db);
    expect(job.status).toBe('pending');
    expect(job.payload).toEqual({ a: 1, nested: { b: 'two' } });
    expect(job.attempts).toBe(0);
  });

  it('defaults to an empty payload rather than null', () => {
    const { job } = enqueue('demo', {}, db);
    expect(job.payload).toEqual({});
  });

  it('collapses a repeated dedupe key while the job is unfinished', () => {
    const first = enqueue('demo', { dedupeKey: 'task-1' }, db);
    const second = enqueue('demo', { dedupeKey: 'task-1' }, db);

    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(listJobs({}, db)).toHaveLength(1);
  });

  it('allows the same key again once the first job has finished', () => {
    const first = enqueue('demo', { dedupeKey: 'task-1' }, db);
    completeJob(first.job.id, null, db);

    const second = enqueue('demo', { dedupeKey: 'task-1' }, db);
    expect(second.deduped).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it('does not dedupe jobs without a key', () => {
    enqueue('demo', {}, db);
    enqueue('demo', {}, db);
    expect(listJobs({}, db)).toHaveLength(2);
  });

  it('holds a delayed job back until its time', () => {
    enqueue('demo', { delayMs: 60_000 }, db);
    expect(claimNext({}, db)).toBeNull();
  });
});

describe('claimNext', () => {
  it('returns null on an empty queue', () => {
    expect(claimNext({}, db)).toBeNull();
  });

  it('increments attempts at claim time, not at failure time', () => {
    const { job } = enqueue('demo', {}, db);
    const claimed = claimNext({}, db);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.attempts).toBe(1);
  });

  it('hands the same job to only one caller', () => {
    enqueue('demo', {}, db);
    expect(claimNext({}, db)).not.toBeNull();
    expect(claimNext({}, db)).toBeNull();
  });

  it('runs lower priority numbers first', () => {
    enqueue('demo', { priority: 9, payload: { tag: 'low' } }, db);
    enqueue('demo', { priority: 1, payload: { tag: 'high' } }, db);

    expect(claimNext({}, db)?.payload).toEqual({ tag: 'high' });
    expect(claimNext({}, db)?.payload).toEqual({ tag: 'low' });
  });

  it('breaks ties by insertion order', () => {
    enqueue('demo', { payload: { tag: 'first' } }, db);
    enqueue('demo', { payload: { tag: 'second' } }, db);

    expect(claimNext({}, db)?.payload).toEqual({ tag: 'first' });
    expect(claimNext({}, db)?.payload).toEqual({ tag: 'second' });
  });

  it('can be restricted to one type', () => {
    enqueue('other', {}, db);
    enqueue('demo', { payload: { tag: 'wanted' } }, db);

    expect(claimNext({ type: 'demo' }, db)?.payload).toEqual({ tag: 'wanted' });
    expect(claimNext({ type: 'demo' }, db)).toBeNull();
  });

  it('reclaims a job whose worker died, without a separate sweeper', () => {
    enqueue('demo', {}, db);
    const first = claimNext({ leaseMs: -1 }, db); // Already expired: the worker crashed.
    expect(first).not.toBeNull();

    const second = claimNext({}, db);
    expect(second?.id).toBe(first?.id);
    // The dead attempt counted. Otherwise a job that hangs the worker is an
    // infinite loop with an LLM call in it.
    expect(second?.attempts).toBe(2);
  });

  it('fails a job that keeps outliving its lease instead of retrying forever', () => {
    enqueue('demo', { maxAttempts: 2 }, db);
    expect(claimNext({ leaseMs: -1 }, db)).not.toBeNull();
    expect(claimNext({ leaseMs: -1 }, db)).not.toBeNull();

    expect(claimNext({}, db)).toBeNull();
    expect(listJobs({}, db)[0]?.status).toBe('failed');
  });
});

describe('failJob', () => {
  it('returns the job to pending while attempts remain', () => {
    const { job } = enqueue('demo', { maxAttempts: 3 }, db);
    claimNext({}, db);

    const failed = failJob(job.id, 'connection reset', {}, db);
    expect(failed?.status).toBe('pending');
    expect(failed?.error).toBe('connection reset');
    expect(failed?.attempts).toBe(1);
  });

  it('marks it failed once attempts are spent', () => {
    const { job } = enqueue('demo', { maxAttempts: 1 }, db);
    claimNext({}, db);

    expect(failJob(job.id, 'nope', {}, db)?.status).toBe('failed');
  });

  it('skips the remaining attempts when the failure is permanent', () => {
    const { job } = enqueue('demo', { maxAttempts: 5 }, db);
    claimNext({}, db);

    const failed = failJob(job.id, 'bad payload', { permanent: true }, db);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(1);
  });

  it('delays the retry by the requested backoff', () => {
    const { job } = enqueue('demo', {}, db);
    claimNext({}, db);
    failJob(job.id, 'later', { retryDelayMs: 60_000 }, db);

    expect(claimNext({}, db)).toBeNull();
  });

  it('is a no-op for an unknown id', () => {
    expect(failJob('nope', 'x', {}, db)).toBeNull();
  });
});

describe('backoffMs', () => {
  it('grows exponentially', () => {
    expect(backoffMs(1, false)).toBe(30_000);
    expect(backoffMs(2, false)).toBe(60_000);
    expect(backoffMs(3, false)).toBe(120_000);
  });

  it('caps at ten minutes', () => {
    expect(backoffMs(20, false)).toBe(600_000);
  });

  it('jitters within ±20%, so a batch failing together does not retry in lockstep', () => {
    const values = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const value = backoffMs(1);
      expect(value).toBeGreaterThanOrEqual(24_000);
      expect(value).toBeLessThanOrEqual(36_000);
      values.add(value);
    }
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('worker', () => {
  it('returns null when there is nothing to do', async () => {
    expect(await worker({}).runOnce()).toBeNull();
  });

  it('runs the handler and records its return value', async () => {
    enqueue('demo', { payload: { n: 2 } }, db);

    const outcome = await worker({
      demo: async payload => ({ doubled: (payload as { n: number }).n * 2 }),
    }).runOnce();

    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toEqual({ doubled: 4 });
    expect(getJob(outcome!.job.id, db)?.result).toBe('{"doubled":4}');
  });

  it('clears a stale error when a retry succeeds', async () => {
    const { job } = enqueue('demo', { maxAttempts: 3 }, db);
    let calls = 0;

    const w = worker({
      demo: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return 'ok';
      },
    });

    expect((await w.runOnce())?.status).toBe('retrying');
    expect((await w.runOnce())?.status).toBe('completed');
    expect(getJob(job.id, db)?.error).toBeNull();
  });

  it('gives up after max attempts', async () => {
    enqueue('demo', { maxAttempts: 2 }, db);
    const w = worker({ demo: async () => { throw new Error('always'); } });

    expect((await w.runOnce())?.status).toBe('retrying');
    expect((await w.runOnce())?.status).toBe('failed');
    expect(await w.runOnce()).toBeNull();
  });

  it('does not retry a PermanentJobError', async () => {
    enqueue('demo', { maxAttempts: 5 }, db);
    const outcome = await worker({
      demo: async () => { throw new PermanentJobError('payload is nonsense'); },
    }).runOnce();

    expect(outcome?.status).toBe('failed');
    expect(outcome?.job.attempts).toBe(1);
  });

  it('fails an unhandled job type permanently rather than blocking the queue', async () => {
    enqueue('mystery', { maxAttempts: 5 }, db);
    enqueue('demo', {}, db);

    const w = worker({ demo: async () => 'ran' });
    const first = await w.runOnce();
    expect(first?.status).toBe('failed');
    expect(first?.error).toMatch(/No handler registered/);

    expect((await w.runOnce())?.result).toBe('ran');
  });

  it('drains the queue and stops when it is empty', async () => {
    for (let i = 0; i < 3; i += 1) enqueue('demo', { payload: { i } }, db);

    const outcomes = await worker({ demo: async payload => payload }).drain();
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every(o => o.status === 'completed')).toBe(true);
  });

  it('honours the drain limit', async () => {
    for (let i = 0; i < 5; i += 1) enqueue('demo', {}, db);
    expect(await worker({ demo: async () => null }).drain(2)).toHaveLength(2);
  });

  it('emits events for completion, retry and failure', async () => {
    const kinds: string[] = [];
    const w = createWorker({
      db,
      backoff: () => 0,
      handlers: {
        good: async () => 'ok',
        bad: async () => { throw new Error('no'); },
      },
      onEvent: event => kinds.push(event.kind),
    });

    enqueue('good', {}, db);
    enqueue('bad', { maxAttempts: 2 }, db);
    await w.drain();

    expect(kinds).toEqual(['completed', 'retrying', 'failed']);
  });

  it('gives the handler the same database connection the worker uses', async () => {
    enqueue('demo', {}, db);
    let seen: unknown;
    await worker({ demo: async (_payload, ctx) => { seen = ctx.db; return null; } }).runOnce();
    expect(seen).toBe(db);
  });
});

describe('inspection and cleanup', () => {
  it('counts jobs by status', async () => {
    // The one-attempt job is enqueued first, so it is the one the worker
    // claims and the one that ends up failed.
    enqueue('demo', { maxAttempts: 1 }, db);
    enqueue('demo', {}, db);
    await worker({ demo: async () => { throw new Error('x'); } }).runOnce();

    const stats = queueStats('demo', db);
    expect(stats.total).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(1);
  });

  it('filters the job list', () => {
    enqueue('a', {}, db);
    enqueue('b', {}, db);
    expect(listJobs({ type: 'a' }, db)).toHaveLength(1);
    expect(listJobs({ status: 'pending' }, db)).toHaveLength(2);
    expect(listJobs({ status: 'completed' }, db)).toHaveLength(0);
  });

  it('requeues a failed job with a fresh attempt budget', () => {
    const { job } = enqueue('demo', { maxAttempts: 1 }, db);
    claimNext({}, db);
    failJob(job.id, 'boom', {}, db);

    const retried = retryJob(job.id, db);
    expect(retried?.status).toBe('pending');
    expect(retried?.attempts).toBe(0);
    expect(retried?.error).toBeNull();
    expect(claimNext({}, db)?.id).toBe(job.id);
  });

  it('will not requeue a job that has not failed', () => {
    const { job } = enqueue('demo', {}, db);
    expect(retryJob(job.id, db)).toBeNull();
  });

  it('deletes finished jobs past the retention window, and leaves live ones', () => {
    const { job } = enqueue('demo', {}, db);
    completeJob(job.id, null, db);
    db.prepare("UPDATE jobs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(job.id);
    enqueue('demo', {}, db);

    expect(cleanupJobs(24, db)).toBe(1);
    expect(listJobs({}, db)).toHaveLength(1);
  });

  it('deletes by id', () => {
    const { job } = enqueue('demo', {}, db);
    expect(deleteJob(job.id, db)).toBe(true);
    expect(deleteJob(job.id, db)).toBe(false);
  });

  it('survives a payload that is not valid JSON', () => {
    const { job } = enqueue('demo', {}, db);
    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run('{not json', job.id);
    expect(getJob(job.id, db)?.payload).toEqual({});
  });
});

describe('learn-from-sent', () => {
  const approval = {
    taskId: 'task-99',
    incomingSubject: 'Where is my refund?',
    incomingBody: 'I was told three days ago that a refund was coming.',
    originalDraft: "I'm so sorry. Your refund will arrive within 3 days.",
    sentReply: "We've escalated this and will update you shortly.",
  };

  it('turns an approval into rules, off the request path', async () => {
    queued.push(
      JSON.stringify({
        newRules: [
          {
            content: 'Never commit to a refund date that has not been confirmed.',
            category: 'policy',
            rationale: 'The human removed the promised timeframe.',
          },
        ],
      }),
    );

    enqueueLearnFromSent(approval, { db });
    const outcome = await worker(DEFAULT_HANDLERS).runOnce();

    expect(outcome?.status).toBe('completed');

    const rules = listRules({}, db);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.content).toMatch(/refund date/);
    expect(rules[0]?.category).toBe('policy');
    // Provenance: the whole point of recording which conversation taught it.
    expect(rules[0]?.sourceTaskId).toBe('task-99');
  });

  it('learns once when Approve is clicked twice', () => {
    const first = enqueueLearnFromSent(approval, { db });
    const second = enqueueLearnFromSent(approval, { db });

    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('treats a second, different revision as a separate lesson', () => {
    enqueueLearnFromSent(approval, { db });
    const revised = enqueueLearnFromSent({ ...approval, sentReply: 'Different text entirely.' }, { db });

    expect(revised.deduped).toBe(false);
    expect(listJobs({ type: LEARN_FROM_SENT }, db)).toHaveLength(2);
  });

  it('rejects a payload with no sent reply without spending an LLM call', async () => {
    enqueue(LEARN_FROM_SENT, { payload: { taskId: 'x' }, maxAttempts: 5 }, db);

    const outcome = await worker(DEFAULT_HANDLERS).runOnce();
    expect(outcome?.status).toBe('failed');
    expect(outcome?.job.attempts).toBe(1);
    expect(prompts).toHaveLength(0);
  });

  it('runs behind work a human is waiting on', () => {
    enqueue('interactive', { priority: 1 }, db);
    enqueueLearnFromSent(approval, { db });

    expect(claimNext({}, db)?.type).toBe('interactive');
    expect(claimNext({}, db)?.type).toBe(LEARN_FROM_SENT);
  });

  it('retries a learning job that fails on a transient error', async () => {
    server?.close();
    server = undefined;

    enqueueLearnFromSent(approval, { db });
    const w = worker(DEFAULT_HANDLERS);

    // learnFromSentReply swallows its own failures so that a send never looks
    // broken; the job therefore completes with nothing learned rather than
    // retrying. Losing the lesson is the cost of never losing the mail.
    const outcome = await w.runOnce();
    expect(outcome?.status).toBe('completed');
    expect(listRules({}, db)).toHaveLength(0);
  });
});
