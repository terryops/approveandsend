import { describe, expect, it } from 'vitest';

import { categories, categoryFilter, DISPUTE_SOURCE, type SourceCount } from './categories';

const rows = (...counts: SourceCount[]) => counts;
const row = (source: string | null, count: number, origin = 'inbound'): SourceCount => ({
  origin,
  source,
  count,
});

/** Keys rather than labels: the labels are translated and these are not. */
const keys = (list: ReturnType<typeof categories>) => list.map(c => c.key);

describe('the tabs a desk earns', () => {
  it('folds every unlabelled row into mail, whoever wrote first', () => {
    // Mail that arrived and mail this desk sent are both one person writing to
    // another, which is the distinction the tabs beside them are drawing.
    const list = categories(rows(row(null, 20), row(null, 3, 'composed'), row('dispute', 2)));
    const mail = list.find(c => c.key === 'mail');
    expect(mail?.count).toBe(23);
    expect(list.find(c => c.key === 'all')?.count).toBe(25);
  });

  it('puts chargebacks first however small they are', () => {
    // Which is the whole reason they get a tab. Two of them against forty
    // reviews is two rows nobody scrolls to, and they are the two with a bank's
    // deadline on them.
    expect(keys(categories(rows(row(null, 40), row('subeasy-bad-review', 12), row('dispute', 2)))))
      .toEqual(['all', 'mail', DISPUTE_SOURCE, 'subeasy-bad-review']);
  });

  it('orders everything else by size, and settles ties by name', () => {
    const list = categories(rows(row(null, 1), row('zendesk', 4), row('appstore', 4), row('forms', 9)));
    expect(keys(list)).toEqual(['all', 'mail', 'forms', 'appstore', 'zendesk']);
  });

  it('takes the desk’s own word for an intake when it has one', () => {
    const list = categories(rows(row('subeasy-bad-review', 3)), { 'subeasy-bad-review': '差评' });
    expect(list.find(c => c.key === 'subeasy-bad-review')?.label).toBe('差评');
  });

  it('makes a slug readable rather than guessing at it', () => {
    const list = categories(rows(row('subeasy-bad-review', 3)));
    expect(list.find(c => c.key === 'subeasy-bad-review')?.label).toBe('subeasy bad review');
  });

  it('drops the empty ones, and keeps the one you are standing in', () => {
    // Clearing the last chargeback must not take the screen out from under
    // somebody who is reading it — and the click that got them there has to
    // stay repeatable.
    const cleared = rows(row(null, 12), row('dispute', 0));
    expect(keys(categories(cleared))).toEqual(['all', 'mail']);
    expect(keys(categories(cleared, {}, DISPUTE_SOURCE))).toContain(DISPUTE_SOURCE);
  });

  it('still offers a way back out of an empty desk', () => {
    expect(keys(categories([]))).toEqual(['all']);
  });
});

describe('what a ?from= asks the store for', () => {
  it('asks nothing at all for everywhere', () => {
    expect(categoryFilter(null)).toEqual({});
    expect(categoryFilter('all')).toEqual({});
  });

  it('asks for the absence of a label, which is not the absence of a question', () => {
    expect(categoryFilter('mail')).toEqual({ source: null });
  });

  it('passes an unknown label straight through', () => {
    // A `from` naming something nothing carries yet is an empty list rather
    // than an error — which is exactly what its tab would have shown.
    expect(categoryFilter('never-seen')).toEqual({ source: 'never-seen' });
  });
});
