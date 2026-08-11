import { getWorkspaceConfig } from './config/workspace';

/**
 * What time it is on the desk.
 *
 * Every date in this app used to be printed by chopping the ISO string —
 * `createdAt.slice(0, 16)` — which is UTC, and the comment above the queue's
 * formatter defended it as "one clock, the server's". Half of that was right.
 * One clock is the property worth keeping: two reviewers in two places reading
 * the same queue should read the same number, so this is not the browser's
 * timezone and never renders differently for two people. But it was not the
 * server's clock, it was UTC, and a desk in Guangzhou read every arrival time
 * eight hours behind the mail client it was reconciling against.
 *
 * So: the desk's zone, configurable for a desk that is not where its server is,
 * defaulting to the zone the machine is set to. Nothing here is per-user.
 */

/** IANA name, or '' to follow the machine. */
function configured(): string {
  try {
    return getWorkspaceConfig().timeZone.trim();
  } catch {
    // Config unreadable is not a reason to fail to print a date.
    return '';
  }
}

/**
 * The zone every stamp is rendered in.
 *
 * An unusable name falls back to the machine rather than throwing: a typo in
 * the config should cost the offset, not the page.
 */
export function deskTimeZone(): string {
  const zone = configured();
  if (zone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return zone;
    } catch {
      // Fall through.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * `2026-08-11 22:12`, in the desk's zone.
 *
 * Swedish because its date format is ISO and its clock is 24-hour, which is
 * what the whole app already prints — the locale here is a formatting trick,
 * not a language choice, and the interface language is decided in `i18n`.
 */
export function stamp(iso: string | null | undefined): string {
  const parts = split(iso);
  return parts ? `${parts.date} ${parts.time}` : '';
}

/** `2026-08-11`, in the desk's zone. */
export function day(iso: string | null | undefined): string {
  return split(iso)?.date ?? '';
}

/**
 * The two halves separately, for the places that print one of them.
 *
 * The inbox shows a bare `22:12` for today and a bare `08-11` for this year,
 * and building those by slicing a formatted string is how the UTC bug got in.
 */
export function split(iso: string | null | undefined): { date: string; time: string } | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;

  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: deskTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

  // 'sv-SE' gives `2026-08-11 22:12`, and has since the locale existed, but a
  // formatter that ever returned something else would otherwise put a mangled
  // date on the screen rather than nothing.
  const [date, time] = formatted.split(' ');
  if (!date || !time) return null;
  return { date, time };
}

/**
 * Whole days between two moments as the desk counts them — today is 0,
 * yesterday is 1 — which is not the same as dividing a difference by 86,400,000.
 * Something that arrived at 23:50 last night is yesterday at 00:10, and an hour
 * is not a day.
 */
export function daysAgo(iso: string, now: Date = new Date()): number | null {
  const then = day(iso);
  const today = day(now.toISOString());
  if (!then || !today) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${then}T00:00:00Z`)) / 86_400_000);
}
