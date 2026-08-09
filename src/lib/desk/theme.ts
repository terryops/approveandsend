/**
 * Light, dark, or whatever the machine says — and a preference that remembers.
 *
 * The stylesheet has always had both palettes and has always chosen between them
 * with `prefers-color-scheme`, which answers the question most of the time and
 * cannot answer it at all in the two cases people actually complain about: a desk
 * under a window at four in the afternoon, and a laptop that follows the sun into
 * dark mode halfway through an argument with a customer. Neither is a reason to
 * change the operating system's mind about every other application.
 *
 * Three states, not two. "System" is a real answer and it is the default one:
 * somebody who has never touched this should keep tracking their machine,
 * including when their machine changes at sunset. A two-position switch has to
 * pick a side on first render for a reader who never asked, and picking wrong is
 * how an app ends up bright white on a desk that had been dark all day.
 *
 * A cookie, not a column on a row — the same decision as `tasks/layout.ts` and
 * for the same reason: this is one reader's eyes, not the desk's configuration.
 * Two colleagues sharing an ADMIN_PASSWORD should not flip each other's screen.
 *
 * A year, because the preference has no meaningful expiry. The only thing that
 * should end it is the same person pressing one of the other two.
 */

import { cookies } from 'next/headers';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

const COOKIE = 'aas_theme';
const A_YEAR = 60 * 60 * 24 * 365;

export const DEFAULT_THEME: Theme = 'system';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** What this reader has asked for. An unrecognised value counts as unset, not as an error. */
export async function theme(): Promise<Theme> {
  const raw = (await cookies()).get(COOKIE)?.value;
  return isTheme(raw) ? raw : DEFAULT_THEME;
}

/**
 * What goes on `<html>`, and `undefined` for "system".
 *
 * Absent is not the same attribute as `data-theme="system"` would be: the
 * stylesheet's media query is what handles the unanswered case, and it has to be
 * able to keep handling it. Writing a value here for a reader who chose nothing
 * would freeze them into whichever palette they happened to load in.
 */
export function themeAttribute(chosen: Theme): 'light' | 'dark' | undefined {
  return chosen === 'system' ? undefined : chosen;
}

export async function setThemeCookie(chosen: Theme): Promise<void> {
  (await cookies()).set(COOKIE, chosen, {
    path: '/',
    maxAge: A_YEAR,
    sameSite: 'lax',
    httpOnly: true,
  });
}
