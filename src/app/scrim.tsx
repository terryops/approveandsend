'use client';

import { useRouter } from 'next/navigation';
import { useRef, type MouseEvent, type ReactNode } from 'react';

import { DismissOnEscape } from './dismiss-on-escape';

/**
 * The dimmed half of a panel, and the second way out of one.
 *
 * The scrim already says the page behind it is not where the decision is. Every
 * overlay anybody has used says the same thing twice — it is dark, *and* a press
 * on it puts you back — and this one said it once, so a reviewer who wanted out
 * of the preview had to find the button. Escape has worked since
 * `DismissOnEscape`, and a keyboard shortcut is not an answer for the hand
 * already holding a mouse.
 *
 * Dismissing is a navigation and nothing more, which is the whole reason this is
 * safe: it does exactly what "Back to editing" beside it does. `confirmSend`
 * wrote the edits to the row before the panel rendered, so there is no state in
 * here to lose — see the note on `DismissOnEscape`, which this renders rather
 * than reimplements, so both exits stay one behaviour.
 *
 * ## Why the press is measured at both ends
 *
 * `event.target === event.currentTarget` is the usual test and on its own it is
 * wrong here. This panel is two columns of mail that people *read*, and reading
 * means selecting: a drag that starts on the last word of the reply and runs off
 * the edge of the card ends with the pointer over the scrim, and a plain click
 * handler reads that release as "clicked outside" and throws the panel away
 * mid-sentence.
 *
 * So the press has to begin and end on the scrim. `mousedown` records where it
 * started, `click` checks it landed in the same place, and a selection that
 * merely finishes out here started on the panel and is left alone.
 *
 * ## Not a `<div role="button">`
 *
 * There is nothing here for a keyboard to focus, and that is correct rather than
 * an omission: this is a pointer affordance duplicating one that a keyboard
 * already has a better key for. Giving the scrim a tab stop would add a
 * focusable, unlabelled element between the reviewer and the buttons that
 * actually decide something, in order to offer Escape a second time under a
 * different name.
 */
/**
 * Whether a press landed on the scrim's own scrollbar rather than on the scrim.
 *
 * The scrim is the scrollport for a panel taller than the window, and a press on
 * a scrollbar is delivered with the scrollport as its target — so without this,
 * dragging the confirmation down to read the end of a long reply and letting go
 * would count as a click outside and throw the panel away. On macOS the overlay
 * scrollbar hides the trap; a classic one on Windows or Linux is a 15px strip
 * down the side of the panel that deletes what you were reading.
 *
 * `clientWidth` excludes the scrollbar gutter and the bounding rect includes it,
 * so the difference between them is exactly the strip to refuse.
 */
function onScrollbar(event: MouseEvent<HTMLDivElement>): boolean {
  const box = event.currentTarget;
  const rect = box.getBoundingClientRect();
  return (
    event.clientX - rect.left >= box.clientWidth || event.clientY - rect.top >= box.clientHeight
  );
}

export function Scrim({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  /** Whether this press began out here rather than on the panel. */
  const outside = useRef(false);

  const down = (event: MouseEvent<HTMLDivElement>) => {
    outside.current = event.target === event.currentTarget && !onScrollbar(event);
  };

  const up = (event: MouseEvent<HTMLDivElement>) => {
    const dismissing = outside.current && event.target === event.currentTarget;
    outside.current = false;
    // `replace`, for the reason the Escape handler uses it: opening the panel
    // pushed a history entry, and pushing another on the way out leaves the
    // panel sitting behind the Back button that was reached for to leave it.
    if (dismissing) router.replace(href);
  };

  return (
    <div className="confirm-scrim" onMouseDown={down} onClick={up}>
      <DismissOnEscape href={href} />
      {children}
    </div>
  );
}
