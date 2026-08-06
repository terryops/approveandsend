import type { ContextBlock, ContextField, ContextSource, LookupSubject } from '../types';

/**
 * Who this person is to the billing system.
 *
 * Read-only, and only three GETs: the customer, their subscriptions, their
 * recent charges. It uses `/v1/customers?email=` rather than
 * `/v1/customers/search`, because search needs a broader permission than a
 * read-only restricted key is normally given and this should work with the
 * narrowest key Stripe will issue.
 *
 * Make that key restricted, and give it read on customers, subscriptions and
 * charges. Nothing here writes, so nothing here needs write.
 */

const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 8_000;
const DASHBOARD = 'https://dashboard.stripe.com/customers';

interface StripeCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
  created: number;
  currency?: string | null;
  delinquent?: boolean | null;
}

interface StripeSubscription {
  id: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items?: { data?: { price?: { nickname?: string | null; unit_amount?: number | null; currency?: string; recurring?: { interval?: string } | null } | null }[] };
}

interface StripeCharge {
  amount: number;
  currency: string;
  paid: boolean;
  refunded: boolean;
  created: number;
  status: string;
}

function key(): string {
  return process.env.STRIPE_API_KEY?.trim() ?? '';
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message ?? `Stripe responded ${response.status}`);
  }
  return (await response.json()) as T;
}

function money(amount: number, currency: string): string {
  // Stripe's minor units, except for the currencies that have none. Getting
  // this wrong turns ¥5,000 into ¥50 in a sentence the model then repeats.
  const zeroDecimal = ['jpy', 'krw', 'vnd', 'clp', 'isk'];
  const value = zeroDecimal.includes(currency.toLowerCase()) ? amount : amount / 100;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;
}

function day(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function planOf(subscription: StripeSubscription): string {
  const price = subscription.items?.data?.[0]?.price;
  if (!price) return 'subscription';
  const amount =
    typeof price.unit_amount === 'number' && price.currency
      ? money(price.unit_amount, price.currency)
      : null;
  const every = price.recurring?.interval ? `/${price.recurring.interval}` : '';
  return [price.nickname, amount ? `${amount}${every}` : null].filter(Boolean).join(' — ') || 'subscription';
}

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

  const paid = charges.filter(c => c.paid && !c.refunded);
  if (paid.length > 0) {
    const byCurrency = new Map<string, number>();
    for (const charge of paid) {
      byCurrency.set(charge.currency, (byCurrency.get(charge.currency) ?? 0) + charge.amount);
    }
    const totals = [...byCurrency].map(([currency, amount]) => money(amount, currency)).join(', ');
    lines.push(`Has paid ${totals} across ${paid.length} charge(s); the most recent was ${day(paid[0]!.created)}.`);
  }

  const refunded = charges.filter(c => c.refunded);
  if (refunded.length > 0) {
    // The single most useful thing to not get wrong in a refund thread.
    lines.push(`${refunded.length} of their charges has already been refunded.`);
  }

  if (customer.delinquent) {
    lines.push('Their latest payment attempt failed, so the account may be past due.');
  }

  return lines.join(' ');
}

export const stripeSource: ContextSource = {
  id: 'stripe',
  label: 'Billing (Stripe)',

  configured: () => key() !== '',

  async lookup(subject: LookupSubject): Promise<ContextBlock | null> {
    const found = await get<{ data: StripeCustomer[] }>(
      `/customers?email=${encodeURIComponent(subject.email)}&limit=1`,
    );
    const customer = found.data[0];
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
      get<{ data: StripeSubscription[] }>(`/subscriptions?customer=${customer.id}&status=all&limit=10`),
      get<{ data: StripeCharge[] }>(`/charges?customer=${customer.id}&limit=20`),
    ]);

    const active = subscriptions.data.find(s => s.status === 'active' || s.status === 'trialing');
    const paid = charges.data.filter(c => c.paid && !c.refunded);

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

    return {
      title: 'Billing (Stripe)',
      href: `${DASHBOARD}/${customer.id}`,
      fields,
      prompt: describe(customer, subscriptions.data, charges.data),
    };
  },
};
