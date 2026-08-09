import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { priceOf, type CatalogueEntry } from '../billing/stripe';
import { openDb, type Db } from '../db';
import { catalogBlock } from './prompt';
import {
  applySync,
  createCatalogItem,
  deleteCatalogItem,
  editManualItem,
  getCatalogItem,
  listCatalog,
  updateCatalogItem,
} from './store';
import { pricingLine, toSyncedItems } from './sync';
import type { CatalogItem, SyncedItem } from './types';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function synced(overrides: Partial<SyncedItem> = {}): SyncedItem {
  return {
    externalId: 'prod_1',
    name: 'Pro',
    description: 'The paid tier',
    pricing: '19.00 USD/month',
    available: true,
    ...overrides,
  };
}

function entry(
  product: Partial<CatalogueEntry['product']> = {},
  prices: CatalogueEntry['prices'] = [],
): CatalogueEntry {
  return {
    product: { id: 'prod_1', name: 'Pro', active: true, created: 0, ...product },
    prices,
  };
}

// --- prices, which are the part that costs money to get wrong -------------

describe('priceOf', () => {
  it('states the amount, the currency and the interval', () => {
    expect(
      priceOf({
        id: 'price_1',
        product: 'prod_1',
        active: true,
        currency: 'usd',
        unit_amount: 1900,
        recurring: { interval: 'month' },
      }),
    ).toBe('19 USD/month');
  });

  it('does not divide a zero-decimal currency by a hundred', () => {
    // ¥5,000 rendered as ¥50 is a number a model then repeats to the person who
    // paid the ¥5,000.
    expect(
      priceOf({ id: 'p', product: 'prod_1', active: true, currency: 'jpy', unit_amount: 5000 }),
    ).toBe('5,000 JPY one-off');
  });

  it('says a usage-based price has no number rather than calling it free', () => {
    const line = priceOf({
      id: 'p',
      product: 'prod_1',
      active: true,
      currency: 'usd',
      unit_amount: null,
    });
    expect(line).toContain('varies');
    expect(line).not.toContain('0.00');
  });

  it('counts multi-interval periods', () => {
    expect(
      priceOf({
        id: 'p',
        product: 'prod_1',
        active: true,
        currency: 'usd',
        unit_amount: 3000,
        recurring: { interval: 'month', interval_count: 3 },
      }),
    ).toBe('30 USD/3 months');
  });

  it('joins several prices onto one line', () => {
    const line = pricingLine(
      entry({}, [
        { id: 'a', product: 'prod_1', active: true, currency: 'usd', unit_amount: 1900, recurring: { interval: 'month' } },
        { id: 'b', product: 'prod_1', active: true, currency: 'usd', unit_amount: 19000, recurring: { interval: 'year' } },
      ]),
    );
    expect(line).toBe('19 USD/month · 190 USD/year');
  });

  it('has no pricing line at all for a product nobody priced', () => {
    expect(pricingLine(entry())).toBeNull();
  });

  it('says each distinct price once', () => {
    // A real account keeps legacy and duplicate price objects that render
    // identically. Listing "9.9 USD/month" twice reads as two prices, and a
    // model asked to quote one has to guess.
    const line = pricingLine(
      entry({}, [
        { id: 'a', product: 'prod_1', active: true, currency: 'usd', unit_amount: 990, recurring: { interval: 'month' } },
        { id: 'b', product: 'prod_1', active: true, currency: 'usd', unit_amount: 990, recurring: { interval: 'month' } },
        { id: 'c', product: 'prod_1', active: true, currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' } },
      ]),
    );
    expect(line).toBe('9.9 USD/month · 15 USD/month');
  });

  it('keeps the same amount in a different currency', () => {
    const line = pricingLine(
      entry({}, [
        { id: 'a', product: 'prod_1', active: true, currency: 'usd', unit_amount: 2000, recurring: { interval: 'month' } },
        { id: 'b', product: 'prod_1', active: true, currency: 'hkd', unit_amount: 2000, recurring: { interval: 'month' } },
      ]),
    );
    expect(line).toBe('20 USD/month · 20 HKD/month');
  });
});

describe('toSyncedItems', () => {
  it('carries the archived flag through rather than dropping the product', () => {
    const [item] = toSyncedItems([entry({ active: false })]);
    expect(item!.available).toBe(false);
  });

  it('falls back to the id when a product has no name', () => {
    const [item] = toSyncedItems([entry({ name: '  ' })]);
    expect(item!.name).toBe('prod_1');
  });
});

// --- the sync, and the one thing it must never do ------------------------

describe('applySync', () => {
  it('adds what it has not seen', () => {
    const counts = applySync([synced()], db);
    expect(counts).toEqual({ added: 1, updated: 0, discontinued: 0 });

    const [item] = listCatalog({}, db);
    expect(item!.name).toBe('Pro');
    expect(item!.source).toBe('stripe');
    expect(item!.enabled).toBe(true);
    expect(item!.syncedAt).not.toBeNull();
  });

  it('updates Stripe’s half in place instead of duplicating the row', () => {
    applySync([synced()], db);
    const counts = applySync([synced({ name: 'Pro (new)', pricing: '29.00 USD/month' })], db);

    expect(counts).toEqual({ added: 0, updated: 1, discontinued: 0 });
    const items = listCatalog({}, db);
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('Pro (new)');
    expect(items[0]!.pricing).toBe('29.00 USD/month');
  });

  it('never overwrites the note or the switch', () => {
    // The whole reason the table has two owners. A sync that eats the sentence
    // somebody spent ten minutes writing is a sync nobody runs twice.
    applySync([synced()], db);
    const before = listCatalog({}, db)[0]!;
    updateCatalogItem(before.id, { note: 'Does not include the API.', enabled: false }, db);

    applySync([synced({ name: 'Pro renamed', pricing: '25.00 USD/month' })], db);

    const after = getCatalogItem(before.id, db)!;
    expect(after.note).toBe('Does not include the API.');
    expect(after.enabled).toBe(false);
    expect(after.name).toBe('Pro renamed');
  });

  it('marks a product that has vanished from Stripe rather than deleting it', () => {
    applySync([synced(), synced({ externalId: 'prod_2', name: 'Starter' })], db);
    const counts = applySync([synced()], db);

    expect(counts.discontinued).toBe(1);
    const starter = listCatalog({}, db).find(item => item.name === 'Starter')!;
    // "We stopped offering it" is an answer. A missing row is not.
    expect(starter.available).toBe(false);
  });

  it('leaves hand-written rows alone when Stripe does not mention them', () => {
    createCatalogItem({ name: 'Onboarding call', pricing: 'free' }, db);
    applySync([synced()], db);

    const manual = listCatalog({}, db).find(item => item.source === 'manual')!;
    expect(manual.available).toBe(true);
  });

  it('is idempotent', () => {
    applySync([synced()], db);
    applySync([synced()], db);
    applySync([synced()], db);
    expect(listCatalog({}, db)).toHaveLength(1);
  });
});

// --- the store's guard rails ---------------------------------------------

describe('the store', () => {
  it('refuses to let a hand edit touch a synced name', () => {
    // Allowing it would be worse than refusing: the edit appears to work and
    // then reverts on the next sync.
    applySync([synced()], db);
    const item = listCatalog({}, db)[0]!;
    expect(editManualItem(item.id, { name: 'Something else' }, db)).toBeNull();
    expect(getCatalogItem(item.id, db)!.name).toBe('Pro');
  });

  it('edits a hand-written row', () => {
    const item = createCatalogItem({ name: 'Onboarding call' }, db);
    const edited = editManualItem(item.id, { name: 'Onboarding session', pricing: '200.00 USD one-off' }, db);
    expect(edited!.name).toBe('Onboarding session');
    expect(edited!.pricing).toBe('200.00 USD one-off');
  });

  it('lists what is still sold before what is not', () => {
    applySync([synced({ externalId: 'a', name: 'Zebra', available: true })], db);
    applySync(
      [
        synced({ externalId: 'a', name: 'Zebra', available: true }),
        synced({ externalId: 'b', name: 'Alpha', available: false }),
      ],
      db,
    );
    expect(listCatalog({}, db).map(item => item.name)).toEqual(['Zebra', 'Alpha']);
  });

  it('filters to the rows a prompt may see', () => {
    applySync([synced(), synced({ externalId: 'prod_2', name: 'Starter' })], db);
    const first = listCatalog({}, db)[0]!;
    updateCatalogItem(first.id, { enabled: false }, db);
    expect(listCatalog({ enabledOnly: true }, db)).toHaveLength(1);
  });

  it('deletes a hand-written row', () => {
    const item = createCatalogItem({ name: 'Onboarding call' }, db);
    expect(deleteCatalogItem(item.id, db)).toBe(true);
    expect(listCatalog({}, db)).toHaveLength(0);
  });
});

// --- the block the model actually reads ----------------------------------

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'id-1',
    source: 'stripe',
    externalId: 'prod_1',
    name: 'Pro',
    description: null,
    pricing: '19.00 USD/month',
    available: true,
    note: null,
    enabled: true,
    syncedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('catalogBlock', () => {
  it('says nothing at all when nothing is catalogued', () => {
    // An empty heading is worse than no heading: it tells the model the desk
    // sells nothing.
    expect(catalogBlock([]).text).toBe('');
  });

  it('says nothing when every row is switched off', () => {
    expect(catalogBlock([item({ enabled: false })]).text).toBe('');
  });

  it('states the price exactly and forbids improvising around it', () => {
    const { text } = catalogBlock([item()]);
    expect(text).toContain('**Pro**');
    expect(text).toContain('19.00 USD/month');
    expect(text).toMatch(/do not convert, round, discount or annualise/i);
  });

  it('closes the list so the model cannot treat it as examples', () => {
    // The instruction is doing more work than the prices are.
    const { text } = catalogBlock([item()]);
    expect(text).toContain('That is everything we sell');
    expect(text).toMatch(/do not describe it and do not guess at a number/i);
  });

  it('warns off a discontinued product before describing it', () => {
    const { text } = catalogBlock([item({ available: false })]);
    expect(text).toContain('NO LONGER SOLD');
    expect(text.indexOf('NO LONGER SOLD')).toBeLessThan(text.length);
  });

  it('marks the desk’s own note as the desk’s', () => {
    const { text } = catalogBlock([item({ note: 'Does not include the API.' })]);
    expect(text).toContain('Note from the desk: Does not include the API.');
  });

  it('flattens a note written over several lines', () => {
    const { text } = catalogBlock([item({ note: 'One thing.\n\nAnother thing.' })]);
    expect(text).toContain('Note from the desk: One thing. Another thing.');
  });

  it('keeps what is sold and drops what is not when the budget bites', () => {
    const { text, droppedIds } = catalogBlock(
      [
        item({ id: 'gone', name: 'Retired', available: false }),
        item({ id: 'live', name: 'Current', available: true }),
      ],
      { maxChars: 40 },
    );

    expect(droppedIds).toEqual(['gone']);
    expect(text).toContain('Current');
    expect(text).not.toContain('Retired');
  });

  it('admits the list is partial when the budget dropped something', () => {
    // Claiming completeness while withholding rows is how a model is licensed
    // to say "we do not sell that" about a thing the desk sells.
    const { text } = catalogBlock(
      [item({ id: 'a', name: 'Alpha' }), item({ id: 'b', name: 'Beta' })],
      { maxChars: 10 },
    );
    expect(text).toContain('not all of it');
    expect(text).not.toContain('That is everything we sell');
  });

  it('keeps at least one entry however small the budget', () => {
    const { text } = catalogBlock([item()], { maxChars: 1 });
    expect(text).toContain('**Pro**');
  });
});
