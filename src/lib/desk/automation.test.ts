import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { setMeta } from '../db/meta';

import { automation, noteRun, type Scheduled } from './automation';

let db: Db;
let token: string | undefined;

function calledMinutesAgo(job: Scheduled, minutes: number): void {
  setMeta(
    `automation.lastRun.${job}`,
    new Date(Date.now() - minutes * 60_000).toISOString(),
    db,
  );
}

function state(job: Scheduled): string {
  return automation(db).jobs.find(row => row.job === job)!.state;
}

beforeEach(() => {
  db = openDb(':memory:');
  token = process.env.CRON_TOKEN;
  delete process.env.CRON_TOKEN;
});

afterEach(() => {
  db.close();
  if (token === undefined) delete process.env.CRON_TOKEN;
  else process.env.CRON_TOKEN = token;
});

describe('automation', () => {
  it('says nothing is driving a desk nobody has scheduled', () => {
    const now = automation(db);

    expect(now.silent).toBe(true);
    expect(now.late).toBe(false);
    expect(now.jobs.map(job => job.state)).toEqual(['never', 'never', 'never', 'never']);
  });

  it('stops saying so the moment a call arrives', () => {
    noteRun('sync', db);

    expect(automation(db).silent).toBe(false);
    expect(state('sync')).toBe('onTime');
  });

  /**
   * The distinction the card is for. A scheduler that stopped is not the same
   * fact as one that never existed, and the desk looks identical from every
   * other screen either way.
   */
  it('separates a scheduler that stopped from one that was never set up', () => {
    calledMinutesAgo('sync', 90);

    expect(automation(db).silent).toBe(false);
    expect(state('sync')).toBe('late');
    expect(state('worker')).toBe('never');
  });

  /**
   * The two that matter decide the verdict. A sweep that has never run means
   * nothing was ever left stuck, and a rulebook that has never been consolidated
   * is what every desk looks like in its first week — letting either turn the
   * card amber would make it amber for everybody.
   */
  it('does not call a desk late over the two jobs that have nothing to do yet', () => {
    calledMinutesAgo('sync', 1);
    calledMinutesAgo('worker', 1);

    const now = automation(db);
    expect(now.late).toBe(false);
    expect(state('sweep')).toBe('never');
  });

  it('calls it late once the mail has stopped being fetched', () => {
    calledMinutesAgo('sync', 40);
    calledMinutesAgo('worker', 1);

    expect(automation(db).late).toBe(true);
  });

  /**
   * Two ticks of grace, never under a quarter of an hour. A two-minute worker
   * that went amber at four would be amber every time the host was busy.
   */
  it('gives a fast job the same quarter-hour of slack as a slow one', () => {
    calledMinutesAgo('worker', 12);
    expect(state('worker')).toBe('onTime');

    calledMinutesAgo('worker', 20);
    expect(state('worker')).toBe('late');
  });

  it('reports whether there is a token for a scheduler to present', () => {
    expect(automation(db).tokenSet).toBe(false);

    process.env.CRON_TOKEN = 'not-the-admin-password';
    expect(automation(db).tokenSet).toBe(true);
  });

  /** A meta row somebody hand-edited must not read as a call from the future. */
  it('treats an unreadable timestamp as never having run', () => {
    setMeta('automation.lastRun.sync', 'last tuesday', db);

    expect(state('sync')).toBe('never');
    expect(automation(db).silent).toBe(true);
  });
});
