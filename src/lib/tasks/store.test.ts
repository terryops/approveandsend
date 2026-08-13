import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import {
  countTasksBySource,
  countTasksByStatus,
  createTask,
  listTasks,
  updateTask,
} from './store';
import { deskedAt } from './types';

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

describe('listTasks by free text', () => {
  function mail(input: {
    id: string;
    subject: string;
    from?: string;
    fromName?: string;
    body?: string;
    intent?: string;
    draft?: string;
    status?: 'sent' | 'dismissed';
  }): void {
    const { task } = createTask(
      {
        messageId: input.id,
        subject: input.subject,
        fromAddress: input.from ?? 'lin@example.com',
        ...(input.fromName ? { fromName: input.fromName } : {}),
        ...(input.body ? { body: input.body } : {}),
        receivedAt: '2026-02-01T00:00:00.000Z',
      },
      db,
    );
    updateTask(
      task.id,
      {
        ...(input.status ? { status: input.status } : {}),
        ...(input.draft ? { draft: input.draft } : {}),
        ...(input.intent
          ? {
              analysis: {
                intent: input.intent,
                language: 'en',
                sentiment: 'neutral',
                keyPoints: [],
                suggestedActions: [],
              },
            }
          : {}),
      },
      db,
    );
  }

  it('looks in the subject, the sender, the body and the reply', () => {
    mail({ id: 'a', subject: 'Where is my export' });
    mail({ id: 'b', subject: 'Hello', fromName: 'Priya Raman' });
    mail({ id: 'c', subject: 'Hello', body: 'the invoice needs our VAT number' });
    mail({ id: 'd', subject: 'Hello', draft: 'We have issued the refund today.' });

    expect(listTasks({ search: 'export' }, db).map(t => t.messageId)).toEqual(['a']);
    expect(listTasks({ search: 'priya' }, db).map(t => t.messageId)).toEqual(['b']);
    expect(listTasks({ search: 'VAT' }, db).map(t => t.messageId)).toEqual(['c']);
    // The promise lives in the draft, and "which one did I promise that in" is
    // the reason the draft is searched at all.
    expect(listTasks({ search: 'refund' }, db).map(t => t.messageId)).toEqual(['d']);
  });

  it('searches the analysis, so a Chinese summary finds an English mail', () => {
    // The whole point on a bilingual desk: the mail arrived in English and the
    // summary written for the reviewer is in their language. Searching in
    // either has to find it.
    mail({ id: 'a', subject: 'Refund for the annual plan', intent: '用户误订年缴，希望退回差额' });

    expect(listTasks({ search: '退款' }, db)).toHaveLength(0);
    expect(listTasks({ search: '退回' }, db).map(t => t.messageId)).toEqual(['a']);
    expect(listTasks({ search: 'annual' }, db).map(t => t.messageId)).toEqual(['a']);
  });

  it('matches a substring, because nothing here segments Chinese', () => {
    mail({ id: 'a', subject: '为什么删除不了账户' });

    // No tokeniser would split this into words, so whole-word matching would
    // mean Chinese is unsearchable.
    expect(listTasks({ search: '删除' }, db).map(t => t.messageId)).toEqual(['a']);
  });

  it('ignores case, and does not care which column each word landed in', () => {
    mail({ id: 'a', subject: 'API 401 error', fromName: 'Harry WY', intent: '客户希望追加测试积分' });
    mail({ id: 'b', subject: 'API question', fromName: 'Someone Else' });

    // Three words, three different columns, one row.
    expect(listTasks({ search: 'harry api 积分' }, db).map(t => t.messageId)).toEqual(['a']);
    // Every word has to land somewhere, or it is not a match.
    expect(listTasks({ search: 'harry nonexistent' }, db)).toHaveLength(0);
  });

  it('treats % and _ as characters somebody typed, not as wildcards', () => {
    mail({ id: 'a', subject: 'The 50% education discount' });
    mail({ id: 'b', subject: 'Nothing to do with discounts' });

    // Unescaped, `%` in a LIKE pattern matches anything, so this would return
    // both rows and the search would look broken in the least obvious way.
    expect(listTasks({ search: '50%' }, db).map(t => t.messageId)).toEqual(['a']);
    // A bare `%` is a character to look for, so it finds the row that has one
    // and not the row that does not. Unescaped it would return both.
    expect(listTasks({ search: '%' }, db).map(t => t.messageId)).toEqual(['a']);
    expect(listTasks({ search: '_' }, db)).toHaveLength(0);
  });

  it('reaches the archive, and still narrows to a status when asked', () => {
    mail({ id: 'a', subject: 'guest post offer', status: 'dismissed' });
    mail({ id: 'b', subject: 'guest post enquiry' });

    // A dismissed pitch is exactly what somebody searches for, so a search
    // that stopped at the queue would miss the common case.
    expect(listTasks({ search: 'guest post' }, db)).toHaveLength(2);
    expect(listTasks({ search: 'guest post', status: 'dismissed' }, db).map(t => t.messageId)).toEqual(['a']);
  });

  it('finds a row by the topic label shown on it, not just the slug behind it', () => {
    const LABELS = { 'billing-refund-cancel': '退款与取消', 'api-and-integration': 'API 与集成' };
    const { task } = createTask(
      { messageId: 'a', subject: 'Change annual to monthly', fromAddress: 'lin@example.com' },
      db,
    );
    updateTask(task.id, { scope: 'billing-refund-cancel' }, db);
    mail({ id: 'b', subject: 'unrelated' });

    // The tag reads 退款与取消 and the column holds billing-refund-cancel, so
    // without the bridge the thing on screen is the one thing you cannot type.
    expect(listTasks({ search: '退款与取消', topicLabels: LABELS }, db).map(t => t.messageId)).toEqual(['a']);
    expect(listTasks({ search: '退款', topicLabels: LABELS }, db).map(t => t.messageId)).toEqual(['a']);
    // The slug still works for anyone who knows it.
    expect(listTasks({ search: 'billing-refund', topicLabels: LABELS }, db).map(t => t.messageId)).toEqual(['a']);
    // And a label that matches nothing on this row does not drag it in.
    expect(listTasks({ search: 'API 与集成', topicLabels: LABELS }, db)).toHaveLength(0);
  });

  it('adds the label match, it does not replace the text match', () => {
    const LABELS = { 'billing-refund-cancel': '退款与取消' };
    // Tagged something else entirely, but its summary says the word.
    mail({ id: 'a', subject: 'Hello', intent: '用户要求退款' });

    // Were the term swapped for the slug instead of ORed with it, this row —
    // the one that literally says 退款 — would stop being found.
    expect(listTasks({ search: '退款', topicLabels: LABELS }, db).map(t => t.messageId)).toEqual(['a']);
  });

  it('is not a filter at all when it is blank', () => {
    mail({ id: 'a', subject: 'one' });
    mail({ id: 'b', subject: 'two' });

    expect(listTasks({ search: '   ' }, db)).toHaveLength(2);
    expect(listTasks({ search: '' }, db)).toHaveLength(2);
  });
});

describe('countTasksByStatus', () => {
  it('counts the search, so a tab cannot advertise rows the list will not show', () => {
    const { task: a } = createTask({ messageId: 'a', subject: 'refund please', fromAddress: 'a@x.com' }, db);
    createTask({ messageId: 'b', subject: 'refund please too', fromAddress: 'b@x.com' }, db);
    createTask({ messageId: 'c', subject: 'unrelated', fromAddress: 'c@x.com' }, db);
    updateTask(a.id, { status: 'dismissed' }, db);

    expect(countTasksByStatus({}, db)).toEqual({ pending: 2, dismissed: 1 });
    expect(countTasksByStatus({ search: 'refund' }, db)).toEqual({ pending: 1, dismissed: 1 });
    expect(countTasksByStatus({ search: 'unrelated' }, db)).toEqual({ pending: 1 });
  });
});

/*
 * Three screens print a task's time, and one kind of task had none to print.
 * A composed mail was never received, so `received_at` is null on it and the
 * heading ended at the address — which reads as a rendering fault rather than
 * as "nobody sent this to us".
 */
describe('deskedAt', () => {
  it('is when the mail arrived, when it arrived', () => {
    const { task } = createTask(
      { messageId: 'm', fromAddress: 'a@x.com', receivedAt: '2026-08-01T09:30:00.000Z' },
      db,
    );

    expect(deskedAt(task)).toBe('2026-08-01T09:30:00.000Z');
  });

  it('falls back to when it was written on a mail nobody sent us', () => {
    const { task } = createTask({ origin: 'composed', fromAddress: 'them@x.com' }, db);

    expect(task.receivedAt).toBeNull();
    expect(deskedAt(task)).toBe(task.createdAt);
  });
});

/*
 * A program handing work in cannot be asked to remember what it has already
 * handed in: the honest implementation of "sync my reviews" re-reads the whole
 * list on every run, and the crontab that runs it knows nothing at all. So the
 * uniqueness lives here, where the mailbox's own duplicates are already caught.
 */
describe('createTask by external id', () => {
  it('answers a repeated hand-in with the task it made the first time', () => {
    const first = createTask(
      { origin: 'composed', externalId: 'review:8412', source: 'store-reviews', fromAddress: 'a@x.com', body: 'Two stars.' },
      db,
    );
    const second = createTask(
      { origin: 'composed', externalId: 'review:8412', source: 'store-reviews', fromAddress: 'a@x.com', body: 'Two stars, again.' },
      db,
    );

    expect(first.existed).toBe(false);
    expect(second.existed).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    // The first hand-in's words, not the second's. A row a reviewer may already
    // be reading is not rewritten by a sync running behind them.
    expect(second.task.body).toBe('Two stars.');
  });

  it('keeps the label and the topic the caller sent', () => {
    const { task } = createTask(
      { origin: 'composed', externalId: 'review:1', source: 'store-reviews', scope: 'billing', fromAddress: 'a@x.com' },
      db,
    );

    expect(task.source).toBe('store-reviews');
    expect(task.scope).toBe('billing');
    // The desk does not learn what a store review is. It only knows these rows
    // came in together.
    expect(task.externalId).toBe('review:1');
  });

  it('leaves both null for the two ways a task arrived before intake existed', () => {
    const mail = createTask({ messageId: 'm1', fromAddress: 'a@x.com' }, db).task;
    const composed = createTask({ origin: 'composed', fromAddress: 'a@x.com' }, db).task;

    expect(mail.externalId).toBeNull();
    expect(mail.source).toBeNull();
    expect(composed.externalId).toBeNull();
    expect(composed.source).toBeNull();
  });

  it('does not collide two callers that both have an id of 1', () => {
    createTask({ origin: 'composed', externalId: 'reviews:1', fromAddress: 'a@x.com' }, db);
    const other = createTask({ origin: 'composed', externalId: 'forms:1', fromAddress: 'b@x.com' }, db);

    expect(other.existed).toBe(false);
    expect(listTasks({}, db).map(t => t.externalId).sort()).toEqual(['forms:1', 'reviews:1']);
  });
});

describe('listTasks by where it came from', () => {
  function labelled(id: string, source?: string): void {
    createTask(
      {
        origin: 'composed',
        subject: id,
        fromAddress: `${id}@example.com`,
        body: id,
        ...(source ? { source } : {}),
      },
      db,
    );
  }

  it('separates the labelled intakes from ordinary mail', () => {
    seed({ id: 'letter', from: 'a@example.com', at: '2026-08-01T09:00:00Z' });
    labelled('own-letter');
    labelled('chargeback', 'dispute');
    labelled('one-star', 'subeasy-bad-review');

    expect(listTasks({ source: 'dispute' }, db).map(t => t.subject)).toEqual(['chargeback']);
    // `null` is a question, not the absence of one: both the mail that arrived
    // and the mail this desk wrote first carry no label, and both are mail.
    expect(listTasks({ source: null }, db).map(t => t.subject).sort()).toEqual([
      'letter',
      'own-letter',
    ]);
  });

  it('counts every intake in one pass, so a tab can say how much is behind it', () => {
    seed({ id: 'letter', from: 'a@example.com', at: '2026-08-01T09:00:00Z' });
    labelled('chargeback', 'dispute');
    labelled('another', 'dispute');

    const counts = countTasksBySource({}, db);
    const disputes = counts.find(row => row.source === 'dispute');
    expect(disputes?.count).toBe(2);
    expect(counts.filter(row => !row.source).reduce((sum, row) => sum + row.count, 0)).toBe(1);
  });

  it('counts through the filter it is given, so the tabs and the list agree', () => {
    labelled('chargeback', 'dispute');
    const open = listTasks({ source: 'dispute' }, db)[0]!;
    updateTask(open.id, { status: 'dismissed' }, db);
    labelled('live', 'dispute');

    const counts = countTasksBySource({ excludeStatuses: ['dismissed'] }, db);
    expect(counts.find(row => row.source === 'dispute')?.count).toBe(1);
  });
});
