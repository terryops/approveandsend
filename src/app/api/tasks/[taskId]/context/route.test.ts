import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A route handler called outside a Next request has no cookie jar, and asking
// for one throws. An empty jar is the honest stand-in: a machine caller does
// not have a session, which is the whole reason it carries a token.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

import { listContext } from '@/lib/context/store';
import { openDb, setDb, type Db } from '@/lib/db';
import { createTask } from '@/lib/tasks/store';

import { POST } from './route';

let db: Db;
let taskId: string;

const TOKEN = 'machine-token-for-tests';

function post(id: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return POST(
    new Request('http://localhost/api/tasks/x/context', {
      method: 'POST',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ taskId: id }) },
  );
}

const BLOCK = {
  sourceId: 'crm',
  label: 'CRM',
  title: 'Account',
  fields: [{ label: 'Tier', value: 'Enterprise' }],
  prompt: 'Enterprise account with two open tickets.',
};

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  process.env.CRON_TOKEN = TOKEN;
  // Without this the install is unprotected, and an unprotected install lets
  // everything through by design — including these tests, which would then
  // pass while asserting nothing.
  process.env.ADMIN_PASSWORD = 'not-the-machine-token';
  taskId = createTask({ fromAddress: 'customer@example.com', body: 'Hello.' }, db).task.id;
});

afterEach(() => {
  setDb(null);
  db.close();
  delete process.env.CRON_TOKEN;
  delete process.env.ADMIN_PASSWORD;
});

describe('POST /api/tasks/[taskId]/context', () => {
  it('stores the block against the task, where the review screen reads it', async () => {
    const response = await post(taskId, BLOCK);

    expect(response.status).toBe(200);
    expect(listContext(taskId, db)).toMatchObject([
      {
        sourceId: 'crm',
        label: 'CRM',
        title: 'Account',
        prompt: 'Enterprise account with two open tickets.',
      },
    ]);
  });

  it('turns away a caller with no token', async () => {
    expect((await post(taskId, BLOCK, null)).status).toBe(401);
    expect(listContext(taskId, db)).toEqual([]);
  });

  it('turns away a caller with the wrong token', async () => {
    // The system this replaced compared a shared secret with `!==` against a
    // hardcoded default. This one goes through the same timing-safe check as
    // every other machine endpoint.
    expect((await post(taskId, BLOCK, 'nearly-the-right-token')).status).toBe(401);
  });

  it('replaces the previous answer from the same source rather than stacking', async () => {
    await post(taskId, BLOCK);
    await post(taskId, { ...BLOCK, prompt: 'Enterprise account, tickets now closed.' });

    expect(listContext(taskId, db)).toMatchObject([
      { sourceId: 'crm', prompt: 'Enterprise account, tickets now closed.' },
    ]);
  });

  it('keeps sources apart', async () => {
    await post(taskId, BLOCK);
    await post(taskId, { ...BLOCK, sourceId: 'billing', title: 'Billing' });

    expect(listContext(taskId, db)).toHaveLength(2);
  });

  it('will not store a block with nothing in it', async () => {
    // An empty card reads as a lookup that found nothing, which is a different
    // and much more misleading thing than a callback posted wrong.
    expect((await post(taskId, { sourceId: 'crm', title: 'Account' })).status).toBe(400);
    expect(listContext(taskId, db)).toEqual([]);
  });

  it('needs to know which source it is', async () => {
    expect((await post(taskId, { ...BLOCK, sourceId: '' })).status).toBe(400);
  });

  it('says so when the task is gone', async () => {
    expect((await post('no-such-task', BLOCK)).status).toBe(404);
  });

  it('does not throw on a body that is not JSON', async () => {
    expect((await post(taskId, 'not json')).status).toBe(400);
  });

  it('falls back to the card title when no label is given', async () => {
    await post(taskId, { sourceId: 'crm', title: 'Account', prompt: 'A sentence.' });

    expect(listContext(taskId, db)[0]!.label).toBe('Account');
  });
});
