import {
  DASHBOARD,
  chargeState,
  day,
  findCustomer,
  listCharges,
  listSubscriptions,
  money,
  planOf,
  stripeConfigured,
  type StripeCharge,
  type StripeCustomer,
  type StripeSubscription,
} from '../../billing/stripe';
import type { ContextBlock, ContextField, ContextSource, LookupSubject } from '../types';

/**
 * Who this person is to the billing system.
 *
 * Three reads, turned into a paragraph. The client itself lives in
 * `lib/billing/stripe.ts`, because the billing page makes the same three reads
 * and wants a table out of them rather than prose.
 */

/**
 * The paragraph the model reads.
 *
 * Written as claims a person would make, not as a record dump: "lapsed two
 * weeks ago" is actionable, `"status": "canceled"` needs interpreting, and the
 * interpreting is this function's job rather than the model's.
 */
function describe(
  customer: StripeCustomer,
  subscriptions: StripeSubscription[],
  charges: StripeCharge[],
): string {
  const lines: string[] = [];
  const active = subscriptions.filter(s => s.status === 'active' || s.status === 'trialing');

  lines.push(`Customer since ${day(customer.created)}.`);

  if (active.length > 0) {
    for (const subscription of active) {
      const ending = subscription.cancel_at_period_end
        ? `set to end on ${day(subscription.current_period_end)}`
        : `renews ${day(subscription.current_period_end)}`;
      lines.push(
        `Has an ${subscription.status} subscription (${planOf(subscription)}), ${ending}.`,
      );
    }
  } else if (subscriptions.length > 0) {
    const last = subscriptions[0]!;
    lines.push(
      `No active subscription — the most recent one is ${last.status}, last period ended ${day(last.current_period_end)}. Do not talk to them as a current subscriber.`,
    );
  } else {
    lines.push('Has never had a subscription. Do not assume they are paying for anything.');
  }

  const paid = charges.filter(c => chargeState(c) === 'paid');
  if (paid.length > 0) {
    const byCurrency = new Map<string, number>();
    for (const charge of paid) {
      byCurrency.set(charge.currency, (byCurrency.get(charge.currency) ?? 0) + charge.amount);
    }
    const totals = [...byCurrency].map(([currency, amount]) => money(amount, currency)).join(', ');
    lines.push(`Has paid ${totals} across ${paid.length} charge(s); the most recent was ${day(paid[0]!.created)}.`);
  }

  // Both kinds, and separately. A partial refund described as a refund is how
  // somebody gets told their money is on the way back when half of it is not,
  // and it is the single most expensive sentence a support desk can write.
  const full = charges.filter(c => chargeState(c) === 'refunded');
  const partial = charges.filter(c => chargeState(c) === 'partial');
  if (full.length > 0) {
    lines.push(`${full.length} of their charges has already been refunded in full.`);
  }
  if (partial.length > 0) {
    const given = partial.map(c => money(c.amount_refunded ?? 0, c.currency)).join(', ');
    lines.push(
      `${partial.length} more has been partially refunded (${given} returned so far) — do not describe those as refunded.`,
    );
  }

  if (customer.delinquent) {
    lines.push('Their latest payment attempt failed, so the account may be past due.');
  }

  return lines.join(' ');
}

export const stripeSource: ContextSource = {
  id: 'stripe',
  label: 'Billing (Stripe)',

  configured: stripeConfigured,

  async lookup(subject: LookupSubject): Promise<ContextBlock | null> {
    const customer = await findCustomer(subject.email);
    // Not an error. Most people who write in have never paid for anything, and
    // "this person is not a customer" is itself worth telling the model.
    if (!customer) {
      return {
        title: 'Billing (Stripe)',
        fields: [{ label: 'Customer', value: 'none found' }],
        prompt:
          'This address does not exist in the billing system. They may never have bought anything, or may have paid under a different address — do not assert either.',
      };
    }

    const [subscriptions, charges] = await Promise.all([
      listSubscriptions(customer.id),
      listCharges(customer.id, 20),
    ]);

    const active = subscriptions.find(s => s.status === 'active' || s.status === 'trialing');
    const paid = charges.filter(c => chargeState(c) === 'paid');

    const fields: ContextField[] = [
      { label: 'Customer', value: customer.name ?? customer.id, href: `${DASHBOARD}/${customer.id}` },
      { label: 'Since', value: day(customer.created) },
      {
        label: 'Subscription',
        value: active ? `${planOf(active)} · ${active.status}` : 'none active',
      },
    ];

    if (active) {
      fields.push({
        label: active.cancel_at_period_end ? 'Ends' : 'Renews',
        value: day(active.current_period_end),
      });
    }
    if (paid.length > 0) {
      const first = paid[0]!;
      fields.push({
        label: 'Paid',
        value: `${money(paid.reduce((sum, c) => sum + c.amount, 0), first.currency)} · ${paid.length} charge(s)`,
      });
    }
    if (customer.delinquent) fields.push({ label: 'Status', value: 'payment failed' });

    // The way in to the charge-by-charge screen. A card is a summary by
    // design, and the question that follows a summary in a billing thread is
    // always "which payment, and how much of it came back" — the one thing a
    // sentence about totals cannot answer.
    if (subject.email.trim()) {
      fields.push({
        label: 'Payments',
        value: 'every charge and refund',
        href: `/billing/${encodeURIComponent(subject.email.trim())}`,
      });
    }

    return {
      title: 'Billing (Stripe)',
      href: `${DASHBOARD}/${customer.id}`,
      fields,
      prompt: describe(customer, subscriptions, charges),
    };
  },
};
