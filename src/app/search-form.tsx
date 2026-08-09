'use client';

import { useRouter } from 'next/navigation';
import type { FormEvent } from 'react';

/**
 * The inbox search box, and one of the four client components on this desk.
 *
 * Everything else on this desk navigates through `next/link`, which patches the
 * DOM rather than reloading the document. A `method="get"` form cannot: the
 * browser owns that submit, and it hands the whole page back from the server —
 * so the one control on the main screen that somebody uses over and over was
 * also the only one that made the screen blink.
 *
 * Progressive enhancement rather than a replacement. The element underneath is
 * still a real `<form method="get" action="/">` with a real named field, so with
 * JavaScript off, or before it has loaded, submitting does exactly what it did
 * before and lands on exactly the same URL. `onSubmit` only intercepts the case
 * where the router is there to do it better.
 *
 * Uncontrolled on purpose. Reading the value out of the form at submit time
 * keeps the promise the rest of the app makes — there is no client copy of what
 * you typed that can disagree with what gets sent — and it means no state, no
 * re-render per keystroke, and a box that keeps your query on the way back.
 */
export function SearchForm({
  defaultValue,
  placeholder,
  submitLabel,
}: {
  defaultValue: string;
  placeholder: string;
  submitLabel: string;
}) {
  const router = useRouter();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entered = new FormData(event.currentTarget).get('q');
    const query = typeof entered === 'string' ? entered.trim() : '';
    // An empty box means "stop searching", which is the bare inbox rather than
    // a search for nothing — the same URL the Clear link points at.
    router.push(query ? `/?q=${encodeURIComponent(query)}` : '/');
  }

  return (
    <form className="row searchbar" method="get" action="/" onSubmit={onSubmit}>
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <button type="submit">{submitLabel}</button>
    </form>
  );
}
