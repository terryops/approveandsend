/**
 * What this desk sells.
 *
 * The workspace config already had a place for "things that are true and that
 * the model would otherwise invent" — the `facts` list — and a price is exactly
 * that kind of fact. This is a table instead of more strings in that file for
 * one reason: prices live in Stripe and change there. A fact that has to be
 * re-typed into a JSON file whenever somebody edits a price is a fact that goes
 * stale, and a stale price is not a formatting problem, it is a number a
 * customer was quoted and will hold the desk to.
 *
 * Every row has two owners, and keeping them apart is the whole design. Stripe
 * owns the name, the description, the prices and whether the thing is still
 * sold; a sync overwrites all four without asking. Whoever runs the desk owns
 * the note and the switch; a sync must never touch either, because the note is
 * the part that took a person ten minutes to write and is the reason the entry
 * is worth having at all.
 */

export type CatalogSource = 'stripe' | 'manual';

export interface CatalogItem {
  id: string;
  source: CatalogSource;
  /** Stripe's product id, or null for a row somebody typed. */
  externalId: string | null;

  // --- Stripe's, overwritten on every sync ---
  name: string;
  description: string | null;
  /** The prices, already rendered: "19.00 USD/month · 190.00 USD/year". */
  pricing: string | null;
  /**
   * Still sold. False for an archived Stripe product, and the row stays.
   *
   * "Do you still sell the Starter plan?" is a question support desks get, and
   * "we stopped offering it" is the answer. Deleting the row on archive would
   * leave the model with nothing to say, and nothing to say is where invention
   * starts.
   */
  available: boolean;

  // --- The operator's, never written by a sync ---
  /**
   * What Stripe cannot know: who it suits, what it does not include, the
   * caveat that stops the reply being wrong.
   */
  note: string | null;
  /** Off keeps the row and keeps it out of every prompt. */
  enabled: boolean;

  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A row as the sync hands it over — Stripe's half only. */
export interface SyncedItem {
  externalId: string;
  name: string;
  description: string | null;
  pricing: string | null;
  available: boolean;
}

export function isCatalogSource(value: unknown): value is CatalogSource {
  return value === 'stripe' || value === 'manual';
}
