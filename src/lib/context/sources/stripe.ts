import { analyseDisputes, type DisputeAnalysis } from '../../billing/disputes';
import { getWorkspaceConfig } from '../../config/workspace';
import {
  DASHBOARD,
  chargeState,
  day,
  findCustomer,
  listCharges,
  listDisputes,
  listSubscriptions,
  money,
  netPaid,
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
 * Two kinds of sentence, and the difference between them is the whole design.
 *
 * The judgements — "lapsed two weeks ago", "do not talk to them as a current
 * subscriber", "there is a chargeback here" — are written here, because they
 * are decisions the desk has already taken and should not be retaken on every
 * draft. The record is not: charges go in one per line, all of them, dated,
 * because which charge matters depends on the letter and this function has not
 * read it.
 */
/** One dated line per charge, including the ones that failed. */
function chargeLine(charge: StripeCharge): string {
  const when = day(charge.created);
  const amount = money(charge.amount, charge.currency);
  switch (chargeState(charge)) {
    case 'paid':
      return `${when} ${amount} paid`;
    case 'refunded':
      return `${when} ${amount} refunded in full`;
    case 'partial':
      return `${when} ${amount} partially refunded (${money(charge.amount_refunded ?? 0, charge.currency)} returned)`;
    default:
      return `${when} ${amount} attempted and failed`;
  }
}

function describe(
  customer: StripeCustomer,
  subscriptions: StripeSubscription[],
  charges: StripeCharge[],
  disputes: DisputeAnalysis,
): string {
  const lines: string[] = [];
  const active = subscriptions.filter(s => s.status === 'active' || s.status === 'trialing');

  // First, because it is the only part of this paragraph that forbids a
  // sentence rather than informing one. Buried under three lines about plans
  // and totals it reads as background; a model that has already decided to
  // offer a refund by the time it gets here has to change its mind, and
  // changing its mind is the step that does not reliably happen.
  lines.push(...disputes.lines);

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

  // The record itself, whole, in the order it happened.
  //
  // This used to be three summaries — total paid, how many refunded, how many
  // partially — and between them they lost the one fact a refund thread turns
  // on: when money last moved. A refunded charge left the paid bucket, so
  // "the most recent" named the most recent charge *still standing*; on a
  // monthly subscription whose latest cycle had just been refunded that was a
  // date from a month ago, and the model duly told the customer their last
  // payment was in July. A failed charge was in no bucket at all and vanished,
  // which is how "we tried to bill you on the 18th and it bounced" becomes a
  // silence on a screen about billing.
  //
  // The reviewer has always been able to open `/billing/<address>` and read
  // every charge and refund; the model was the only party to this conversation
  // working from a précis. Summarising is the step that dropped the facts, and
  // no better summary fixes that — every one of them is a guess about which
  // question the letter is going to ask. So the ledger goes in as a ledger,
  // and the interpreting happens where the letter is, with all of it visible.
  //
  // Uncapped, because `listCharges` is what bounds this and the bound belongs
  // there: a lookup that quietly stopped at the tenth charge would be the same
  // bug in a smaller font.
  if (charges.length > 0) {
    lines.push(`Every charge on the account, newest first: ${charges.map(chargeLine).join('; ')}.`);
  }

  // What the ledger cannot say, because it is arithmetic across currencies and
  // an arithmetic mistake here is a sentence about somebody's money.
  const kept = netPaid(charges);
  if (kept.size > 0) {
    const totals = [...kept].map(([currency, amount]) => money(amount, currency)).join(', ');
    lines.push(`Net of every refund they have kept paying ${totals}.`);
  }

  // Not a fact — an instruction, and the most expensive one on this card. A
  // partial refund described as a refund is how somebody gets told their money
  // is on the way back when half of it is not.
  if (charges.some(c => chargeState(c) === 'partial')) {
    lines.push(
      'Some of that was refunded in part, not in full — do not describe a partial refund as a refund.',
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
      // Uncapped, so the paragraph below is the whole record rather than a
      // window onto it. `listCharges` stops at fifty, which on this desk is
      // years of a monthly subscription.
      listCharges(customer.id),
    ]);

    // After the charges rather than beside them: a dispute is found by
    // following `charge.dispute`, so there is nothing to ask for until the
    // charges are back. Costs nothing on the overwhelming majority of lookups,
    // where no charge is flagged and no request is made at all.
    const { disputes: raw, refused } = await listDisputes(charges);
    const disputes = analyseDisputes(charges, raw, {
      refused,
      // The desk's policy, not the model's judgement. Whether a refund may be
      // offered for a withdrawal is a business decision somebody made once;
      // leaving it to be inferred from the letter would make it a decision
      // taken afresh on every draft.
      offerRefundOnWithdrawal: getWorkspaceConfig().refundOnDisputeWithdrawal,
    });

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

    // High enough in the card to be read before the reviewer starts typing.
    // The fields below it are conveniences; this one is the reason the reply
    // might have to be a different reply.
    if (disputes.headline) {
      fields.push({
        label: 'Dispute',
        value: disputes.dueBy
          ? `${disputes.headline} · evidence due ${day(disputes.dueBy)}`
          : disputes.headline,
        href: `${DASHBOARD}/${customer.id}`,
      });
    }

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
      prompt: describe(customer, subscriptions, charges, disputes),
    };
  },
};
