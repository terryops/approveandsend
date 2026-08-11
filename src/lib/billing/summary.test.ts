import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { customerSummary, forgetCustomerSummaries } from './summary';

/**
 * The card's read, and the minute it is remembered for.
 *
 * `?confirm=1` is a flag on the task route rather than a route of its own, so
 * pressing Preview re-renders the review screen — and the sender card on it —
 * underneath a panel that has nothing to do with billing. Every press was
 * costing a fresh Stripe round trip, and the response could not finish until it
 * came back.
 *
 * Stripe is stubbed at `fetch`, which is where `stripe.ts` reaches for it, so
 * these count real requests rather than trusting a mock's own bookkeeping.
 */

const CUSTOMER = {
  id: 'cus_1',
  email: 'marie@example.fr',
  name: 'Marie Dupont',
  created: 1_710_000_000,
};

let calls: string[] = [];
let failWith: string | null = null;
const realFetch = globalThis.fetch;

function answer(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  failWith = null;
  forgetCustomerSummaries();
  process.env.STRIPE_API_KEY = 'rk_test_stub';
  delete process.env.STRIPE_ENABLED;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (failWith) throw new Error(failWith);
    if (url.includes('/customers?')) {
      // `nobody@` is the address Stripe has never heard of.
      return answer({ data: url.includes('nobody') ? [] : [CUSTOMER] });
    }
    return answer({ data: [] });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  forgetCustomerSummaries();
  delete process.env.STRIPE_API_KEY;
});

/** How many of the calls so far were the customer lookup. */
function lookups(): number {
  return calls.filter(url => url.includes('/customers?')).length;
}

describe('the sender card’s read', () => {
  it('asks Stripe once and answers the second render from memory', async () => {
    const first = await customerSummary('marie@example.fr', 1_000);
    const second = await customerSummary('marie@example.fr', 3_000);

    // Two seconds apart is the interval this exists for: a reviewer pressing
    // Preview, which re-renders the screen the card is on.
    expect(lookups()).toBe(1);
    expect(second).toBe(first);
  });

  it('asks again once the answer is a minute old', async () => {
    await customerSummary('marie@example.fr', 1_000);
    await customerSummary('marie@example.fr', 1_000 + 60_000);

    expect(lookups()).toBe(2);
  });

  it('keeps addresses apart', async () => {
    await customerSummary('marie@example.fr', 1_000);
    await customerSummary('jean@example.fr', 1_000);

    expect(lookups()).toBe(2);
  });

  it('does not care how the address was typed', async () => {
    await customerSummary('marie@example.fr', 1_000);
    await customerSummary('  Marie@Example.FR  ', 2_000);

    // Stripe matches an address; the desk stores whatever the mail header said.
    expect(lookups()).toBe(1);
  });

  it('remembers that somebody is not a customer', async () => {
    // The common answer on most desks, and it costs exactly as much to fetch as
    // the other one — so not caching it would leave the usual case paying full
    // price on every render.
    const summary = await customerSummary('nobody@example.fr', 1_000);
    await customerSummary('nobody@example.fr', 2_000);

    expect(summary.customer).toBeNull();
    expect(summary.charges).toEqual([]);
    expect(lookups()).toBe(1);
  });

  it('does not remember a failure', async () => {
    failWith = 'Stripe is down';
    await expect(customerSummary('marie@example.fr', 1_000)).rejects.toThrow('Stripe is down');

    // An outage cached for a minute outlives itself: the reviewer reloads, gets
    // the same sentence, and cannot tell a service that is down from a card
    // that has stopped asking.
    failWith = null;
    const summary = await customerSummary('marie@example.fr', 2_000);

    expect(summary.customer?.id).toBe('cus_1');
    expect(lookups()).toBe(2);
  });

  it('does not grow without limit', async () => {
    for (let i = 0; i < 205; i++) {
      await customerSummary(`person${i}@example.fr`, 1_000);
    }
    // The first address is past the cap and has been dropped, so it costs a
    // fetch again; a recent one does not.
    const before = lookups();
    await customerSummary('person204@example.fr', 1_500);
    expect(lookups()).toBe(before);

    await customerSummary('person0@example.fr', 1_500);
    expect(lookups()).toBe(before + 1);
  });
});
