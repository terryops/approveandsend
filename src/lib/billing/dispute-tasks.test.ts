import { describe, expect, it } from 'vitest';

import { disputeTitle, syncDisputeTasks } from './dispute-tasks';
import type { StripeDispute } from './stripe';

function dispute(over: Partial<StripeDispute> = {}): StripeDispute {
  return {
    id: 'dp_1',
    charge: 'ch_1',
    amount: 990,
    currency: 'usd',
    reason: 'fraudulent',
    status: 'needs_response',
    created: 1_770_000_000,
    ...over,
  };
}

describe('the heading a chargeback wears on the queue', () => {
  it('leads with the money, the claim and the day it expires', () => {
    // All three are the reason to open this row rather than the one under it,
    // and none of them is in the subject line — a dispute has no subject line.
    expect(disputeTitle(dispute({ evidence_details: { due_by: 1_790_000_000 } }))).toBe(
      '9.9 USD · fraudulent · due 2026-09-21',
    );
  });

  it('says what it knows when Stripe gives no deadline', () => {
    // Early warnings carry no due date. A title reading "due Invalid Date" is
    // worse than a title that stops early.
    expect(disputeTitle(dispute())).toBe('9.9 USD · fraudulent');
  });
});

describe('a desk with no Stripe key', () => {
  it('reports why instead of throwing at a cron job', async () => {
    // Which is most desks. The endpoint runs hourly, and an unconfigured
    // integration must not be a 500 that pages somebody every hour for ever.
    const result = await syncDisputeTasks();
    expect(result.error).toBeTruthy();
    expect(result.created).toBe(0);
  });
});
