import { describe, expect, it } from 'vitest';

import { analyseDisputes, disputeOpen, disputeState, reasonOf } from './disputes';
import type { StripeCharge, StripeDispute } from './stripe';

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

function dispute(over: Partial<StripeDispute> = {}): StripeDispute {
  return {
    id: 'dp_1',
    charge: 'ch_1',
    amount: 10_000,
    currency: 'usd',
    reason: 'fraudulent',
    status: 'needs_response',
    created: 1_770_000_000,
    ...over,
  };
}

/** The charge as Stripe returns it once a dispute exists against it. */
function disputed(id = 'dp_1'): StripeCharge {
  return charge({ disputed: true, dispute: id });
}

const NOW = 1_770_100_000_000;

describe('disputeState', () => {
  it('separates the two ways a dispute can end, because they are opposite facts', () => {
    // Lost: they have the money. Won: they do not, and think they should.
    expect(disputeState(dispute({ status: 'lost' }))).toBe('lost');
    expect(disputeState(dispute({ status: 'won' }))).toBe('won');
  });

  it('calls all three warning statuses a warning, not a chargeback', () => {
    for (const status of ['warning_needs_response', 'warning_under_review', 'warning_closed']) {
      expect(disputeState(dispute({ status }))).toBe('warning');
    }
  });

  it('reads a status it has never seen as still open', () => {
    // Failing safe. A status Stripe adds next year that this does not know
    // about should hold a refund back, not release one.
    expect(disputeState(dispute({ status: 'something_new' }))).toBe('under_review');
    expect(disputeOpen(dispute({ status: 'something_new' }))).toBe(true);
  });

  it('treats a closed warning as history and everything else live', () => {
    expect(disputeOpen(dispute({ status: 'warning_closed' }))).toBe(false);
    expect(disputeOpen(dispute({ status: 'warning_needs_response' }))).toBe(true);
    expect(disputeOpen(dispute({ status: 'charge_refunded' }))).toBe(false);
  });
});

describe('reasonOf', () => {
  it('says what the bank filed rather than repeating the code at a reviewer', () => {
    // `fraudulent` handed straight to a model is how a reply comes to accuse
    // somebody of fraud over a card their partner used.
    expect(reasonOf(dispute({ reason: 'fraudulent' }))).toContain('the cardholder says they did not authorise it');
  });

  it('falls back to readable words for a code it does not know', () => {
    expect(reasonOf(dispute({ reason: 'some_new_code' }))).toBe('some new code');
  });
});

describe('analyseDisputes', () => {
  it('says nothing at all when no charge was ever disputed', () => {
    const analysis = analyseDisputes([charge(), charge({ id: 'ch_2' })], [], null, NOW);

    expect(analysis.lines).toEqual([]);
    expect(analysis.headline).toBeNull();
    expect(analysis.refundSafe).toBe(true);
  });

  it('forbids a refund while a chargeback is open', () => {
    const analysis = analyseDisputes([disputed()], [dispute()], null, NOW);

    expect(analysis.refundSafe).toBe(false);
    expect(analysis.open).toHaveLength(1);
    // The rule the whole module exists for, in the paragraph a model reads.
    expect(analysis.lines.join(' ')).toContain('do NOT offer, promise or imply a refund');
    expect(analysis.lines.join(' ')).toContain('withdraw the dispute with their bank');
  });

  it('reports the evidence deadline, and only while it is still ahead', () => {
    const ahead = dispute({ evidence_details: { due_by: NOW / 1000 + 86_400 } });
    expect(analyseDisputes([disputed()], [ahead], null, NOW).dueBy).toBe(NOW / 1000 + 86_400);

    const gone = dispute({ evidence_details: { due_by: NOW / 1000 - 86_400 } });
    // A date that has passed is not a deadline to work to; the dispute is
    // simply lost by default, and offering it as a target would be a lie.
    expect(analyseDisputes([disputed()], [gone], null, NOW).dueBy).toBeNull();
  });

  it('takes the soonest deadline when several are open', () => {
    const soon = dispute({ id: 'dp_1', evidence_details: { due_by: NOW / 1000 + 86_400 } });
    const later = dispute({ id: 'dp_2', charge: 'ch_2', evidence_details: { due_by: NOW / 1000 + 500_000 } });

    const analysis = analyseDisputes(
      [disputed('dp_1'), charge({ id: 'ch_2', disputed: true, dispute: 'dp_2' })],
      [soon, later],
      null,
      NOW,
    );

    expect(analysis.dueBy).toBe(NOW / 1000 + 86_400);
  });

  it('does not offer to refund money a lost chargeback already returned', () => {
    const analysis = analyseDisputes([disputed()], [dispute({ status: 'lost' })], null, NOW);

    // Closed, so a refund on some *other* charge is fine — but the reply must
    // not treat this one as still owed.
    expect(analysis.refundSafe).toBe(true);
    expect(analysis.lines.join(' ')).toContain('not owed it again');
  });

  it('calls a fraud warning a warning, not a chargeback', () => {
    const analysis = analyseDisputes(
      [disputed()],
      [dispute({ status: 'warning_needs_response' })],
      null,
      NOW,
    );

    expect(analysis.refundSafe).toBe(false);
    expect(analysis.lines.join(' ')).toContain('No money has moved yet');
    expect(analysis.headline).toContain('fraud warning');
  });

  it('holds the refund back when the dispute record could not be read', () => {
    // The narrow-key case. `disputed` on the charge needs no permission, so we
    // know a chargeback exists and nothing else — which is exactly the state in
    // which promising money is a coin flip.
    const analysis = analyseDisputes([disputed()], [], 'no permission', NOW);

    expect(analysis.unreadable).toBe(1);
    expect(analysis.refundSafe).toBe(false);
    expect(analysis.lines.join(' ')).toContain('do not promise a refund');
    expect(analysis.lines.join(' ')).toContain('no permission');
  });

  it('refuses a refund when Stripe itself says the charge is no longer refundable', () => {
    const analysis = analyseDisputes(
      [disputed()],
      [dispute({ status: 'under_review', is_charge_refundable: false })],
      null,
      NOW,
    );

    expect(analysis.refundSafe).toBe(false);
  });

  it('leads with what is open rather than with what is over', () => {
    const analysis = analyseDisputes(
      [disputed('dp_1'), charge({ id: 'ch_2', disputed: true, dispute: 'dp_2' })],
      [dispute({ id: 'dp_2', charge: 'ch_2', status: 'lost', created: 1_760_000_000 }), dispute()],
      null,
      NOW,
    );

    // One of each. The card has room for one line and it must be the live one.
    expect(analysis.open).toHaveLength(1);
    expect(analysis.settled).toHaveLength(1);
    expect(analysis.headline).toContain('chargeback open');
  });

  it('still mentions a past dispute when nothing is open', () => {
    const analysis = analyseDisputes([disputed()], [dispute({ status: 'won' })], null, NOW);

    expect(analysis.headline).toBe('1 past dispute(s)');
    // Not "we won". They paid and may believe they did not, which is a live
    // grievance whatever the card network decided.
    expect(analysis.lines.join(' ')).toContain('Treat any "I was charged anyway" as sincere');
  });
});
