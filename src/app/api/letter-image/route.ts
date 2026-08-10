import { lookup } from 'node:dns/promises';

import { hasSession } from '@/lib/auth/guard';
import { isRenderableImage } from '@/lib/tasks/attachments';
import {
  isPrivateAddress,
  remoteImagesAllowed,
  signedForFetching,
} from '@/lib/mail/remote-images';

export const dynamic = 'force-dynamic';

/**
 * One picture a letter keeps somewhere else, fetched by the desk rather than by
 * the reviewer.
 *
 * The whole point is the swap of who makes the request. A letter's
 * `<img src="https://…">` loaded directly tells the sender that a person opened
 * their mail, from that person's IP, in that person's browser, at that moment.
 * Loaded through here it tells them that a server pulled an image, with no
 * referrer and no fingerprint — see `remote-images.ts` for the argument in full.
 *
 * Three things guard it, and they guard different things:
 *
 * - a **session**, because this is a support desk and none of it is public;
 * - a **signature**, because otherwise it is a general-purpose fetcher on our
 *   own origin — the only URLs it will retrieve are ones that came out of a
 *   letter this desk rendered;
 * - and an **address check**, because the letter that produced that signed URL
 *   was written by a stranger, and `http://169.254.169.254/` in an email is a
 *   request that the desk read its own cloud credentials out loud.
 */

/** Longer than this and it is not a picture in a letter, it is a payload. */
const MAX_BYTES = 5_000_000;
/** A slow image must not hold a connection open behind a reviewer's page. */
const TIMEOUT_MS = 8_000;

function no(status: number): Response {
  // Deliberately bodiless and uniform. This endpoint answers an `<img>`, which
  // renders nothing either way, and a distinct message per failure would make
  // it a probe for what does and does not resolve inside our network.
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  if (!(await hasSession())) return no(401);
  if (!remoteImagesAllowed()) return no(403);

  const params = new URL(request.url).searchParams;
  const target = params.get('u');
  const signature = params.get('s');
  if (!target || !signature || !signedForFetching(target, signature)) return no(400);

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return no(400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return no(400);

  // Resolved rather than read. A hostname says nothing about where it points,
  // and `internal.example.com` resolving to 10.0.0.1 is the normal case when
  // somebody wants it to. `all: true`, because a name with one public and one
  // private address must fail on the private one.
  try {
    const addresses = await lookup(url.hostname, { all: true });
    if (addresses.length === 0) return no(502);
    if (addresses.some(a => isPrivateAddress(a.address))) return no(403);
  } catch {
    return no(502);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      // No cookies, no redirects it can chain into somewhere private, no
      // referrer. A redirect is refused rather than followed because the
      // address check above applies to the URL we resolved and not to wherever
      // that one decides to send us next.
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'image/*' },
    });
  } catch {
    return no(502);
  }

  if (!upstream.ok || !upstream.body) return no(502);

  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  // The same four formats the attachment route will render, and the same reason:
  // they decode to pixels and nothing else. An SVG served as an image is a
  // document that can carry script, and this one would be on our origin.
  if (!isRenderableImage(type)) return no(415);

  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return no(413);

  // Read to a buffer with the cap enforced on the way, because `content-length`
  // is whatever the sender's server felt like claiming.
  const body = await upstream.arrayBuffer().catch(() => null);
  if (!body || body.byteLength > MAX_BYTES) return no(413);

  return new Response(body, {
    headers: {
      'Content-Type': type,
      // The allowlist above is a check on a label the sender chose. This is what
      // stops a browser deciding the bytes behind it are really HTML.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // Cached in the reviewer's browser and nowhere else. A letter is opened
      // more than once — the review screen, then the confirmation panel — and
      // re-fetching a signature logo on each of those is a second and a third
      // ping to whoever is counting them. Ten minutes covers a review; `private`
      // keeps it out of anything shared.
      'Cache-Control': 'private, max-age=600',
    },
  });
}
