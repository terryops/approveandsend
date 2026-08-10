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
 * Sized to its content, with a cap, and a button under it for the letters that
 * exceed it.
 *
 * That button replaced a `resize: vertical` on the wrapper, which was the
 * cheaper idea and a broken one. The height here is React state, so the moment
 * anything re-measured — an image landing, which is the common case — the next
 * render wrote the computed height back over whatever the reviewer had dragged
 * the box to. A drag that undoes itself a second later is worse than no drag,
 * and "show me the rest of this" is one question with one answer rather than a
 * dimension to be tuned.
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

export function LetterFrame({
  document: srcDoc,
  title,
  expandLabel,
  collapseLabel,
}: {
  document: string;
  title: string;
  /** Both, so the button is one control rather than a label that changes under
   * the pointer — the reader is told what pressing it does, in their language,
   * and the state is carried by the letter's own height. */
  expandLabel: string;
  collapseLabel: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  /** What the letter measures, uncapped. Null until it has been measured. */
  const [content, setContent] = useState<number | null>(null);
  const [full, setFull] = useState(false);

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    // `documentElement` and not `body`: the body has margins collapsed into it
    // and a letter whose last element has a bottom margin measures short by
    // exactly that margin, which is a strip of the letter cut off the end.
    setContent(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight));
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

  // Only where there is something behind it. A letter that already fits gets no
  // button, for the same reason `DiffToggle` is not rendered when there are no
  // marks to toggle: a control that does nothing is a control in the way, and
  // this screen has thrown two of those out before.
  const truncated = content !== null && content > MAX;
  const height = content === null ? UNMEASURED : full ? content : Math.min(content, MAX);

  return (
    <>
      <div className="letter-frame" style={{ height: height + 2 }}>
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
      {truncated && (
        <button
          // The confirmation panel renders this letter inside the form whose
          // first submit button sends the reply. Every button on this screen
          // says what it is for that reason.
          type="button"
          className="letter-more"
          onClick={() => setFull(open => !open)}
          // The frame is the thing that changes, so it is the thing named — and
          // `aria-expanded` is what makes the pair a disclosure rather than two
          // unrelated buttons a screen reader has to infer a relationship
          // between.
          aria-expanded={full}
        >
          {full ? collapseLabel : expandLabel}
        </button>
      )}
    </>
  );
}
