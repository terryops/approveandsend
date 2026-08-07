import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { createTask, listTasks, updateTask } from './store';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function seed(input: {
  id: string;
  from: string;
  at: string;
  priority?: number;
  status?: 'sent' | 'dismissed';
}): void {
  const { task } = createTask(
    {
      messageId: input.id,
      subject: input.id,
      fromAddress: input.from,
      receivedAt: input.at,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    },
    db,
  );
  if (input.status) updateTask(task.id, { status: input.status }, db);
}

describe('listTasks by sender', () => {
  it('finds everything from one address, whatever became of it', () => {
    // Including the dismissed ones. "We decided not to answer this" is a
    // decision, and it is often the one somebody is reading back to find.
    seed({ id: 'a', from: 'lin@example.com', at: '2026-02-01T00:00:00.000Z' });
    seed({ id: 'b', from: 'lin@example.com', at: '2026-03-01T00:00:00.000Z', status: 'dismissed' });
    seed({ id: 'c', from: 'someone@else.com', at: '2026-03-02T00:00:00.000Z' });

    const found = listTasks({ fromAddress: 'lin@example.com', order: 'newest' }, db);

    expect(found.map(task => task.subject)).toEqual(['b', 'a']);
  });

  it('does not care how the address was capitalised', () => {
    // Mail addresses are matched case-insensitively by every mail server, and
    // a customer who writes from Lin@ on Tuesday is not a second person.
    seed({ id: 'a', from: 'Lin@Example.com', at: '2026-02-01T00:00:00.000Z' });

    expect(listTasks({ fromAddress: 'lin@example.com' }, db)).toHaveLength(1);
  });

  it('reads a correspondence in the order it happened, not in queue order', () => {
    // The default order puts urgent first, which is the right answer for a
    // reviewer picking what to do next and the wrong one for anybody reading
    // back through what was said.
    seed({ id: 'old-and-urgent', from: 'lin@example.com', at: '2026-01-01T00:00:00.000Z', priority: 1 });
    seed({ id: 'recent', from: 'lin@example.com', at: '2026-06-01T00:00:00.000Z', priority: 9 });

    expect(listTasks({ fromAddress: 'lin@example.com', order: 'newest' }, db).map(t => t.subject)).toEqual([
      'recent',
      'old-and-urgent',
    ]);
    expect(listTasks({ fromAddress: 'lin@example.com' }, db).map(t => t.subject)).toEqual([
      'old-and-urgent',
      'recent',
    ]);
  });
});
