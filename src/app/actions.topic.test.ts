import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Refiling a mail by hand.
 *
 * The topic is not a label on a row: it chooses the rules the drafter is handed,
 * so a mail filed wrong is answered against the wrong rulebook. What matters
 * here is that a reviewer's correction lands in the column the drafter reads,
 * that it is recorded as having happened, and — the one that is easy to get
 * wrong — that pressing the button without changing the menu does not fill the
 * history with events saying nothing changed.
 */

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`redirect: ${url}`), { url });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth/guard', () => ({
  requireApi: async () => {},
  requireAdminApi: async () => {},
  currentOperator: async () => null,
}));

import { openDb, setDb, type Db } from '@/lib/db';
import { resetWorkspaceConfig } from '@/lib/config/workspace';
import { listEvents } from '@/lib/tasks/events';
import { createTask, getTask } from '@/lib/tasks/store';

import { changeTopic } from './actions';

let db: Db;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** Every action here ends by throwing a redirect; none of them is the point. */
async function run(fields: Record<string, string>): Promise<void> {
  await changeTopic(form(fields)).catch(() => {});
}

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  process.env.AAS_CONFIG = '/nonexistent/aas.config.json';
  resetWorkspaceConfig();
});

afterEach(() => {
  setDb(null);
  db.close();
  delete process.env.AAS_CONFIG;
  resetWorkspaceConfig();
});

describe('changing what a task is filed under', () => {
  it('writes the topic the drafter reads, and says who did it', async () => {
    const { task } = createTask({ subject: 'Refund please', scope: 'how-to' }, db);

    await run({ taskId: task.id, scope: 'billing-refund-cancel' });

    expect(getTask(task.id, db)?.scope).toBe('billing-refund-cancel');
    expect(listEvents(task.id, db).map(e => e.action)).toContain('recategorised');
  });

  it('normalises what the menu posts rather than trusting it', async () => {
    const { task } = createTask({ subject: 'Refund please' }, db);

    await run({ taskId: task.id, scope: '  Billing Refund  ' });

    expect(getTask(task.id, db)?.scope).toBe('billing-refund');
  });

  it('takes "none of these" as an answer', async () => {
    const { task } = createTask({ subject: 'Refund please', scope: 'how-to' }, db);

    await run({ taskId: task.id, scope: '' });

    // Which is what an unclassified task has always held, and what makes the
    // reply fall back to the rules that apply to everything.
    expect(getTask(task.id, db)?.scope).toBeNull();
  });

  it('records nothing when nothing changed', async () => {
    const { task } = createTask({ subject: 'Refund please', scope: 'how-to' }, db);

    await run({ taskId: task.id, scope: 'how-to' });

    // A history is only worth reading if every line in it is an event. Pressing
    // Change on the topic already selected is not one.
    expect(listEvents(task.id, db).map(e => e.action)).not.toContain('recategorised');
  });
});
