import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The guard, stood in for. This file is about one decision — what the browser is
// told to do with the bytes — and signing in is not part of it.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth/guard', () => ({ hasSession: async () => true }));

import { openDb, setDb, type Db } from '@/lib/db';
import { attachToTask, listPending } from '@/lib/tasks/outgoing';
import { createTask } from '@/lib/tasks/store';

import { GET } from './route';

let db: Db;
let taskId: string;

function get(id: string, task = taskId): Promise<Response> {
  return GET(new Request('http://localhost/api/outgoing/x/y'), {
    params: Promise.resolve({ taskId: task, id }),
  });
}

/** Put a file on the reply and hand back its id. */
function attach(filename: string, contentType: string): string {
  attachToTask(taskId, [{ filename, contentType, content: Buffer.from('bytes') }], db);
  return listPending(taskId, db).find(file => file.filename === filename)!.id;
}

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  taskId = createTask({ messageId: 'one', fromAddress: 'lin@example.com' }, db).task.id;
});

afterEach(() => {
  db.close();
});

describe('reading back a file put on a reply', () => {
  it('hands over the bytes that were stored', async () => {
    const response = await get(attach('invoice.pdf', 'application/pdf'));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('bytes');
  });

  it('shows a picture rather than downloading it, because the tile is an img', async () => {
    const response = await get(attach('shot.png', 'image/png'));

    expect(response.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('refuses to render an SVG in our own origin', async () => {
    // Off the reviewer's own disk this time, which makes it likelier to be safe
    // and no more provable. It is still a document that can carry script.
    const response = await get(attach('logo.svg', 'image/svg+xml'));

    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('forbids the browser from sniffing past the type we allowed', async () => {
    const response = await get(attach('shot.png', 'image/png'));

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('will not serve a file attached to somebody else’s reply', async () => {
    const other = createTask({ messageId: 'two', fromAddress: 'x@example.com' }, db).task.id;
    const mine = attach('invoice.pdf', 'application/pdf');

    expect((await get(mine, other)).status).toBe(404);
  });
});
