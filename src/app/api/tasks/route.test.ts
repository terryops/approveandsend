import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A route handler called outside a Next request has no cookie jar, and asking
// for one throws. An empty jar is the honest stand-in: a machine caller does
// not have a session, which is the whole reason it carries a token.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

// `after` outside a request is a no-op here on purpose. What it schedules is a
// turn of the queue, and a turn of the queue is a model call — the enqueued job
// is what these tests are about, not what the drafter does with it.
vi.mock('next/server', () => ({ after: () => {} }));

import { openDb, setDb, type Db } from '@/lib/db';
import { COMPOSE_MESSAGE } from '@/lib/queue/handlers';
import { listJobs } from '@/lib/queue/store';
import { getTask, listTasks } from '@/lib/tasks/store';

import { POST } from './route';

let db: Db;

const TOKEN = 'machine-token-for-tests';

function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  return POST(
    new Request('http://localhost/api/tasks', {
      method: 'POST',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const REVIEW = {
  to: 'customer@example.com',
  name: 'Sam',
  subject: 'About your review',
  brief: 'They left two stars saying the export was silent. Apologise and offer to look at the file.',
  externalId: 'review:8412',
  source: 'store-reviews',
};

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  process.env.CRON_TOKEN = TOKEN;
  // Without this the install is unprotected, and an unprotected install lets
  // everything through by design — including these tests, which would then
  // pass while asserting nothing.
  process.env.ADMIN_PASSWORD = 'not-the-machine-token';
});

afterEach(() => {
  setDb(null);
  db.close();
  delete process.env.CRON_TOKEN;
  delete process.env.ADMIN_PASSWORD;
});

describe('POST /api/tasks', () => {
  it('refuses a caller with no token', async () => {
    const response = await post(REVIEW, null);

    expect(response.status).toBe(401);
    expect(listTasks({}, db)).toHaveLength(0);
  });

  it('refuses the wrong token', async () => {
    expect((await post(REVIEW, 'not-the-token')).status).toBe(401);
    expect(listTasks({}, db)).toHaveLength(0);
  });

  it('makes a composed task and queues the mail', async () => {
    const response = await post(REVIEW);
    const payload = (await response.json()) as { taskId: string; existed: boolean };

    expect(response.status).toBe(201);
    expect(payload.existed).toBe(false);

    const task = getTask(payload.taskId, db);
    expect(task?.origin).toBe('composed');
    // The brief goes where a customer's letter would be, which is what the
    // compose job reads. From here on nothing downstream can tell the two apart.
    expect(task?.body).toContain('two stars');
    expect(task?.fromAddress).toBe('customer@example.com');
    expect(task?.fromName).toBe('Sam');
    expect(task?.source).toBe('store-reviews');
    expect(task?.externalId).toBe('review:8412');

    const jobs = listJobs({ type: COMPOSE_MESSAGE }, db);
    expect(jobs).toHaveLength(1);
    expect((jobs[0]?.payload as { taskId: string }).taskId).toBe(payload.taskId);
  });

  it('is safe to call again with the same id, which is how a sync is written', async () => {
    const first = (await (await post(REVIEW)).json()) as { taskId: string };
    const again = await post({ ...REVIEW, brief: 'The same review, re-read an hour later.' });
    const payload = (await again.json()) as { taskId: string; existed: boolean };

    expect(again.status).toBe(200);
    expect(payload.existed).toBe(true);
    expect(payload.taskId).toBe(first.taskId);
    expect(listTasks({}, db)).toHaveLength(1);
    // One job, not two. A reviewer halfway through editing a draft does not
    // have it rewritten under them by the next run of somebody's crontab.
    expect(listJobs({ type: COMPOSE_MESSAGE }, db)).toHaveLength(1);
    expect(getTask(first.taskId, db)?.body).toContain('two stars');
  });

  it('refuses a hand-in nobody could send or write', async () => {
    expect((await post({ ...REVIEW, to: 'not-an-address' })).status).toBe(400);
    expect((await post({ ...REVIEW, to: '' })).status).toBe(400);
    expect((await post({ ...REVIEW, brief: '   ' })).status).toBe(400);
    expect((await post('not json at all')).status).toBe(400);
    expect((await post([{ ...REVIEW }])).status).toBe(400);

    expect(listTasks({}, db)).toHaveLength(0);
  });

  it('takes the topic when the caller knows it, and shrugs at one it does not', async () => {
    const known = (await (await post({ ...REVIEW, scope: 'Billing' })).json()) as { taskId: string };
    const junk = (await (
      await post({ ...REVIEW, externalId: 'review:2', scope: '../../etc/passwd' })
    ).json()) as { taskId: string };

    // Normalised, not trusted verbatim: it is a slug that picks rules.
    expect(getTask(known.taskId, db)?.scope).toBe('billing');
    // An unusable slug is dropped rather than refused. The reply is then written
    // against the rules that apply to everything, which is where a task with no
    // topic at all already lands.
    expect(getTask(junk.taskId, db)?.scope).toBeNull();
  });

  it('defaults ahead of the inbox and honours a priority it is given', async () => {
    const quick = (await (await post(REVIEW)).json()) as { taskId: string };
    const later = (await (
      await post({ ...REVIEW, externalId: 'review:2', priority: 8 })
    ).json()) as { taskId: string };
    const silly = (await (
      await post({ ...REVIEW, externalId: 'review:3', priority: 500 })
    ).json()) as { taskId: string };

    expect(getTask(quick.taskId, db)?.priority).toBe(3);
    expect(getTask(later.taskId, db)?.priority).toBe(8);
    expect(getTask(silly.taskId, db)?.priority).toBe(3);
  });
});
