import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { createRule, listRules } from '../rules/store';
import { listTasks } from '../tasks/store';
import { seedDemoData } from './seed';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('seedDemoData', () => {
  it('fills an empty database with a reviewable inbox', () => {
    const result = seedDemoData(db);

    expect(result.skipped).toBe(false);
    expect(listTasks({}, db)).toHaveLength(result.tasks);
    expect(listRules({}, db)).toHaveLength(result.rules);

    // The point of the fixtures: something to review, and something already
    // sent whose edit explains a rule.
    const tasks = listTasks({}, db);
    expect(tasks.filter(t => t.status === 'awaiting_review').length).toBeGreaterThan(0);

    const sent = tasks.find(t => t.status === 'sent')!;
    expect(sent.draft).toBeTruthy();
    expect(sent.finalReply).toBeTruthy();
    expect(sent.finalReply).not.toBe(sent.draft);
  });

  it('points the learned rules at the email that taught them', () => {
    seedDemoData(db);

    const sent = listTasks({}, db).find(t => t.status === 'sent')!;
    const learned = listRules({}, db).filter(rule => rule.sourceTaskId !== null);

    expect(learned.length).toBeGreaterThan(0);
    for (const rule of learned) expect(rule.sourceTaskId).toBe(sent.id);
  });

  it('refuses to write into a database that is already in use', () => {
    createRule({ content: 'A real rule someone wrote.' }, db);

    expect(seedDemoData(db)).toEqual({ tasks: 0, rules: 0, skipped: true });
    expect(listTasks({}, db)).toHaveLength(0);
    expect(listRules({}, db)).toHaveLength(1);
  });

  // The guard reads "is there anything here?", and a rulebook of nothing but
  // pending proposals is something — a desk that has been taking real mail
  // long enough to learn from it. Asking only about approved rules called that
  // empty and let demo mail into a live queue.
  it('refuses when the only rules so far are waiting for approval', () => {
    createRule({ content: 'Something the learning pass suggested.', proposed: true }, db);

    expect(seedDemoData(db)).toEqual({ tasks: 0, rules: 0, skipped: true });
    expect(listTasks({}, db)).toHaveLength(0);
  });

  it('is not applied twice by a double click', () => {
    const first = seedDemoData(db);
    const second = seedDemoData(db);

    expect(second.skipped).toBe(true);
    expect(listTasks({}, db)).toHaveLength(first.tasks);
  });
});
