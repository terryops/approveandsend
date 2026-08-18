'use client';

import { useEffect, useState } from 'react';

/**
 * A picture at 56px, and the whole of it one press away without leaving.
 *
 * The tile used to be a plain link to the file, which a browser answers by
 * navigating: the desk disappears, a screenshot fills the window on its own
 * grey background, and getting back to the letter it belongs to is a press of
 * Back. That is the wrong shape for what people actually do here — they read
 * the sentence, look at the screenshot the sentence is about, and go on
 * reading. Leaving the page to do it means the reply and the evidence for it
 * are never on screen at the same time.
 *
 * So the enlargement happens over the page instead. Nothing is fetched twice:
 * the big picture and the tile are the same URL, so it is already in the
 * browser's memory by the time anybody presses it.
 *
 * The anchor stays a real anchor with a real `href`, which is what keeps
 * middle-click, ⌘-click and "open in new tab" working — the overlay is an
 * enhancement on top of a link that already worked, not a replacement for one.
 */
export function ImageThumb({ href, label }: { href: string; label: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      // `defaultPrevented` honoured for the same reason `DismissOnEscape` does:
      // Escape belongs to a native autocomplete or an IME candidate window
      // first, and taking it there closes this on somebody mid-word.
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <a
        className="thumb"
        href={href}
        title={label}
        aria-label={label}
        onClick={event => {
          // Every modified click is somebody asking for a second place to put
          // this — a new tab, a download, another window. Only the plain one is
          // ours to intercept.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={href} alt="" loading="lazy" />
      </a>

      {open && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          // Anywhere outside the picture closes it, which is where a hand goes
          // when it wants the picture gone. The picture itself does not, so a
          // slipped click while looking at it does not throw it away.
          onClick={() => setOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={href} alt={label} onClick={event => event.stopPropagation()} />
          <p className="lightbox-name">{label}</p>
        </div>
      )}
    </>
  );
}
