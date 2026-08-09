import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { seedDemoData } from '../demo/seed';
import { createRule } from '../rules/store';
import { createTask, updateTask } from '../tasks/store';
import { deskUntouched } from './untouched';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function mail(subject = 'Refund please'): string {
  const { task } = createTask(
    {
      messageId: subject,
      fromAddress: 'someone@example.com',
      subject,
      body: 'Body.',
      receivedAt: new Date().toISOString(),
    },
    db,
  );
  return task.id;
}

describe('deskUntouched', () => {
  it('is true for a database nobody has written to', () => {
    expect(deskUntouched(db)).toBe(true);
  });

  it('is false once a single email has arrived', () => {
    mail();
    expect(deskUntouched(db)).toBe(false);
  });

  it('is false for a rulebook of nothing but pending proposals', () => {
    createRule({ content: 'Something the learning pass suggested.', proposed: true }, db);
    expect(deskUntouched(db)).toBe(false);
  });

  /*
   * The tabs are the reason this function exists rather than being inlined at
   * the inbox as "is this list empty?".
   *
   * A desk whose every task is dismissed has an empty `awaiting_review`, an
   * empty `sent`, and an empty `all` — `all` excludes the bin — so three of the
   * six tabs render the empty state on a database with mail in it. Offering
   * sample data there posted a form to a seed that declines, and redirected
   * back to the same empty tab with nothing to show for it: a button that does
   * nothing, on the screen of somebody who has just binned their inbox.
   */
  it('is false on a desk whose mail has all been dismissed', () => {
    updateTask(mail(), { status: 'dismissed' }, db);
    expect(deskUntouched(db)).toBe(false);
  });

  // The predicate and the guard that uses it, agreeing — which is the whole
  // reason there is one function. Whenever this says the desk is untouched the
  // seed must go through, and whenever it does not the seed must decline.
  it('says exactly what seedDemoData is about to decide', () => {
    expect(deskUntouched(db)).toBe(true);
    expect(seedDemoData(db).skipped).toBe(false);

    expect(deskUntouched(db)).toBe(false);
    expect(seedDemoData(db).skipped).toBe(true);
  });
});
