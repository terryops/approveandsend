import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { DEFAULT_WORKSPACE } from '../config/workspace';
import { openDb, type Db } from '../db';
import { DRAFT_REPLY, ENRICH_CONTEXT, TRIAGE, triageHandler } from '../queue/handlers';
import { listJobs } from '../queue/store';
import { createTask, getTask } from '../tasks/store';
import type { Task } from '../tasks/types';
import { triage } from './triage';

// The same shape of fake AI the pipeline tests use: a real server, so the
// HTTP client and its parsing are exercised rather than stubbed past.
let server: Server | undefined;
const queued: string[] = [];

async function startAi(): Promise<void> {
  server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const content = queued.shift() ?? 'REPLY';
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
  await startAi();
});

afterEach(async () => {
  db.close();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  resetAiConfig();
});

function pitch(): Task {
  const { task } = createTask(
    {
      subject: 'Premium Guest Post Sites to Boost Your Google Rank',
      fromAddress: 'seo@example.com',
      body: 'We have high DA sites available for guest posting.',
    },
    db,
  );
  return task;
}

describe('triage', () => {
  it('reads a verdict and its reason', async () => {
    queued.push('IGNORE: guest-post backlink pitch');

    expect(await triage(pitch(), DEFAULT_WORKSPACE)).toEqual({
      ignore: true,
      reason: 'guest-post backlink pitch',
    });
  });

  it('always has a reason, because the archive row is the only explanation', async () => {
    queued.push('IGNORE');

    expect((await triage(pitch(), DEFAULT_WORKSPACE)).reason).not.toBe('');
  });

  it('does not read a refusal to ignore as an instruction to ignore', async () => {
    // A substring match on "IGNORE" dismissed the mail this was written about.
    queued.push('This is not something to IGNORE. REPLY');

    expect((await triage(pitch(), DEFAULT_WORKSPACE)).ignore).toBe(false);
  });

  it('drafts anyway when the call fails', async () => {
    // The asymmetry the whole step is built around: an unavailable triage
    // costs a wasted draft, and must never cost a customer their reply.
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;

    expect((await triage(pitch(), DEFAULT_WORKSPACE)).ignore).toBe(false);
  });
});

describe('triageHandler', () => {
  const context = () => ({ db, job: { id: 'j1', attempts: 1 } }) as never;

  it('dismisses a pitch with its reason, and queues nothing after it', async () => {
    const task = pitch();
    queued.push('IGNORE: cold sales outreach');

    await triageHandler({ taskId: task.id }, context());

    const after = getTask(task.id, db);
    expect(after?.status).toBe('dismissed');
    expect(after?.rejectionReason).toBe('cold sales outreach');
    const kinds = listJobs({}, db).map(job => job.type);
    expect(kinds).not.toContain(DRAFT_REPLY);
    expect(kinds).not.toContain(ENRICH_CONTEXT);
  });

  it('does not teach the rulebook from a machine decision', async () => {
    // `rejectTask` learns from a dismissal with a reason and a draft. These
    // have a reason and no draft, and a rulebook that learned "reply like
    // this to spam" from them would be worse than one that learned nothing.
    const task = pitch();
    queued.push('IGNORE: newsletter');

    await triageHandler({ taskId: task.id }, context());

    expect(listJobs({}, db).map(job => job.type)).not.toContain('learn-from-rejection');
  });

  it('sends a real email on to be drafted', async () => {
    const { task } = createTask(
      { subject: 'Where is my refund?', fromAddress: 'customer@example.com' },
      db,
    );
    queued.push('REPLY');

    await triageHandler({ taskId: task.id }, context());

    expect(getTask(task.id, db)?.status).not.toBe('dismissed');
    // Either half of the chain, depending on whether this install looks the
    // sender up — what matters is that the task did not stop here.
    const kinds = listJobs({}, db).map(job => job.type);
    expect(kinds.includes(DRAFT_REPLY) || kinds.includes(ENRICH_CONTEXT)).toBe(true);
  });

  it('leaves a task somebody already dealt with alone', async () => {
    const task = pitch();
    queued.push('IGNORE: spam');

    await triageHandler({ taskId: task.id }, context());
    const first = getTask(task.id, db)?.updatedAt;

    // Nothing queued, so a second run would reach the fake's default REPLY
    // and undo the dismissal if the guard were not there.
    await triageHandler({ taskId: task.id }, context());

    expect(getTask(task.id, db)?.status).toBe('dismissed');
    expect(getTask(task.id, db)?.updatedAt).toBe(first);
  });

  it('names the job so a reviewer can find what was thrown away', async () => {
    expect(TRIAGE).toBe('triage');
  });
});
