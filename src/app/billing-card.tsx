import Link from 'next/link';
import { Suspense } from 'react';

import { analyseDisputes } from '@/lib/billing/disputes';
import { DASHBOARD, day, money, netPaid, planOf, stripeConfigured } from '@/lib/billing/stripe';
import { customerSummary } from '@/lib/billing/summary';
import { t } from '@/lib/i18n';

/**
 * Who this address is to Stripe, on the screens where that changes the answer.
 *
 * The two questions a reviewer asks about a stranger are "what have we told
 * them before" and "what are they worth to us", and only the first had anything
 * on the page. The second lived one navigation away on `/billing/<address>`,
 * behind a link in a sentence, which is far enough that nobody follows it while
 * deciding whether to promise a refund — and the whole cost of not following it
 * lands in the reply.
 *
 * Four facts and two doors. The facts are the ones that change what a reply may
 * safely say: who they are, since when, what they are on, and what has actually
 * stayed with us after refunds. The doors are the two places the rest of the
 * answer lives — the charge-by-charge list this desk renders, and Stripe's own
 * record, which is where anybody who needs to *do* something is going anyway.
 *
 * ## Read here rather than through a context source
 *
 * `stripeSource` exists and writes a card of its own, and this is deliberately
 * not that. A context source runs in the enrichment job, which means it answers
 * for tasks the queue has been through and says nothing on a sender page, which
 * has no task and no job. It also has to be switched on in `contextSources`,
 * where the default is nothing at all. This asks Stripe at render time, which
 * is the same thing `/billing/<address>` has always done, and so it is right
 * wherever there is an address — with or without a queue behind it.
 *
 * Where both are on, the review screen shows one of them; see the note at the
 * call site.
 *
 * ## Why it cannot be awaited
 *
 * Three HTTPS calls to a third party with an eight-second timeout, on screens
 * whose own render is a read of a local file. Awaited inline, a Stripe outage
 * would be a review screen that takes eight seconds to appear — the desk's
 * central screen held up by a lookup that is beside the point on most tasks.
 * Behind a boundary it is late rather than blocking, which is the correct
 * severity for the fourth thing on a page.
 *
 * The `stripeConfigured` check is outside the boundary on purpose: it reads
 * config and touches no network, so a desk with no Stripe key renders no card,
 * no boundary and no placeholder, rather than a box that exists to say it has
 * nothing to say.
 */
export function BillingCard({ email }: { email: string }) {
  if (!stripeConfigured()) return null;

  return (
    <Suspense
      fallback={
        <div className="card">
          <h2 style={{ margin: 0 }}>{t('billing.card.title')}</h2>
          <p className="meta">{t('billing.card.loading')}</p>
        </div>
      }
    >
      <Customer email={email} />
    </Suspense>
  );
}

async function Customer({ email }: { email: string }) {
  // One read, and remembered for a minute — see `customerSummary`. `?confirm=1`
  // is a flag on this same route, so pressing Preview re-renders this card
  // underneath the scrim on a panel that has nothing to do with billing; asking
  // Stripe again for what it said two seconds ago was holding that press open
  // for a whole round trip.
  let summary;
  try {
    summary = await customerSummary(email);
  } catch (error) {
    // A card that renders a stack trace is a card people learn to scroll past.
    // Say which system is unreachable and leave the screen usable — every other
    // thing on it is a read of the local database and is still true.
    return (
      <div className="card">
        <h2 style={{ margin: 0 }}>{t('billing.card.title')}</h2>
        <p className="meta">
          {t('billing.unreachable', { error: error instanceof Error ? error.message : 'unknown' })}
        </p>
      </div>
    );
  }

  // Said rather than left out. An address with no billing record is a fact
  // about the reply being written — and a card that simply does not appear is
  // indistinguishable from a lookup that never ran, which is the reading that
  // gets somebody to promise a refund on an account that does not exist.
  //
  // The sentence is the billing page's own, and it is careful for a reason: not
  // "they never paid us", because they may well have, under the address on
  // their card rather than the one they write from.
  const { customer, subscriptions, charges, disputes: raw, disputesRefused } = summary;
  if (!customer) {
    return (
      <div className="card">
        <h2 style={{ margin: 0 }}>{t('billing.card.title')}</h2>
        <p className="meta">{t('billing.noCustomer')}</p>
      </div>
    );
  }

  const net = netPaid(charges);
  const disputes = analyseDisputes(charges, raw, disputesRefused);
  // The one they are on. More than one is rare and the card is not the place
  // for the rest of them — that is what the page behind the link is.
  const plan = subscriptions[0] ? planOf(subscriptions[0]) : null;

  return (
    <div className="card">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {t('billing.card.title')}
        </h2>
        {/* Stripe's own record. `_blank`, because this is where somebody goes to
            *act* — refund, cancel, look at a dispute — and losing the reply they
            were half way through writing to do it would be the second thing
            they learn about this link and the last time they use it. */}
        <a
          className="card-open"
          href={`${DASHBOARD}/${customer.id}`}
          target="_blank"
          rel="noreferrer"
        >
          {t('billing.card.open')}
        </a>
      </div>

      {/* Above the facts, and not one of them.

          Every row below answers "who is this"; this answers "what may this
          reply not say", which is a different kind of thing and the only one on
          the card that can cost money by being read late. In the row with the
          plan name and the total it would sit at the weight of a plan name —
          and a reviewer scanning four facts for the one they came for is
          exactly who does not notice a fifth. */}
      {(disputes.open.length > 0 || disputes.unreadable > 0) && (
        <p className="wrong" style={{ margin: 0 }}>
          {t('billing.dispute.banner', { what: disputes.headline ?? '' })}
          {disputes.dueBy ? ` ${t('billing.dispute.due', { date: day(disputes.dueBy) })}` : ''}
        </p>
      )}

      {/* The same list the context cards use, so on the review screen this reads
          as one more thing known about the sender rather than as a widget. */}
      <dl className="facts">
        <div>
          <dt>{t('billing.card.customer')}</dt>
          <dd>{customer.name || customer.email || customer.id}</dd>
        </div>
        <div>
          <dt>{t('billing.card.since')}</dt>
          <dd>{day(customer.created)}</dd>
        </div>
        {plan && (
          <div>
            <dt>{t('billing.card.plan')}</dt>
            <dd>{plan}</dd>
          </div>
        )}
        {net.size > 0 && (
          <div>
            {/* Kept, not charged. The gross is the number that talks a desk into
                treating somebody as a large customer they have already refunded
                in full. */}
            <dt>{t('billing.card.kept')}</dt>
            <dd>{[...net].map(([currency, amount]) => money(amount, currency)).join(', ')}</dd>
          </div>
        )}
        {/* The one fact here that is not neutral. A failed payment is the
            difference between "sorry about the delay" and "your card was
            declined on the 3rd", and it was sitting in the row at the same
            weight as the plan name. `wrong` colours it; the label and the
            sentence are what carry it where colour cannot. */}
        {customer.delinquent && (
          <div className="wrong">
            <dt>{t('billing.card.status')}</dt>
            <dd>{t('billing.delinquent')}</dd>
          </div>
        )}
        {/* Settled ones, which are history rather than a constraint — and
            history that changes the tone of a reply: somebody who has charged
            back before is somebody whose next "just refund me" is a threat with
            a precedent. Only shown when nothing is open, because then the
            banner above has already said it. */}
        {disputes.open.length === 0 && disputes.settled.length > 0 && (
          <div>
            <dt>{t('billing.card.disputes')}</dt>
            <dd>{disputes.headline}</dd>
          </div>
        )}
      </dl>

      {/* The charge-by-charge list, which is the question this card raises and
          does not answer: never the total, always *which* payment, on what day,
          and how much of it has already gone back. A `Link` and not an anchor —
          it is this desk's own screen, and it should arrive the way every other
          screen here does. */}
      <p className="meta">
        <Link href={`/billing/${encodeURIComponent(email)}`}>{t('billing.card.history')}</Link>
      </p>
    </div>
  );
}
