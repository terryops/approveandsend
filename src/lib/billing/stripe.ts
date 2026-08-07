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
}

export function stripeKey(): string {
  return process.env.STRIPE_API_KEY?.trim() ?? '';
}

export function stripeConfigured(): boolean {
  return stripeKey() !== '';
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
