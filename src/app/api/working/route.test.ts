import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No session unless a test says otherwise, and `hasSession` is the whole guard
// on this route — so it is what gets mocked rather than the cookie jar.
const signedIn = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/auth/guard', () => ({ hasSession: async () => signedIn.value }));

// What `after` schedules is a turn of the queue, and a turn of the queue is a
// model call. That this route asks for one is asserted below by mocking the
// nudge itself; running it is not what these tests are about.
vi.mock('next/server', () => ({ after: (run: () => void) => run() }));

const nudged = vi.hoisted(() => ({ times: 0 }));
vi.mock('@/lib/queue/nudge', () => ({
  nudgeQueue: async () => {
    nudged.times += 1;
  },
}));

import { resetWorkspaceConfig } from '@/lib/config/workspace';
import { openDb, setDb, type Db } from '@/lib/db';
import { enqueueForTranslation } from '@/lib/queue/handlers';
import { createTask, updateTask } from '@/lib/tasks/store';

import { GET } from './route';

let db: Db;

function ask(ids: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/working?ids=${encodeURIComponent(ids)}`));
}

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  signedIn.value = true;
  nudged.times = 0;
});

afterEach(() => {
  db.close();
  delete process.env.AAS_CONFIG;
  delete process.env.AAS_REVIEW_LANGUAGE;
  resetWorkspaceConfig();
  vi.restoreAllMocks();
});

/** A desk whose reviewer reads the mail in another language. */
function rendersForReview(): void {
  process.env.AAS_CONFIG = '/nonexistent/absent.json';
  process.env.AAS_REVIEW_LANGUAGE = 'Chinese';
  resetWorkspaceConfig();
}

function pending(subject: string): string {
  const { task } = createTask({ subject, fromAddress: 'customer@example.com', body: 'Hello' }, db);
  return task.id;
}

describe('GET /api/working', () => {
  it('answers with the status and the heading, and nothing else about the task', async () => {
    const id = pending('Where is my invoice');
    const body = await (await ask(id)).json();

    expect(body.tasks).toEqual([
      { id, status: 'pending', title: 'Where is my invoice', translating: false },
    ]);
  });

  it('turns the queue while something is still being written', async () => {
    await ask(pending('Still going'));
    expect(nudged.times).toBe(1);
  });

  it('leaves the queue alone once the drafts have landed', async () => {
    const id = pending('Done with it');
    updateTask(id, { status: 'awaiting_review', draft: 'Here you are.' }, db);

    await ask(id);
    expect(nudged.times).toBe(0);
  });

  it('is still busy while the reply is being rendered for the reviewer', async () => {
    rendersForReview();
    const id = pending('Refund please');
    updateTask(id, { status: 'awaiting_review', draft: 'Bien sûr, sous 5 jours.' }, db);
    enqueueForTranslation(id, { db });

    const body = await (await ask(id)).json();

    // The draft is written and the task says so, but the text this reviewer
    // reads is a second job behind it. One announcement, when both have landed.
    expect(body.tasks[0].translating).toBe(true);
    // And the same bargain as the draft wait: asking whether it is done is
    // what gets it done on an install whose crontab is the only worker.
    expect(nudged.times).toBe(1);
  });

  it('skips an id that is not a task rather than failing the whole answer', async () => {
    const id = pending('Real one');
    const body = await (await ask(`${id},no-such-task`)).json();

    expect(body.tasks.map((task: { id: string }) => task.id)).toEqual([id]);
  });

  it('tells a signed-out browser nothing', async () => {
    signedIn.value = false;
    const response = await ask(pending('Private'));

    expect(response.status).toBe(401);
    expect((await response.json()).tasks).toEqual([]);
  });
});
