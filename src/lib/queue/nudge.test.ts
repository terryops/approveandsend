import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The flag, and the one way it could be held for ever.
 *
 * `nudgeQueue` exists to stop a screenful of pollers each building a worker of
 * their own, and it does that with a module-level boolean. A boolean released in
 * `finally` is released when the drain returns and when it throws — and never,
 * if it does neither. Every caller is `after(() => nudgeQueue())` with nobody
 * waiting on the promise, so a model call to a provider that accepts the
 * connection and stalls leaves the flag true for the life of the process: the
 * queue is never nudged again, from any screen, and nothing anywhere says so.
 *
 * The drain is mocked rather than driven, because the case under test is a job
 * that does not finish, and a test that waits for one takes as long as the bug
 * does. Fake timers stand in for the two minutes.
 */

const drains = { started: 0, resolve: [] as (() => void)[] };

vi.mock('./worker', () => ({
  createWorker: () => ({
    drain: () =>
      new Promise<void>(resolve => {
        drains.started += 1;
        drains.resolve.push(resolve);
      }),
  }),
}));

vi.mock('./handlers', () => ({ DEFAULT_HANDLERS: {} }));

const { nudgeQueue } = await import('./nudge');

beforeEach(() => {
  drains.started = 0;
  drains.resolve = [];
  vi.useFakeTimers();
});

afterEach(() => {
  // Let anything still parked in the race go, so one test's stalled drain is not
  // the next one's.
  for (const resolve of drains.resolve) resolve();
  vi.useRealTimers();
});

describe('nudgeQueue', () => {
  it('builds one worker however many screens ask at once', async () => {
    const asked = [nudgeQueue(), nudgeQueue(), nudgeQueue()];

    expect(drains.started).toBe(1);

    drains.resolve[0]!();
    await Promise.all(asked);
  });

  it('gives the flag back when the drain finishes', async () => {
    const first = nudgeQueue();
    drains.resolve[0]!();
    await first;

    const second = nudgeQueue();
    expect(drains.started).toBe(2);
    drains.resolve[1]!();
    await second;
  });

  it('gives it back on a drain that never returns, rather than never', async () => {
    // The drain is started and simply never settles — the provider took the
    // connection and stopped talking.
    const stalled = nudgeQueue();
    expect(drains.started).toBe(1);

    // Nothing changes while there is still reason to wait. This is the guard
    // doing its job: a second screen asking mid-drain is still refused.
    await vi.advanceTimersByTimeAsync(60_000);
    await nudgeQueue();
    expect(drains.started).toBe(1);

    // And past the deadline the flag comes back, so the next poll tick — the
    // one after a reviewer has been staring at a spinner for two minutes — turns
    // the queue instead of returning at a guard that will never open.
    await vi.advanceTimersByTimeAsync(61_000);
    await stalled;

    // Not awaited: this one starts a drain of its own, which is the point, and
    // that drain is as stalled as the first.
    const next = nudgeQueue();
    expect(drains.started).toBe(2);

    drains.resolve[1]!();
    await next;
  });
});
