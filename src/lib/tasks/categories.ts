import { t } from '../i18n';
import type { ListTasksFilter } from './store';

/**
 * Where the work in front of you came from, as a row of tabs.
 *
 * The status tabs answer "whose turn is it". They cannot answer "what kind of
 * thing is this", and on a desk that takes in more than mail those are
 * different questions with different answers: a store review is written to on
 * your own time, a chargeback has a bank's deadline on it, and an email has a
 * person waiting. Sorted together by date they interleave, and the deadline is
 * the one that loses — it is one row among forty and nothing about it looks
 * urgent until the day it is gone.
 *
 * ## Derived, not declared
 *
 * There is no enum of kinds here, and there should not be one. `source` is a
 * free-text label its caller chose (`subeasy-bad-review`, `zendesk`, whatever
 * the next intake calls itself) and this app has no business knowing what those
 * mean. So the tabs are read off the rows that exist: whatever labels are in the
 * table get a tab, the day they first appear, with no migration and no edit
 * here.
 *
 * Two are built in because this app knows them first-hand: ordinary mail, which
 * carries no label at all, and disputes, which this app creates itself.
 */

/** The label this app writes on the chargeback tasks it opens for itself. */
export const DISPUTE_SOURCE = 'dispute';

export interface Category {
  /** What goes in `?from=`. `all` is the absence of a filter, not a value. */
  key: string;
  label: string;
  count: number;
  /** How to ask the store for exactly these rows. */
  filter: Pick<ListTasksFilter, 'origin' | 'source'>;
}

/** One row of `countTasksBySource`. */
export interface SourceCount {
  origin: string;
  source: string | null;
  count: number;
}

/**
 * A label somebody chose, made readable, without pretending to know it.
 *
 * `subeasy-bad-review` becomes "subeasy bad review", which is plain rather than
 * pretty — and pretty would mean a translation table for strings this app has
 * never seen. A desk that wants its own word for it says so in `sourceLabels`.
 */
function readable(source: string): string {
  return source.replace(/[-_]+/g, ' ').trim();
}

/**
 * The tabs, in the order they earn their place.
 *
 * Mail first because it is nearly all of it, then everything else by size, with
 * disputes pulled to the front of that group: it is the smallest tab on any
 * desk and the only one where not looking costs money on a schedule somebody
 * else set.
 *
 * Categories with nothing in them are dropped, except the one you are standing
 * in — a tab that vanishes as you clear the last row underneath it takes the
 * screen with it, and the click that got you there stops being repeatable.
 */
export function categories(
  counts: readonly SourceCount[],
  labels: Readonly<Record<string, string>> = {},
  active = 'all',
): Category[] {
  const total = counts.reduce((sum, row) => sum + row.count, 0);
  // Everything nobody labelled: mail that arrived, and mail this desk wrote
  // first from the compose form. Both are one person writing to another, which
  // is the distinction the tabs beside it are drawing.
  const mail = counts.filter(row => !row.source).reduce((sum, row) => sum + row.count, 0);

  const bySource = new Map<string, number>();
  for (const row of counts) {
    // Composed mail with no label is somebody using the compose form, and it
    // belongs with the mail rather than in a tab of its own: it is the same
    // desk writing to the same people, just first.
    if (!row.source) continue;
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + row.count);
  }

  const rest = [...bySource]
    .map(([source, count]) => ({
      key: source,
      label: labels[source] ?? (source === DISPUTE_SOURCE ? t('inbox.fromDisputes') : readable(source)),
      count,
      filter: { source },
    }))
    .sort((a, b) => {
      if (a.key === DISPUTE_SOURCE) return -1;
      if (b.key === DISPUTE_SOURCE) return 1;
      return b.count - a.count || a.key.localeCompare(b.key);
    });

  const all: Category[] = [
    { key: 'all', label: t('inbox.fromAll'), count: total, filter: {} },
    { key: 'mail', label: t('inbox.fromMail'), count: mail, filter: { source: null } },
    ...rest,
  ];

  return all.filter(category => category.count > 0 || category.key === active || category.key === 'all');
}

/**
 * The filter for a `?from=` value, without needing the counts.
 *
 * The list query runs before the tabs are drawn and asks the narrower question:
 * a `from` naming a label nothing carries yet is not an error, it is an empty
 * list — which is the same thing the tab would have shown.
 */
export function categoryFilter(key: string | null): Pick<ListTasksFilter, 'origin' | 'source'> {
  if (!key || key === 'all') return {};
  if (key === 'mail') return { source: null };
  return { source: key };
}
