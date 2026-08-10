/**
 * The customer's letter, as the customer wrote it.
 *
 * This desk used to flatten inbound mail to plain text at ingest and store only
 * that — `htmlToText` and nothing else, a regex pass built to trim a prompt
 * down to a size a model can read. It is the right tool for that job and it was
 * doing a second one it was never meant for: everything a reviewer saw of a
 * letter had been through it. So a table of line items arrived as a column of
 * loose words, `<a href="…">click here</a>` arrived as "click here" with the
 * address deleted, and a screenshot pasted inline arrived as nothing at all.
 * The one screen whose job is to hold a question and its answer side by side
 * was showing a transcript of the question.
 *
 * So the HTML is kept now — see migration 31 — and this is what turns it back
 * into something a browser may render. The sanitiser is the same one the reply
 * preview uses; what is here is the policy for markup written by a stranger,
 * and it differs from our own in exactly two ways.
 *
 * **Remote images do not load.** A `<img src="https://…">` in inbound mail is a
 * read receipt: fetching it tells whoever sent it that the address is real, that
 * a person opened the mail, when they did it and from which IP. Support
 * addresses are scraped and mailed at constantly, and the reviewer opening a
 * pitch to dismiss it should not be confirming the address for the next list it
 * gets sold to. What the letter is asking for is reported instead of fetched —
 * see `remoteImages`, and the line the review screen prints under the letter.
 *
 * **`cid:` images do load**, because those are not remote. An HTML mail with a
 * picture in it carries the picture as an attachment and points at it with a
 * `cid:` reference, which means nothing to a browser; the bytes are in the
 * mailbox we already own, and the desk already has a route that serves them to a
 * signed-in operator. Resolving the reference is the difference between seeing
 * the screenshot somebody sent and seeing a gap where they thought it was.
 */

import { sanitise } from './sanitise';

/** One attachment the letter can point at, and where this desk serves it from. */
export interface InlineImage {
  /** Its Content-ID, angle brackets stripped, as the provider reported it. */
  contentId: string;
  /** The attachment route for it, keyed on our own row id. */
  href: string;
}

export interface LetterOptions {
  /**
   * Where a remote image is served from instead, or absent to refuse it.
   *
   * Injected rather than read from the configuration here, so this file stays a
   * function of its input: the caller decides the policy — see
   * `remoteImagesAllowed` — and the tests can state either one without an
   * environment. Returning null for a particular URL still counts it as
   * refused, which is what the reviewer is told about.
   */
  proxy?: (url: string) => string | null;
}

export interface Letter {
  /** The letter's markup, sanitised. Empty when there was nothing to show. */
  html: string;
  /**
   * The same thing as a whole document, for the frame's `srcdoc`.
   *
   * Empty exactly when `html` is, so one check answers "is there a letter".
   */
  document: string;
  /**
   * How many images the letter asked us to fetch from somewhere else.
   *
   * Counted rather than silently dropped. A newsletter is mostly pictures, and a
   * reviewer looking at the three sentences that survived needs to know they are
   * looking at part of a letter — otherwise the renderer is what looks broken.
   */
  remoteImages: number;
}

/**
 * A `cid:` reference reduced to something two mail clients would agree on.
 *
 * The reference in the body and the Content-ID on the part are written by the
 * same sender and still manage to disagree: one has angle brackets, the other
 * does not; Outlook percent-encodes the `@` in the middle; case is not
 * significant to anyone but a `Map`. Both sides go through here, so a mismatch
 * has to be a real one.
 */
function cidKey(value: string): string {
  let text = value.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // A stray `%` in a Content-ID is not a reason to lose the image. Whatever
    // it was before the decode is still a usable key, as long as the other side
    // of the comparison failed the same way — and it will have, since both go
    // through this function.
  }
  return text.replace(/^</, '').replace(/>$/, '').toLowerCase();
}

/**
 * How much markup is worth rendering.
 *
 * A letter is a document a person wrote; a megabyte of it is a mail client
 * quoting a thread twenty deep inside a table layout, and the sanitiser walks
 * every tag in it on every render of the review screen. Past this the plain-text
 * body is what the reviewer gets, which is what they got for everything before
 * this file existed. Held here rather than at ingest as well as there, so a row
 * already in the database cannot bring the screen down either.
 */
const MAX_HTML = 512_000;

const NOTHING: Letter = { html: '', document: '', remoteImages: 0 };

export function letterHtml(
  html: string | null | undefined,
  images: InlineImage[] = [],
  options: LetterOptions = {},
): Letter {
  if (!html || html.length > MAX_HTML) return NOTHING;

  const inline = new Map(images.map(image => [cidKey(image.contentId), image.href]));
  let remoteImages = 0;

  const clean = sanitise(html, {
    framed: true,
    foreignLinks: true,
    image: src => {
      if (/^cid:/i.test(src)) return inline.get(cidKey(src.slice(4))) ?? null;
      // Its own bytes, inline in the letter. Nothing is fetched to show one, so
      // there is nobody to report the open to — the reason the remote ones are
      // refused does not apply. The sanitiser has already held it to the four
      // raster formats that decode to pixels and cannot carry script.
      if (/^data:/i.test(src)) return src;
      // Somewhere else, which is the one kind the desk has an opinion about.
      // Handed to the proxy it comes back as a URL on our own origin — so the
      // frame's `img-src 'self'` needs no widening and the sender learns
      // nothing about the person reading. Refused, it is counted and the
      // reviewer is told how many.
      const proxied = options.proxy?.(src) ?? null;
      if (proxied) return proxied;
      remoteImages += 1;
      return null;
    },
  });

  const settled = collapse(clean);

  // Markup with nothing in it is not a letter, and the caller has a plain-text
  // body that might be. This is what a mail whose whole body was one tracking
  // pixel leaves behind, and rendering it instead of the text is a blank card
  // where a message was.
  const text = settled.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').trim();
  const shows = text !== '' || /<(?:img|hr)\b/i.test(settled);
  if (!shows) return { ...NOTHING, remoteImages };

  return { html: settled, document: letterDocument(settled), remoteImages };
}

/**
 * The letter as a document of its own, for the frame to hold.
 *
 * Rendered inline first, and the screenshot of the first real one is the whole
 * argument for this function. A forwarded Stripe receipt came out in the desk's
 * serif reading face — because `.email-body` sets one and the letter, having no
 * document, inherited it — with its blue field stretched the width of the pane
 * and its card squeezed into the left third, because the widths that held it
 * together had been stripped. Every part of that is our page leaking into
 * somebody else's design, and a boundary is the only thing that stops it.
 *
 * Three things the frame gets that the inline version could not have:
 *
 * A **sans-serif default**, because that is what every mail client renders into
 * and therefore what every mail was designed against. Our serif is for reading
 * the desk's own prose.
 *
 * Its **own layout context**, so `width`, `display` and `position` can be
 * allowed — see `framed` in `sanitise.ts`. A 600px table is 600px wide and the
 * frame scrolls, rather than the table collapsing and the letter lying about
 * what it looked like.
 *
 * And a **policy the browser enforces**, below.
 */
function letterDocument(body: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${FRAME_CSS}</style>
</head><body>${body}</body></html>`;
}

/**
 * What the frame is permitted to do, said to the browser rather than to us.
 *
 * The sanitiser has already removed every script, every handler and every
 * remote `src` — this is the same refusals made a second time by the one party
 * that cannot be talked out of them by a parsing mistake. `default-src 'none'`
 * is the shape: nothing may be fetched unless it is named.
 *
 * `img-src 'self' data:` is the interesting line and it is what makes the
 * no-remote-images promise structural instead of a property of my regex. Our
 * own origin is the `cid:` images, served from the attachment route; `data:` is
 * the ones already inside the letter. A tracking pixel that got past the
 * sanitiser still does not load.
 *
 * `style-src 'unsafe-inline'` and nothing else: the letter's own `<style>` and
 * `style=` attributes work, and `@import url(…)` — which is a stylesheet
 * fetched from wherever the sender likes — has no source it is allowed to come
 * from. `script-src` is absent, so it falls to `'none'`; the sandbox attribute
 * on the frame says the same thing again.
 */
const CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * The frame's own stylesheet: a starting point, not a design.
 *
 * Everything here is either what a mail client would have done anyway (a sans
 * default, white behind the letter) or containment (`max-width` on the things
 * that would otherwise force the frame sideways). The letter's own rules come
 * after and win, which is the point — this is the floor a sender designed
 * against, not an opinion about how their mail should look.
 */
const FRAME_CSS = `
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; padding: 12px 14px;
    background: #fff; color: #1a1a1a;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
    overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; overflow-wrap: break-word; }
  a { color: #1a4fd6; }
  /* The letter is measured by its content — see \`LetterFrame\` — so a page-level
     scrollbar inside the frame would mean the measurement was wrong. Sideways is
     different: one 900px table is the sender's, and it scrolls in place rather
     than stretching the frame and the column it sits in. */
  body { overflow-x: auto; }
`;

/**
 * The elements with nothing left inside them.
 *
 * Mostly ones we emptied: a refused tracking pixel was somebody's whole
 * paragraph, and what is left is `<p></p>` — a full line box and a 12px gap in
 * the middle of the letter, the same complaint `paragraphs` makes about the text
 * version. The sender did not leave a blank line there; we made one.
 *
 * And some that arrived empty. `<a name="top"></a>` is a bookmark for an
 * in-mail table of contents: it has no words, it has no address once `name` is
 * dropped, and left in place it is an anchor tag around nothing.
 *
 * Repeated, because emptying the inner element is what makes the one around it
 * empty, and a marketing mail nests four deep. Bounded rather than looped to
 * fixpoint: the depth of real mail is single digits, and a bound is one fewer
 * thing that can spin on input somebody else chose.
 */
const EMPTY = /<(p|div|span|a|font|td|tr|table|blockquote|h[1-6])\b[^>]*>\s*<\/\1\s*>/gi;

function collapse(html: string): string {
  let out = html;
  for (let pass = 0; pass < 6; pass += 1) {
    const next = out.replace(EMPTY, '');
    if (next === out) break;
    out = next;
  }
  return out;
}
