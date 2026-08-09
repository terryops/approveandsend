import type { CatalogItem } from './types';

/**
 * The catalogue as the drafter reads it.
 *
 * Two things are being bought with these characters, and only one of them is
 * "the model knows the price".
 *
 * The first is that it stops guessing. A model asked "how much is the Pro plan"
 * with nothing in its prompt does not say it does not know — it writes a
 * plausible number, in a confident sentence, to somebody who will quote it back
 * during a chargeback. Giving it the list is how that sentence stops being
 * written.
 *
 * The second matters more and is easier to miss: the list has to be *closed*.
 * A prompt that lists three products invites a model to treat them as examples
 * and improvise a fourth for the customer asking about something else. So the
 * heading says these are all of them, and says what to do when the question is
 * about something not on the list. That instruction is doing more work than the
 * prices are.
 */

/**
 * Roughly 6k characters — about 1.5k tokens.
 *
 * Smaller than the rule budget on purpose. A rulebook grows to hundreds of
 * entries because every correction adds one; a catalogue is bounded by what a
 * company actually sells, and a desk with more than about forty products is one
 * where the answer is a link to a pricing page rather than a prompt listing all
 * of them.
 */
export const DEFAULT_CATALOG_BUDGET_CHARS = 6000;

export interface CatalogBlockOptions {
  maxChars?: number;
}

/** One item as a line a model can quote from. */
function line(item: CatalogItem): string {
  const parts = [`- **${item.name}**`];

  if (item.pricing) parts.push(` — ${item.pricing}`);
  // Said before the description, because it changes what every other word on
  // the line means. A model that reads the price first and the "we stopped
  // selling this" second has already started composing the wrong reply.
  if (!item.available) parts.push(' — NO LONGER SOLD; do not offer it to anyone');

  const detail = item.description?.replace(/\s+/g, ' ').trim();
  if (detail) parts.push(`\n  ${detail}`);

  const note = item.note?.replace(/\s+/g, ' ').trim();
  // Marked as ours rather than merged into the description. It is the half of
  // the entry a person wrote deliberately, and it is usually the half that says
  // what the product does *not* do — the sentence that keeps the reply honest.
  if (note) parts.push(`\n  Note from the desk: ${note}`);

  return parts.join('');
}

export interface CatalogBlock {
  /** Ready to interpolate. Empty when there is nothing to say. */
  text: string;
  /** What the budget pushed out, so the caller can log it rather than find out later. */
  droppedIds: string[];
}

export function catalogBlock(
  items: CatalogItem[],
  options: CatalogBlockOptions = {},
): CatalogBlock {
  const budget = options.maxChars ?? DEFAULT_CATALOG_BUDGET_CHARS;
  const usable = items.filter(item => item.enabled && item.name.trim() !== '');

  if (usable.length === 0) return { text: '', droppedIds: [] };

  // What is still sold comes first and is therefore what survives the budget.
  // A dropped discontinued product costs a vaguer answer to a rare question; a
  // dropped live one costs the price of the thing the desk is trying to sell.
  const ordered = [...usable].sort((a, b) => Number(b.available) - Number(a.available));

  const kept: CatalogItem[] = [];
  const dropped: string[] = [];
  let used = 0;

  for (const item of ordered) {
    const rendered = line(item);
    if (used + rendered.length > budget && kept.length > 0) {
      dropped.push(item.id);
      continue;
    }
    kept.push(item);
    used += rendered.length + 1;
  }

  // Rendered in the order they were given, not the order they were chosen: a
  // stable block between two runs is what makes their outputs comparable.
  const chosen = usable.filter(item => kept.includes(item));

  // The closing instruction is not padding. Without it this is a list of
  // examples, and a model that has been handed examples will produce another
  // one when the customer asks about something it cannot see.
  const closing = dropped.length > 0
    ? 'This is most of what we sell, not all of it. If they ask about something ' +
      'that is not listed here, say you will check rather than describing it.'
    : 'That is everything we sell. If they ask about a product, a plan or a price ' +
      'that is not on this list, do not describe it and do not guess at a number — ' +
      'say you will check and let them know.';

  return {
    text:
      '\n\n## What we sell\n' +
      'Taken from our own billing records, so the prices are current. State them ' +
      'exactly as written — the currency and the billing period included — and do ' +
      'not convert, round, discount or annualise them.\n\n' +
      chosen.map(line).join('\n') +
      `\n\n${closing}\n`,
    droppedIds: dropped,
  };
}
