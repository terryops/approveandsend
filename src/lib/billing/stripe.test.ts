import { describe, expect, it } from 'vitest';

import { chargeState, money, netPaid, type StripeCharge } from './stripe';

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
