import { afterEach, describe, expect, it } from 'vitest';

import {
  chargeState,
  money,
  netPaid,
  priceOf,
  stripeConfigured,
  stripeKey,
  stripeMode,
  stripeOn,
  stripeRestricted,
  type StripeCharge,
  type StripePrice,
} from './stripe';

function charge(over: Partial<StripeCharge> = {}): StripeCharge {
  return {
    id: 'ch_1',
    amount: 10_000,
    currency: 'usd',
    paid: true,
    refunded: false,
    created: 1_770_000_000,
    status: 'succeeded',
    ...over,
  };
}

describe('chargeState', () => {
  it('calls a half-refunded charge partially refunded, not paid', () => {
    // Stripe's `refunded` flag only flips on a *full* refund, so a charge with
    // half its money already returned reads as an ordinary payment. That is how
    // somebody gets told "we have not refunded you" while holding a refund.
    expect(chargeState(charge({ amount_refunded: 5_000 }))).toBe('partial');
  });

  it('calls a fully refunded charge refunded', () => {
    expect(chargeState(charge({ refunded: true, amount_refunded: 10_000 }))).toBe('refunded');
  });

  it('treats an unsucceeded charge as failed however it is flagged', () => {
    expect(chargeState(charge({ status: 'pending' }))).toBe('failed');
    expect(chargeState(charge({ paid: false }))).toBe('failed');
  });

  it('calls an untouched charge paid', () => {
    expect(chargeState(charge({ amount_refunded: 0 }))).toBe('paid');
  });
});

describe('netPaid', () => {
  it('trusts the refunded flag the way chargeState does', () => {
    // A full refund that arrives without `amount_refunded` beside it is still
    // a full refund, and counting it as money kept overstates a total on a
    // screen about somebody's money.
    expect([...netPaid([charge({ refunded: true })])]).toEqual([['usd', 0]]);
  });

  it('subtracts what went back rather than counting what came in', () => {
    const totals = netPaid([charge(), charge({ id: 'ch_2', amount_refunded: 4_000 })]);

    expect(totals.get('usd')).toBe(16_000);
  });

  it('keeps currencies apart, because adding them would invent a number', () => {
    const totals = netPaid([charge(), charge({ id: 'ch_2', currency: 'jpy', amount: 5_000 })]);

    expect([...totals]).toEqual([
      ['usd', 10_000],
      ['jpy', 5_000],
    ]);
  });

  it('ignores failed charges, which never took any money', () => {
    expect(netPaid([charge({ status: 'failed' })]).size).toBe(0);
  });

  it('reports a fully refunded currency as zero rather than dropping it', () => {
    // "Everything was refunded" and "they never paid" are different facts, and
    // a reviewer about to issue another refund needs the first one.
    const totals = netPaid([charge({ refunded: true, amount_refunded: 10_000 })]);

    expect(totals.get('usd')).toBe(0);
  });
});

describe('money', () => {
  it('divides by a hundred for currencies that have minor units', () => {
    expect(money(10_000, 'usd')).toBe('100 USD');
  });

  it('leaves zero-decimal currencies alone', () => {
    // ¥5,000 shown as ¥50 is a hundredfold error in a sentence we then say out
    // loud to the person who paid the ¥5,000.
    expect(money(5_000, 'jpy')).toBe('5,000 JPY');
  });
});

function price(over: Partial<StripePrice> = {}): StripePrice {
  return {
    id: 'price_1',
    product: 'prod_1',
    active: true,
    currency: 'usd',
    unit_amount: 1_900,
    recurring: { interval: 'month' },
    ...over,
  };
}

describe('priceOf', () => {
  it('says the amount, the currency and the period', () => {
    expect(priceOf(price())).toBe('19 USD/month');
  });

  it('refuses to invent a number for a price that has none', () => {
    // `unit_amount` is null on tiered and metered prices. Defaulting it to 0
    // renders as free, and a model handed "0 USD/month" writes it to somebody.
    expect(priceOf(price({ unit_amount: null }))).toBe('usage-based, price varies');
  });

  it('counts a multi-month interval rather than dropping the count', () => {
    // "19 USD/month" for a price billed every three months is a third of the
    // real one, quoted to somebody about to buy it.
    expect(priceOf(price({ recurring: { interval: 'month', interval_count: 3 } }))).toBe(
      '19 USD/3 months',
    );
  });

  it('marks a price with no recurrence as a one-off', () => {
    expect(priceOf(price({ recurring: null }))).toBe('19 USD one-off');
  });
});

/**
 * The key and the switch, which are two questions.
 *
 * Env is process-wide and vitest shares one process, so every case here sets
 * both variables and the teardown removes them — a leaked `STRIPE_ENABLED=0`
 * would silently switch billing off for whatever test file ran next.
 */
describe('whether billing is on', () => {
  afterEach(() => {
    delete process.env.STRIPE_API_KEY;
    delete process.env.STRIPE_ENABLED;
  });

  it('is off with no key, however the switch is set', () => {
    process.env.STRIPE_ENABLED = '1';
    expect(stripeConfigured()).toBe(false);
  });

  it('is on for a key with nothing said about the switch', () => {
    // Every install that predates the switch is this one, and it must behave
    // exactly as it did before the switch existed.
    process.env.STRIPE_API_KEY = 'rk_live_abc';
    expect(stripeOn()).toBe(true);
    expect(stripeConfigured()).toBe(true);
  });

  it('keeps the key but stops the lookups when switched off', () => {
    process.env.STRIPE_API_KEY = 'rk_live_abc';
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.STRIPE_ENABLED = off;
      expect(stripeConfigured(), off).toBe(false);
      // The point of the switch: the credential survives being turned off.
      expect(stripeKey(), off).toBe('rk_live_abc');
    }
  });

  it('reads live and test off the key, restricted or not', () => {
    process.env.STRIPE_API_KEY = 'sk_test_abc';
    expect(stripeMode()).toBe('test');
    expect(stripeRestricted()).toBe(false);

    process.env.STRIPE_API_KEY = 'rk_live_abc';
    expect(stripeMode()).toBe('live');
    expect(stripeRestricted()).toBe(true);
  });

  it('claims neither mode for a key shaped like neither', () => {
    // Better than guessing live: the settings screen says the key looks wrong,
    // which is the useful thing to tell somebody who pasted half of one.
    process.env.STRIPE_API_KEY = 'not-a-stripe-key';
    expect(stripeMode()).toBe(null);
  });
});
