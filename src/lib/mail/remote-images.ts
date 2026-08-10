/**
 * The pictures a letter keeps somewhere else.
 *
 * The first version of this refused them, and the reasoning was sound as far as
 * it went: an `<img src="https://…">` in inbound mail is a read receipt. Fetch
 * it and the sender learns that the address is live, that a person opened the
 * mail, when they did it, from which IP and in which browser. Support addresses
 * are scraped and mailed at constantly.
 *
 * What that reasoning left out is that the desk does not have to be the one
 * fetching it. Every serious mail client answers this the same way and has for
 * a decade: the picture is fetched by the server, once, and served to the
 * reader from the reader's own origin. What the sender then learns is that
 * *something* pulled the image, from a data-centre address, with no referrer
 * and no browser fingerprint — and nothing at all about the person who opened
 * the letter, which was the part worth protecting.
 *
 * It is also the safer half of the trade for the frame. A letter rendered with
 * `img-src 'self' data:` and a same-origin proxy keeps that policy exactly as
 * it is; loading the images directly would mean widening it to `img-src *`,
 * which is a permanent hole in the frame in exchange for a round trip.
 *
 * So: proxied, on by default, and `MAIL_REMOTE_IMAGES=false` for a desk that
 * would rather have the strict version back.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { sessionSecret } from '../auth/secret';

/**
 * On unless someone turns it off — the same shape as `sendsHtmlReplies`.
 *
 * A desk answering mail from an address that is mostly targeted at, or one with
 * a rule against outbound connections it did not initiate, sets this to false
 * and gets the count-and-refuse behaviour back.
 */
export function remoteImagesAllowed(): boolean {
  const raw = process.env.MAIL_REMOTE_IMAGES?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !['false', '0', 'no'].includes(raw);
}

/**
 * The signature, and why a proxy needs one.
 *
 * Without it this route is an open fetcher wearing our origin: any signed-in
 * operator — or anything that can make their browser issue a request — could
 * name a URL and have the desk retrieve it. Signing means the only addresses
 * the route will fetch are ones that came out of a letter this desk rendered,
 * because those are the only ones anything has ever put a MAC on.
 *
 * It is not an authorisation check and does not replace one; the route still
 * requires a session. It bounds *what* a request may ask for, which is the part
 * a session cannot say anything about.
 */
function sign(url: string): string {
  return createHmac('sha256', sessionSecret()).update(url).digest('base64url');
}

export function remoteImageUrl(url: string): string {
  return `/api/letter-image?u=${encodeURIComponent(url)}&s=${sign(url)}`;
}

export function signedForFetching(url: string, signature: string): boolean {
  const expected = Buffer.from(sign(url));
  const given = Buffer.from(signature);
  // Length first: `timingSafeEqual` throws rather than returning false when the
  // buffers differ in size, and a thrown comparison is a 500 where a no is
  // wanted.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Addresses the desk will not fetch on a stranger's instruction.
 *
 * This is the part a signature cannot cover, and it is worth being explicit
 * about why: the URL is signed because it came out of a letter, and a letter is
 * written by whoever sent it. `<img src="http://169.254.169.254/latest/meta-data/">`
 * in an email is a request that the desk read its own cloud credentials and hand
 * the bytes back — server-side request forgery with a support address as the
 * entry point. Every private range therefore has to be refused, and refused
 * after the name has been resolved rather than by reading the hostname, because
 * `internal.example.com` can resolve to 10.0.0.1 and usually does when somebody
 * means it to.
 */
const BLOCKED_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier NAT
  /^198\.1[89]\./, /^192\.0\.0\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./,
  /^22[4-9]\./, /^2[3-5]\d\./, // multicast and reserved
];

export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  // An IPv4 address inside an IPv6 wrapper is still that IPv4 address.
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return BLOCKED_V4.some(re => re.test(mapped));

  if (mapped === '::' || mapped === '::1') return true;
  // fc00::/7 unique-local, fe80::/10 link-local, and the v6 documentation range.
  return /^f[cd]/.test(mapped) || /^fe[89ab]/.test(mapped) || mapped.startsWith('2001:db8');
}
