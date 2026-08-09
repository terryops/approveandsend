'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Escape closes the panel, the way it closes every other dialog anybody uses.
 *
 * The confirmation and the redraft prompt only *look* like dialogs — each one is
 * a real page state, `?confirm=1` or `?redraft=1`, rendered on the server so it
 * survives a reload and can be linked to. That is the right design and it has
 * one cost: a browser gives Escape to `<dialog>` for free and gives it to a
 * `<div>` with a scrim over the page not at all. So the panel sat there looking
 * exactly like something Escape would dismiss, and swallowed the key.
 *
 * Dismissing is a navigation, so this does precisely what the "Back to editing"
 * link beside it does, and nothing else. Nothing is posted and nothing is lost
 * that the link would not also lose: `confirmSend` has already written the edits
 * to the row before the confirmation renders, which is what makes going back
 * from here safe in the first place.
 *
 * `replace` rather than `push`, unlike the link. Opening the panel pushed an
 * entry, so pushing another on the way out leaves the panel sitting in the
 * history: the reviewer dismisses it, reaches for Back to return to the inbox,
 * and the thing they just dismissed reopens.
 *
 * `defaultPrevented` is honoured because Escape is not always ours — it closes
 * a native autocomplete or an IME candidate window first, and stealing it there
 * would throw somebody out of the panel mid-word while they were only trying to
 * dismiss a suggestion list.
 */
export function DismissOnEscape({ href }: { href: string }) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      router.replace(href);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [href, router]);

  return null;
}
