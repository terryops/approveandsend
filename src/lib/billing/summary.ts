import {
  findCustomer,
  listCharges,
  listDisputes,
  listSubscriptions,
  type StripeCharge,
  type StripeCustomer,
  type StripeDispute,
  type StripeSubscription,
} from './stripe';

/**
 * The reads the sender card makes, as one answer it can be given twice.
 *
 * The card is a server component that asks Stripe while it renders, which is
 * the right shape for it — no job to have run, no config to have switched on,
 * correct on any screen that has an address. It has one consequence, and the
 * confirmation panel is where it bites: `?confirm=1` is a flag on the task
 * route rather than a route of its own, so pressing Preview re-renders the
 * whole review screen underneath the scrim, card included. Measured against a
 * translator-shaped stub pinned at two seconds, every press of Preview held the
 * response open for the length of a fresh Stripe round trip — and the panel it
 * opens has nothing to do with billing. The work was not slow so much as
 * repeated.
 *
 * So the answer is remembered for a minute. Two renders seconds apart are two
 * renders of the same screen, and asking a third party twice for what it said
 * the first time is not diligence.
 *
 * ## What is deliberately not cached
 *
 * `/billing/<address>` keeps calling `findCustomer`, `listSubscriptions` and
 * `listCharges` directly and is not routed through here. That page is where
 * somebody decides whether a refund has already been given, and the difference
 * between a summary that is a minute stale and a list that is a minute stale is
 * the difference between a rounded total and a payment that is not on it.
 *
 * A failure is not cached either. An outage that stuck for a minute would
 * outlive itself: the reviewer would press reload, get the same sentence about
 * Stripe being unreachable, and have no way of telling a service that is down
 * from a card that has stopped asking.
 *
 * ## Why a plain Map
 *
 * `use cache` is the framework's answer and it needs `cacheComponents: true`,
 * which changes the prerendering model of every page in the app. That is not a
 * proportionate thing to turn on for one card. React's `cache()` is the other
 * candidate and is per-request: it would collapse two reads inside one render
 * and do nothing at all for the case here, which is two renders a second apart.
 *
 * Per process, so several workers each keep their own — which is correct rather
 * than merely acceptable: this is a memo and not a source of truth, and nothing
 * downstream is allowed to assume two processes agree about it.
 */

export interface CustomerSummary {
  /** Null when Stripe has no record of this address — itself worth showing. */
  customer: StripeCustomer | null;
  subscriptions: StripeSubscription[];
  charges: StripeCharge[];
  /** Only the ones a charge pointed at, and only if the key may read them. */
  disputes: StripeDispute[];
  /** Stripe's words when it would not hand the disputes over. */
  disputesRefused: string | null;
}

/**
 * A minute.
 *
 * Long enough that pressing Preview, reading the panel and coming back is one
 * lookup rather than three, and short enough that a subscription cancelled
 * while somebody is drafting is on the screen by the time they send. The number
 * that matters is the first one: the repeats this exists to stop are seconds
 * apart, not minutes.
 */
const TTL_MS = 60_000;

/**
 * How many addresses are worth remembering at once.
 *
 * The desk that walks a hundred tasks with `J` is the reason there is a cap at
 * all — without one this grows with every distinct correspondent for the life
 * of the process. Oldest written goes first, which is near enough to
 * least-recently-useful for a map this size and does not need a second
 * structure to maintain.
 */
const MAX_ENTRIES = 200;

const remembered = new Map<string, { at: number; summary: CustomerSummary }>();

/** Addresses differ in case and in the spaces around them; Stripe's do not. */
function key(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The card's read, from memory where there is one.
 *
 * `now` is a parameter so the expiry can be tested without waiting a minute or
 * standing a fake clock up over the whole module.
 */
export async function customerSummary(
  email: string,
  now: number = Date.now(),
): Promise<CustomerSummary> {
  const id = key(email);
  const held = remembered.get(id);
  if (held && now - held.at < TTL_MS) return held.summary;

  const customer = await findCustomer(email);
  // Not a customer is an answer, and an answer worth remembering: on most desks
  // it is the common one, and it costs exactly as much to fetch as the other.
  const summary: CustomerSummary = customer
    ? {
        customer,
        ...(await twoLists(customer.id)),
      }
    : { customer: null, subscriptions: [], charges: [], disputes: [], disputesRefused: null };

  // Written only once the reads have all succeeded — a half-answer in here
  // would be served for a minute as though it were the whole one.
  remembered.set(id, { at: now, summary });
  if (remembered.size > MAX_ENTRIES) {
    const oldest = remembered.keys().next();
    if (!oldest.done) remembered.delete(oldest.value);
  }
  return summary;
}

async function twoLists(customerId: string): Promise<Omit<CustomerSummary, 'customer'>> {
  const [subscriptions, charges] = await Promise.all([
    listSubscriptions(customerId),
    // `listCharges`'s own default, which is what `/billing/<address>` reads. The
    // context source takes 20 and is right to — it is writing a sentence for a
    // model. This total is a link away from the list it summarises, and one that
    // disagrees with the page it opens is worse than no total.
    listCharges(customerId),
  ]);

  // A third read, and usually not a read at all: `listDisputes` returns
  // immediately unless a charge is flagged, which on most customers none is.
  // It cannot run beside the other two because it is driven by what the
  // charges say.
  const { disputes, refused } = await listDisputes(charges);

  return { subscriptions, charges, disputes, disputesRefused: refused };
}

/** For tests, and for nothing else: there is no correctness reason to clear this. */
export function forgetCustomerSummaries(): void {
  remembered.clear();
}
