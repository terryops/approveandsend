'use client';

/**
 * The customer's letter, in a document of its own.
 *
 * A frame rather than a `<div>`, and the reason is not only safety — the
 * sanitiser was already doing that job and would keep doing it if this element
 * were a div. It is that a letter and a desk are two designs, and rendered in
 * one document the desk wins every disagreement between them. The first real
 * mail this screen showed was a forwarded Stripe receipt, and it arrived in the
 * desk's serif with its layout flattened, because `.email-body` sets a reading
 * face and because the widths that held the receipt together had been stripped
 * to stop a letter from resizing our column. Inside a frame neither problem
 * exists: the letter cannot reach our stylesheet, our stylesheet cannot reach
 * the letter, and its own widths are free to be its own widths.
 *
 * What the frame is allowed to do is `sandbox`, and it is worth reading as three
 * separate decisions:
 *
 * - **No `allow-scripts`.** Nothing in the document executes, including inline
 *   handlers and `javascript:` URLs — a second refusal behind the sanitiser's,
 *   and the one a parsing mistake cannot get past.
 * - **`allow-same-origin`.** Only so this component can measure the height of
 *   what is inside. It grants the *document* nothing, because a document that
 *   cannot run script cannot use an origin. Without it the frame is opaque, the
 *   measurement is impossible, and every letter is a fixed-height box with a
 *   scrollbar in it.
 * - **`allow-popups` and `allow-popups-to-escape-sandbox`.** A link in the
 *   letter opens, and opens as a normal page rather than a sandboxed one.
 *   `allow-top-navigation` is deliberately absent: a letter may open a tab and
 *   may not replace the desk.
 *
 * Sized to its content, with a cap. `resize: vertical` on the wrapper is the
 * escape hatch for the letter that is longer than the cap — the same gesture as
 * dragging the reply box, on the one card where "show me more of this" is the
 * whole request.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How tall a letter may be before it scrolls instead.
 *
 * The pane it sits in is one half of a pair, and the other half is the reply the
 * reviewer is judging — a letter allowed to be its own height pushes the answer
 * off the bottom of the screen, and a screen where you cannot see both is the
 * screen this app exists to replace. 560px is the inline version's 460 plus the
 * frame's own padding and the room a real mail design needs before its first
 * paragraph.
 */
const MAX = 560;

/** Before any measurement, and forever in a browser with no JavaScript. */
const UNMEASURED = 320;

export function LetterFrame({ document: srcDoc, title }: { document: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    // `documentElement` and not `body`: the body has margins collapsed into it
    // and a letter whose last element has a bottom margin measures short by
    // exactly that margin, which is a strip of the letter cut off the end.
    const tall = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    setHeight(Math.min(tall, MAX));
  }, []);

  useEffect(() => {
    const el = frame.current;
    const doc = el?.contentDocument;
    if (!el || !doc) return;

    // `load` has usually already fired by the time this effect runs — a srcdoc
    // document is parsed synchronously with the frame — so measuring now is not
    // an optimisation, it is the path that normally happens.
    measure();
    el.addEventListener('load', measure);

    // And again whenever the content changes size under us. Chiefly images:
    // a `cid:` screenshot is fetched from the mailbox after the document has
    // parsed, and the letter grows by the height of it when it lands.
    const observer = new ResizeObserver(measure);
    if (doc.documentElement) observer.observe(doc.documentElement);

    return () => {
      el.removeEventListener('load', measure);
      observer.disconnect();
    };
  }, [measure, srcDoc]);

  return (
    <div className="letter-frame" style={{ height: (height ?? UNMEASURED) + 2 }}>
      <iframe
        ref={frame}
        // The reader of a screen reader meets this as "frame, <subject>" rather
        // than as an unnamed region they have to enter to identify.
        title={title}
        srcDoc={srcDoc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        // Belt to the CSP's braces: no referrer leaves this document, so even a
        // request that somehow escapes `img-src` carries nothing about us.
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
}
