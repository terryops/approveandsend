/**
 * The Stripe reads, in one place.
 *
 * Two callers want them and want different things from them. The context
 * source turns three GETs into a paragraph a model can act on; the billing
 * page turns the same GETs into a table a person can scan. Neither is the
 * other's summary, so the shared thing is the client rather than the answer.
 *
 * Read-only throughout, and it should stay that way. Make the key restricted
 * and give it read on customers, subscriptions and charges — nothing here
 * writes, so nothing here needs write. `/v1/customers?email=` rather than
 * `/v1/customers/search` for the same reason: search needs a broader
 * permission than the narrowest key Stripe will issue.
 */

const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 8_000;

export const DASHBOARD = 'https://dashboard.stripe.com/customers';

export interface StripeCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
  created: number;
  currency?: string | null;
  delinquent?: boolean | null;
}

export interface StripeSubscription {
  id: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items?: {
    data?: {
      price?: {
        nickname?: string | null;
        unit_amount?: number | null;
        currency?: string;
        recurring?: { interval?: string } | null;
      } | null;
    }[];
  };
}

export interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  paid: boolean;
  refunded: boolean;
  created: number;
  status: string;
  /** Minor units already given back. Non-zero with `refunded: false` is a partial. */
  amount_refunded?: number;
  description?: string | null;
  receipt_url?: string | null;
  /**
   * The bank was asked to take it back.
   *
   * Stays true after the dispute closes, whichever way it went, so this is
   * "there is a dispute on this charge" and never "the money is gone". Which
   * of those it is takes the dispute itself.
   */
  disputed?: boolean;
  /** The dispute id, unexpanded. Null on a charge nobody has challenged. */
  dispute?: string | null;
  /**
   * What this charge looks like on their bank statement.
   *
   * The most useful sentence in a reply to somebody who has disputed a payment
   * they did not recognise, and one a support desk almost never has to hand:
   * the customer is looking at a line of capitals that is not the product's
   * name, and neither party thinks to compare them.
   */
  calculated_statement_descriptor?: string | null;
}

/**
 * A chargeback, or the warning that one is coming.
 *
 * The one billing fact that changes what a reply is allowed to offer. Every
 * other read here answers "what is this person owed"; this one answers "is
 * their bank already taking it", and the answer forbids sentences the rest of
 * the record would happily support.
 */
export interface StripeDispute {
  id: string;
  /** The charge id, unexpanded — this is looked up from a charge, not to one. */
  charge: string;
  amount: number;
  currency: string;
  /** Stripe's code: `fraudulent`, `product_not_received`, `duplicate`, … */
  reason: string;
  status: string;
  created: number;
  evidence_details?: {
    /** Epoch seconds. Miss it and the dispute is lost by default. */
    due_by?: number | null;
    has_evidence?: boolean;
    submission_count?: number;
  } | null;
  /**
   * Whether Stripe would still let you refund the charge.
   *
   * False on most open disputes, and it is the API saying out loud what a desk
   * keeps trying to do anyway: refunding a charge whose money the bank is
   * already reversing is how the same payment leaves twice.
   */
  is_charge_refundable?: boolean;
}

/**
 * One product in the catalogue.
 *
 * Read from `/v1/products`, which is a different permission from the three
 * reads above: those answer "who is this person", this one answers "what do we
 * sell". A key with only the customer scopes returns 403 here, and the
 * catalogue screen says so rather than showing an empty list.
 */
export interface StripeProduct {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  created: number;
  /** What one unit is called — "per seat", "per 1000 credits". */
  unit_label?: string | null;
}

export interface StripePrice {
  id: string;
  /** The product id. A string because nothing here expands it. */
  product: string;
  active: boolean;
  currency: string;
  /** Null on tiered and metered prices, which have no single number. */
  unit_amount?: number | null;
  nickname?: string | null;
  type?: string;
  recurring?: { interval?: string; interval_count?: number } | null;
}

export function stripeKey(): string {
  return process.env.STRIPE_API_KEY?.trim() ?? '';
}

/** Which set of books the key opens. Null when there is no key to ask. */
export type StripeMode = 'live' | 'test';

/**
 * Live or test, read off the key itself.
 *
 * Worth saying out loud on the settings screen, because the failure it catches
 * is silent: a test key on a production desk finds no customer for anybody who
 * ever paid, and every reply then goes out saying "no billing record for this
 * address" — which reads like an answer rather than like a misconfiguration.
 */
export function stripeMode(): StripeMode | null {
  const key = stripeKey();
  if (key.includes('_live_')) return 'live';
  if (key.includes('_test_')) return 'test';
  return null;
}

/** `rk_`, the narrow kind. See the note at the top of this file. */
export function stripeRestricted(): boolean {
  return stripeKey().startsWith('rk_');
}

const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * The switch, which is not the key.
 *
 * Turning billing off by deleting the key means finding it again to turn it
 * back on, so the desk that wants to stop sending customer money facts to a
 * model for an afternoon ends up either not doing it or losing the credential.
 * `STRIPE_ENABLED=0` is the afternoon; the key stays where it is.
 *
 * Unset means on, so an install that set only `STRIPE_API_KEY` — every install
 * that existed before this switch did — behaves exactly as it did before.
 */
export function stripeOn(): boolean {
  const value = process.env.STRIPE_ENABLED?.trim().toLowerCase() ?? '';
  return value === '' || !OFF.has(value);
}

export function stripeConfigured(): boolean {
  return stripeKey() !== '' && stripeOn();
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${stripeKey()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(detail?.error?.message ?? `Stripe responded ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function findCustomer(email: string): Promise<StripeCustomer | null> {
  const found = await get<{ data: StripeCustomer[] }>(
    `/customers?email=${encodeURIComponent(email)}&limit=1`,
  );
  return found.data[0] ?? null;
}

export async function listSubscriptions(customerId: string): Promise<StripeSubscription[]> {
  const found = await get<{ data: StripeSubscription[] }>(
    `/subscriptions?customer=${customerId}&status=all&limit=10`,
  );
  return found.data;
}

/**
 * Their charges, newest first.
 *
 * Charges rather than invoices, though the screen this feeds is about
 * billing: an invoice says what was owed and a charge says what was taken and
 * how much of it came back. In a refund thread — which is most of them — the
 * second question is the one being asked.
 */
export async function listCharges(customerId: string, limit = 50): Promise<StripeCharge[]> {
  const found = await get<{ data: StripeCharge[] }>(
    `/charges?customer=${customerId}&limit=${limit}`,
  );
  return found.data;
}

/**
 * The disputes on a set of charges, newest first.
 *
 * Read one at a time off `charge.dispute` rather than from `/v1/disputes`,
 * because that list has no `customer` filter: answering "has this person been
 * charged back" from it means paging the whole desk's disputes and matching on
 * charge ids we already hold. A customer with a dispute usually has exactly
 * one, so this is normally one extra GET and often none.
 *
 * `disputes` is a permission of its own, and one an install granted before this
 * existed will not have. Rather than fail the lookup, a refusal comes back as
 * `refused` — the caller still knows a dispute exists, because `charge.disputed`
 * said so without needing any permission at all, and "there is a chargeback
 * here, unreadable from this key" is the sentence that keeps a reply safe. A
 * lookup that threw instead would take the whole billing card down with it and
 * say nothing.
 */
export async function listDisputes(
  charges: StripeCharge[],
): Promise<{ disputes: StripeDispute[]; refused: string | null }> {
  const ids = charges
    .filter(charge => charge.disputed || charge.dispute)
    .map(charge => (typeof charge.dispute === 'string' ? charge.dispute : null))
    .filter((id): id is string => id !== null)
    // Newest charge first is the order `listCharges` returns, and a cap because
    // this is one round trip each on the render path of a screen somebody is
    // waiting for. A customer past ten disputes is a fraud case, not a support
    // thread, and the tenth one does not change the reply.
    .slice(0, 10);

  if (ids.length === 0) return { disputes: [], refused: null };

  const found = await Promise.all(
    ids.map(async id => {
      try {
        return { dispute: await get<StripeDispute>(`/disputes/${id}`), error: null as unknown };
      } catch (error) {
        return { dispute: null, error };
      }
    }),
  );

  const disputes = found.map(one => one.dispute).filter((one): one is StripeDispute => one !== null);
  const failure = found.find(one => one.error);
  // Only worth reporting when it cost us something. One dispute readable and
  // one not is still a refusal, and the card should say so rather than quietly
  // showing the half it managed.
  const refused =
    failure && disputes.length < ids.length
      ? failure.error instanceof Error
        ? failure.error.message
        : 'Stripe refused the disputes read'
      : null;

  return { disputes: disputes.sort((a, b) => b.created - a.created), refused };
}

/** The three lists this app reads, and the three permissions a key needs. */
export const RESOURCES = ['customers', 'subscriptions', 'charges'] as const;
export type StripeResource = (typeof RESOURCES)[number];

/**
 * Does the key actually have this permission? Throws with Stripe's own words
 * if not.
 *
 * One probe per resource rather than one call that proves the key exists,
 * because a restricted key is granted permission by permission and the usual
 * mistake is granting two of the three. A key with customers but not charges
 * authenticates perfectly, finds the customer, and then produces a billing
 * screen with an empty payments list — which reads as "they never paid us".
 * That is the sentence this function exists to stop.
 */
export async function readable(resource: StripeResource | 'disputes'): Promise<void> {
  await get(`/${resource}?limit=1`);
}

/**
 * Follow the cursor, but not forever.
 *
 * Stripe pages at 100 and hands back `has_more`. The obvious `while (has_more)`
 * is an unbounded loop driven by a remote server, sitting in the request path of
 * a button somebody just pressed; a cap turns the worst case from a hung page
 * into a short list and a number the caller can report.
 */
async function page<T extends { id: string }>(path: string, max: number): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;

  while (items.length < max) {
    const query =
      `${path}${path.includes('?') ? '&' : '?'}limit=100` +
      (after ? `&starting_after=${after}` : '');
    const found = await get<{ data: T[]; has_more?: boolean }>(query);

    items.push(...found.data);
    // An empty page with `has_more` set would spin on the same cursor forever.
    if (!found.has_more || found.data.length === 0) break;
    after = found.data[found.data.length - 1]!.id;
  }

  return items.slice(0, max);
}

/**
 * The catalogue, and a permission the customer lookups do not need.
 *
 * Deliberately not added to `RESOURCES`: that list is what a desk must be able
 * to read to answer mail at all, and failing an install's setup check because it
 * has not granted a permission for a screen it has not opened yet would be
 * making the catalogue everybody's problem. This one reports its own refusal, on
 * the page that asked for it.
 *
 * Archived products are included. "Do you still sell the Starter plan?" is a
 * question a support desk gets, and "we discontinued it" is the answer — which
 * needs the row to exist and be marked inactive, not to be missing.
 */
export async function listProducts(max = 200): Promise<StripeProduct[]> {
  return page<StripeProduct>('/products', max);
}

/** Active prices only: an archived price is one nobody can be sold today. */
export async function listPrices(max = 500): Promise<StripePrice[]> {
  return page<StripePrice>('/prices?active=true', max);
}

/** A product with the prices that point at it. */
export interface CatalogueEntry {
  product: StripeProduct;
  prices: StripePrice[];
}

/**
 * What this desk sells, as Stripe currently has it.
 *
 * Two reads and a join rather than `expand[]=data.default_price`, because a
 * product usually has several live prices — monthly, yearly, a currency for
 * another region — and the pre-sales question is almost always about the one
 * the default is not.
 */
export async function listCatalogue(): Promise<CatalogueEntry[]> {
  const [products, prices] = await Promise.all([listProducts(), listPrices()]);

  const byProduct = new Map<string, StripePrice[]>();
  for (const price of prices) {
    byProduct.set(price.product, [...(byProduct.get(price.product) ?? []), price]);
  }

  // Cheapest first, so the sentence a model writes about a product opens with
  // the number somebody asking "how much is it" is asking for.
  const cost = (price: StripePrice) => price.unit_amount ?? Number.MAX_SAFE_INTEGER;

  return products
    // Sellable things first. Archived products are kept — "do you still sell
    // the Starter plan?" is answered by a row that says discontinued, not by a
    // missing row — but they are not what somebody opened this screen to read,
    // and mixed in by creation date they are indistinguishable at a glance from
    // the ones you can still buy.
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
    .map(product => ({
      product,
      prices: [...(byProduct.get(product.id) ?? [])].sort((a, b) => cost(a) - cost(b)),
    }));
}

/**
 * One price as a support reply would say it: "19.00 USD/month".
 *
 * `unit_amount` is null on tiered and metered prices, and the tempting default
 * is 0 — which renders as "free" to a model that then writes it to a customer.
 * There is no number to state in that case, so this says there is no number
 * rather than quoting the cheapest bracket as if it were the price.
 */
export function priceOf(price: StripePrice): string {
  const label = price.nickname?.trim();

  if (typeof price.unit_amount !== 'number') {
    return label ? `${label} — usage-based, price varies` : 'usage-based, price varies';
  }

  const count = price.recurring?.interval_count ?? 1;
  const interval = price.recurring?.interval;
  const every = interval ? `/${count > 1 ? `${count} ${interval}s` : interval}` : ' one-off';
  const amount = `${money(price.unit_amount, price.currency)}${every}`;

  return label ? `${label} — ${amount}` : amount;
}

/**
 * Stripe's minor units, except for the currencies that have none.
 *
 * Getting this wrong turns ¥5,000 into ¥50 in a sentence the model then
 * repeats to the person who paid the ¥5,000.
 */
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'isk']);

export function money(amount: number, currency: string): string {
  const value = ZERO_DECIMAL.has(currency.toLowerCase()) ? amount : amount / 100;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;
}

export function day(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function planOf(subscription: StripeSubscription): string {
  const price = subscription.items?.data?.[0]?.price;
  if (!price) return 'subscription';
  const amount =
    typeof price.unit_amount === 'number' && price.currency
      ? money(price.unit_amount, price.currency)
      : null;
  const every = price.recurring?.interval ? `/${price.recurring.interval}` : '';
  return (
    [price.nickname, amount ? `${amount}${every}` : null].filter(Boolean).join(' — ') ||
    'subscription'
  );
}

export type ChargeState = 'paid' | 'refunded' | 'partial' | 'failed';

/**
 * What actually happened to one charge.
 *
 * `refunded` alone is a boolean that goes true only on a full refund, so a
 * charge with half its money given back reads as paid — which is how somebody
 * gets told "we have not refunded you" while holding half a refund.
 */
export function chargeState(charge: StripeCharge): ChargeState {
  if (charge.status !== 'succeeded' || !charge.paid) return 'failed';
  if (charge.refunded) return 'refunded';
  return (charge.amount_refunded ?? 0) > 0 ? 'partial' : 'paid';
}

/** What they actually kept: paid less anything given back. */
export function netPaid(charges: StripeCharge[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const charge of charges) {
    if (chargeState(charge) === 'failed') continue;
    const net = charge.amount - (charge.amount_refunded ?? 0);
    totals.set(charge.currency, (totals.get(charge.currency) ?? 0) + net);
  }
  // A currency that nets to nothing is still a fact — everything was refunded,
  // which is different from never having paid — so zeroes are kept.
  return totals;
}
