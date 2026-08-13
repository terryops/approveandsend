import Link from 'next/link';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import { analyseDisputes, disputeState, reasonOf } from '@/lib/billing/disputes';
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
  stripeKey,
} from '@/lib/billing/stripe';
import { t } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * What this address actually paid, charge by charge.
 *
 * The context card on a task says "has paid 240 USD across 3 charges", which is
 * the right amount of billing for a model writing a reply. It is not enough for
 * the reviewer about to promise somebody a refund, because the question at that
 * moment is never the total — it is *which* payment, on what day, and how much
 * of it has already gone back. Answering that from a total is how a desk
 * refunds the same charge twice.
 *
 * Looked up by email, exactly as the context source does, so nothing has to be
 * stored or plumbed through: the address on the task is the whole input, and a
 * customer id cached at ingest time would be a copy that can go stale.
 *
 * Read-only, deliberately. Refunding from here would be one misclick from
 * giving away money, and Stripe's own dashboard — linked at the top — already
 * does it with a confirmation step and an audit trail we would be reinventing.
 */

export default async function BillingPage({ params }: { params: Promise<{ email: string }> }) {
  await requirePage();

  const { email: raw } = await params;
  const email = decodeURIComponent(raw).trim();

  const back = (
    <p className="meta">
      <Link href={`/senders/${encodeURIComponent(email)}`}>{t('billing.backToSender')}</Link>
    </p>
  );

  // Two different answers. "No key is set" sends somebody to go and find one;
  // "somebody switched this off" sends them to the checkbox that did it, which
  // is a thirty-second fix they would otherwise spend the afternoon not finding.
  if (!stripeConfigured()) {
    return (
      <>
        {back}
        <h1>{email}</h1>
        <p className="meta">{stripeKey() ? t('billing.switchedOff') : t('billing.notConfigured')}</p>
        {/* Said to everyone, fixed by an admin. The sentence above is why this
            screen is empty and is worth reading either way; the link under it
            is a screen a reviewer cannot open. */}
        {(await isAdmin()) && (
          <p className="meta">
            <Link href="/setup?where=billing">{t('billing.index.settings')}</Link>
          </p>
        )}
      </>
    );
  }

  // A billing screen that renders a stack trace when Stripe is slow is a
  // billing screen the reviewer stops opening. Say what failed and let them
  // carry on in the dashboard.
  let customer;
  try {
    customer = await findCustomer(email);
  } catch (error) {
    return (
      <>
        {back}
        <h1>{email}</h1>
        <p className="meta">
          {t('billing.unreachable', { error: error instanceof Error ? error.message : 'unknown' })}
        </p>
      </>
    );
  }

  if (!customer) {
    return (
      <>
        {back}
        <h1>{email}</h1>
        {/* Not "they never paid us". They may well have, under the address on
            their card rather than the one they write from, and a reviewer who
            reads this as "not a customer" will say so out loud. */}
        <p className="meta">{t('billing.noCustomer')}</p>
      </>
    );
  }

  const [subscriptions, charges] = await Promise.all([
    listSubscriptions(customer.id),
    listCharges(customer.id),
  ]);

  const net = netPaid(charges);

  // Read here rather than through `customerSummary` for the same reason the
  // charges are: this is the screen somebody opens to decide whether to give
  // money back, and a minute-old answer to "is the bank already taking it" is
  // the wrong kind of nearly right.
  const { disputes: records, refused } = await listDisputes(charges);
  const disputes = analyseDisputes(charges, records, refused);

  return (
    <>
      {back}

      <h1>{customer.name || email}</h1>
      <p className="meta">
        {t('billing.since', { date: day(customer.created) })}
        {' · '}
        <a href={`${DASHBOARD}/${customer.id}`} target="_blank" rel="noreferrer">
          {customer.id}
        </a>
        {customer.delinquent ? ` · ${t('billing.delinquent')}` : ''}
      </p>

      {net.size > 0 && (
        <p className="meta">
          {t('billing.net', {
            totals: [...net].map(([currency, amount]) => money(amount, currency)).join(', '),
          })}
        </p>
      )}

      {/* First, and only when there is one.

          A customer with no chargebacks is nearly all of them, and a permanent
          empty "Disputes" heading on every billing screen is how the heading
          stops being read on the screen where it is not empty. Above the
          subscriptions because it outranks them: the question this page is open
          to answer is usually "can I refund this", and a live dispute answers it
          before the plan name is relevant. */}
      {disputes.headline && (
        <>
          <h2>{t('billing.disputes')}</h2>
          <div className="card">
            {!disputes.refundSafe && (
              <p className="wrong" style={{ marginTop: 0 }}>
                {t('billing.dispute.warning')}
              </p>
            )}
            <ul className="list">
              {records.map(dispute => (
                <li key={dispute.id}>
                  <div className="row">
                    <span className="subject grow">
                      {money(dispute.amount, dispute.currency)} · {reasonOf(dispute)}
                    </span>
                    <span className="tag">{t(`billing.dispute.state.${disputeState(dispute)}`)}</span>
                  </div>
                  <div className="meta">
                    {t('billing.dispute.filed', { date: day(dispute.created) })}
                    {/* The date the money is lost by default. Shown whether or
                        not it has passed — a deadline that went by yesterday is
                        the reason a reviewer is about to be surprised. */}
                    {dispute.evidence_details?.due_by
                      ? ` · ${t('billing.dispute.due', { date: day(dispute.evidence_details.due_by) })}`
                      : ''}
                  </div>
                </li>
              ))}
            </ul>
            {disputes.unreadable > 0 && (
              <p className="meta">
                {t('billing.dispute.unreadable', { count: String(disputes.unreadable) })}
                {refused ? ` (${refused})` : ''}
              </p>
            )}
          </div>
        </>
      )}

      <h2>{t('billing.subscriptions')}</h2>
      <div className="card">
        {subscriptions.length === 0 ? (
          <p className="meta">{t('billing.noSubscriptions')}</p>
        ) : (
          <ul className="list">
            {subscriptions.map(subscription => (
              <li key={subscription.id}>
                <div className="row">
                  <span className="subject grow">{planOf(subscription)}</span>
                  <span className="tag">{subscription.status}</span>
                </div>
                <div className="meta">
                  {subscription.cancel_at_period_end
                    ? t('billing.ends', { date: day(subscription.current_period_end) })
                    : t('billing.renews', { date: day(subscription.current_period_end) })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>{t('billing.charges')}</h2>
      <div className="card">
        {charges.length === 0 ? (
          <p className="meta">{t('billing.noCharges')}</p>
        ) : (
          <ul className="list">
            {charges.map(charge => {
              const state = chargeState(charge);
              const given = charge.amount_refunded ?? 0;
              return (
                <li key={charge.id}>
                  <div className="row">
                    <span className="subject grow">
                      {money(charge.amount, charge.currency)}
                      {charge.description ? ` · ${charge.description}` : ''}
                    </span>
                    {/* The word for what happened, spelled out. "partially
                        refunded" is a different promise from "refunded", and
                        the difference is the money still being held. */}
                    <span className="tag">{t(`billing.state.${state}`)}</span>
                    {/* A second tag rather than a fifth `ChargeState`. A
                        disputed charge is still whatever it was — paid, or half
                        refunded — and folding the dispute into that word would
                        lose the one the refund decision is made from. */}
                    {(charge.disputed || charge.dispute) && (
                      <span className="tag wrong">{t('billing.state.disputed')}</span>
                    )}
                  </div>
                  <div className="meta">
                    {day(charge.created)}
                    {given > 0
                      ? ` · ${t('billing.returned', { amount: money(given, charge.currency) })}`
                      : ''}
                    {charge.receipt_url ? ' · ' : ''}
                    {charge.receipt_url && (
                      <a href={charge.receipt_url} target="_blank" rel="noreferrer">
                        {t('billing.receipt')}
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
