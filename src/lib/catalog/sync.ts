import { listCatalogue, priceOf, stripeConfigured, type CatalogueEntry } from '../billing/stripe';
import { getDb, type Db } from '../db';
import { applySync, type SyncCounts } from './store';
import type { SyncedItem } from './types';

/**
 * Stripe's catalogue, pulled into ours.
 *
 * The join and the formatting happen here rather than at read time because the
 * thing being stored is a sentence, not a record. A price is minor units plus a
 * currency plus an interval plus a nickname, and the place that knows how to
 * turn all four into "19.00 USD/month" is the Stripe client — not a template,
 * and certainly not a model reading raw JSON and guessing whether 1299 is
 * dollars or cents.
 */

/**
 * Several prices on one product, in one line, each said once.
 *
 * The deduplication is not tidying. A real Stripe account accumulates several
 * price objects that render identically — a legacy one kept alive for existing
 * subscribers, a duplicate made for a checkout link, one per lookup key — and
 * the first live run of this produced "9.9 USD/month · 9.9 USD/month · 15
 * USD/month" for a single plan.
 *
 * A person reads that as a data glitch. A model reads it as three prices and
 * has to pick one, which is the situation this whole feature exists to prevent:
 * it will quote a number, confidently, and a repeated number is not more likely
 * to be the right one. Distinct prices in distinct currencies stay — a customer
 * in Hong Kong asking what it costs should be told in HKD.
 */
export function pricingLine(entry: CatalogueEntry): string | null {
  if (entry.prices.length === 0) return null;
  return [...new Set(entry.prices.map(priceOf))].join(' · ') || null;
}

export function toSyncedItems(entries: CatalogueEntry[]): SyncedItem[] {
  return entries.map(entry => ({
    externalId: entry.product.id,
    name: entry.product.name.trim() || entry.product.id,
    description: entry.product.description?.trim() || null,
    pricing: pricingLine(entry),
    available: entry.product.active,
  }));
}

export class StripeNotConfigured extends Error {
  constructor() {
    super('No Stripe key is set, so there is no catalogue to read.');
    this.name = 'StripeNotConfigured';
  }
}

/**
 * Read Stripe, write our rows, report what changed.
 *
 * Throws rather than swallowing. This runs behind a button somebody just
 * pressed, and the two failures that matter — a key without the `products`
 * permission, and a key in test mode against a live catalogue — both look
 * exactly like "no products found" if the error is turned into an empty list.
 */
export async function syncCatalogFromStripe(db: Db = getDb()): Promise<SyncCounts> {
  if (!stripeConfigured()) throw new StripeNotConfigured();
  return applySync(toSyncedItems(await listCatalogue()), db);
}
