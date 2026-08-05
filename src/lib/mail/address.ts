import type { MailAddress } from './types';

/**
 * Address handling. Deliberately lenient: mail in the wild is malformed far
 * more often than the RFCs suggest, and dropping a customer's email because
 * their client emitted something odd is worse than accepting it.
 */

// Not RFC 5322 — that grammar accepts things no mail server will deliver to.
// This is the practical subset: something@something.tld, no spaces, no commas.
const ADDRESS_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]{2,}$/;

export function isValidEmail(input: string | null | undefined): boolean {
  if (!input) return false;
  return ADDRESS_RE.test(input.trim());
}

/**
 * Pull the bare address out of any of the forms mail servers actually send:
 *   "Vincent Li" <v@example.com>
 *   Vincent Li <v@example.com>
 *   <v@example.com>
 *   v@example.com
 * Returns '' when there is nothing address-shaped in there.
 */
export function extractEmail(input: string | null | undefined): string {
  if (!input) return '';
  const raw = input.trim();

  const angled = raw.match(/<([^<>]+)>/);
  const candidate = (angled?.[1] ?? raw).trim();
  if (isValidEmail(candidate)) return candidate.toLowerCase();

  // Last resort: something in the string looks like an address.
  const loose = raw.match(/[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]{2,}/);
  return loose ? loose[0].toLowerCase() : '';
}

/** Parse one address, keeping the display name when there is one. */
export function parseAddress(input: string | null | undefined): MailAddress | null {
  const address = extractEmail(input);
  if (!address) return null;

  const raw = (input ?? '').trim();
  const angled = raw.match(/^(.*?)<[^<>]+>\s*$/);
  let name = angled?.[1]?.trim() ?? '';
  // Strip the quotes clients wrap display names in.
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).trim();
  }

  return name ? { name, address } : { address };
}

/**
 * Split a header value into addresses. Commas inside quoted display names are
 * not separators — `"Li, Vincent" <v@example.com>` is one recipient, not two.
 */
export function parseAddressList(input: string | null | undefined): MailAddress[] {
  if (!input) return [];

  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngles = false;

  for (const char of input) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '<' && !inQuotes) inAngles = true;
    else if (char === '>' && !inQuotes) inAngles = false;

    if (char === ',' && !inQuotes && !inAngles) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  const seen = new Set<string>();
  const out: MailAddress[] = [];
  for (const part of parts) {
    const parsed = parseAddress(part);
    if (!parsed || seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    out.push(parsed);
  }
  return out;
}

/** Render for a header. Quotes the display name when it contains a special. */
export function formatAddress(addr: MailAddress): string {
  if (!addr.name) return addr.address;
  const needsQuotes = /[",;:<>@()[\]\\]/.test(addr.name);
  const name = needsQuotes ? `"${addr.name.replace(/(["\\])/g, '\\$1')}"` : addr.name;
  return `${name} <${addr.address}>`;
}

export function formatAddressList(addrs: MailAddress[]): string {
  return addrs.map(formatAddress).join(', ');
}

/** Strip the angle brackets from a Message-ID so ids compare equal. */
export function normalizeMessageId(id: string | null | undefined): string {
  if (!id) return '';
  return id.trim().replace(/^<|>$/g, '').trim();
}

/** Parse a References header, which is whitespace-separated <ids>. */
export function parseReferences(header: string | null | undefined): string[] {
  if (!header) return [];
  const ids = header.match(/<[^<>\s]+>/g);
  if (ids) return ids.map(normalizeMessageId).filter(Boolean);
  return header.split(/\s+/).map(normalizeMessageId).filter(Boolean);
}
