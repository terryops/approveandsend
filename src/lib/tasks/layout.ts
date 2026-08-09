/**
 * Two ways to read the review screen, and a preference that remembers which.
 *
 * Columns and side-by-side are not two pages. They are two readings of the same
 * one, for two different jobs: columns is "there are forty of these today and I
 * am going through them", side-by-side is "this one is hard to call, put the
 * question and the answer next to each other". The same person wants both on the
 * same afternoon, which is why this is a switch on the screen rather than a
 * setting somewhere else — press it, and the next task opens the way you left it.
 *
 * A cookie, not a column on a row. This is one reader's way of looking, not the
 * desk's configuration: two colleagues sharing an ADMIN_PASSWORD should not flip
 * each other's screen, and the `operators` table records who sent something, not
 * how they like to look at it.
 *
 * A year, because the preference has no meaningful expiry — the only thing that
 * should ever end it is the same person pressing the other button.
 */

import { cookies } from 'next/headers';

export const REVIEW_LAYOUTS = ['columns', 'compare'] as const;
export type ReviewLayout = (typeof REVIEW_LAYOUTS)[number];

const COOKIE = 'aas_review_layout';
const A_YEAR = 60 * 60 * 24 * 365;

/**
 * Columns is the default.
 *
 * Not because it is the better one, but because it is the one this screen
 * already was. Somebody who upgrades and finds their page rearranged goes
 * looking for what broke rather than admiring the new layout. Side by side is
 * something they press for themselves.
 */
export const DEFAULT_REVIEW_LAYOUT: ReviewLayout = 'columns';

export function isReviewLayout(value: unknown): value is ReviewLayout {
  return typeof value === 'string' && (REVIEW_LAYOUTS as readonly string[]).includes(value);
}

/** How this reader is reading. An unrecognised value counts as unset, not as an error. */
export async function reviewLayout(): Promise<ReviewLayout> {
  const raw = (await cookies()).get(COOKIE)?.value;
  return isReviewLayout(raw) ? raw : DEFAULT_REVIEW_LAYOUT;
}

export async function setReviewLayoutCookie(layout: ReviewLayout): Promise<void> {
  (await cookies()).set(COOKIE, layout, {
    path: '/',
    maxAge: A_YEAR,
    sameSite: 'lax',
    httpOnly: true,
  });
}
