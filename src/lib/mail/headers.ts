/**
 * The few raw headers that survive the provider boundary.
 *
 * `MailMessage` is deliberately a small, backend-neutral shape, and carrying
 * every header through it would undo that. But three or four headers say
 * something no other field can — that the sender is a mailing list, a robot, or
 * a bounce — and the only alternative to reading them is asking a model to
 * guess from the body, which costs a call and is worse at it.
 *
 * Named rather than "everything" because IMAP charges by the header: asking for
 * five on a listing of two hundred is one small fetch, asking for all of them
 * pulls every Received: line in every message.
 */

export const WANTED_HEADERS = [
  'list-unsubscribe',
  'auto-submitted',
  'precedence',
  'x-auto-response-suppress',
  'return-path',
] as const;

/**
 * Pick the wanted headers out of whatever the provider has, lowercased keys.
 *
 * Takes a lookup function rather than a Map so the three providers can pass
 * their own shape — a Map, mailparser's `Headers`, a plain object — without
 * each of them building a throwaway copy of the whole header block first.
 */
export function pickHeaders(
  lookup: (name: string) => string | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of WANTED_HEADERS) {
    const value = lookup(name);
    if (typeof value === 'string' && value.trim()) out[name] = value.trim();
  }
  return out;
}

/**
 * The same, from a raw header block.
 *
 * Unfolds continuation lines first: List-Unsubscribe carrying two URLs is
 * routinely wrapped, and reading only the first line would leave a value that
 * looks truncated to anything trying to parse it.
 */
export function pickHeaderBlock(raw: string): Record<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!map.has(name)) map.set(name, line.slice(at + 1).trim());
  }
  return pickHeaders(name => map.get(name));
}

/**
 * The same, from mailparser's `headerLines`.
 *
 * Not from its `headers` Map, which parses some of these into objects — a
 * Return-Path comes back as an address structure, and `<>`, the one value we
 * actually care about, parses to nothing at all. `headerLines` is the raw text
 * as it arrived, which is what a check on raw text needs.
 */
export function pickHeaderLines(
  lines: readonly { readonly key: string; readonly line: string }[] | undefined,
): Record<string, string> {
  const map = new Map<string, string>();
  for (const { key, line } of lines ?? []) {
    const name = key.toLowerCase();
    // First wins, matching the other parsers: a header added by a relay on the
    // way here comes after the sender's own.
    if (map.has(name)) continue;
    const at = line.indexOf(':');
    map.set(name, at >= 0 ? line.slice(at + 1).trim() : '');
  }
  return pickHeaders(name => map.get(name));
}
