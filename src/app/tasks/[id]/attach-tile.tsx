'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The tile that adds tiles.
 *
 * One press. It was a fold with a picker and a button inside it, which is three
 * presses to attach one file — open, choose, confirm — and the last of them
 * asks a question that has already been answered: nobody picks a file at an
 * "attach a file" control and then means not to. So the square *is* the picker,
 * and choosing is the whole of it.
 *
 * The button is still in the markup and still works, because choosing cannot
 * submit a form on its own without script. It is hidden the moment this
 * component runs — the same bargain `DraftOverlay` makes one card up: the
 * enhancement arrives when the script does, and what is underneath it is a form
 * that was already complete. A browser with JavaScript off gets a picker and a
 * button beside it, which is what everybody had a moment ago.
 *
 * The strings arrive as props rather than being read here. `t()` resolves the
 * desk's language from the workspace config and the environment, neither of
 * which exists in a browser.
 */
export function AttachTile({
  attach,
  label,
  note,
  addLabel,
  limit,
  tooBig,
}: {
  /** `attachFiles`, handed down so this file does not have to reach for it. */
  attach: (form: FormData) => Promise<void>;
  label: string;
  note: string;
  addLabel: string;
  /** `MAX_UPLOAD_BYTES`, passed rather than imported — see the note below. */
  limit: number;
  /** `task.attachTooBig`, still holding its `{size}` and `{limit}`. */
  tooBig: string;
}) {
  const go = useRef<HTMLButtonElement>(null);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    // A class rather than a React `hidden`, for the reason `DraftOverlay` uses
    // one: this is a fact about the runtime, not about the render, and the
    // server has no way of knowing it in advance either way.
    const button = go.current;
    button?.classList.add('scripted');
    return () => button?.classList.remove('scripted');
  }, []);

  return (
    <>
      {/* A label around the input, so the whole square opens the file dialog
          rather than only the browser's own little button inside it. The input
          stays in the layout at zero opacity instead of being display:none,
          because a hidden input is one the keyboard cannot reach. */}
      <label className="attach-add" title={`${label} · ${note}`}>
        {/* The first drawing in a codebase of typographic marks — `⋯`, `✓`,
            `▾`, `×` — and it is one because there is no paperclip among them.
            The Unicode one is an emoji: colour, somebody else's palette, and a
            cartoon among the tiles. A stroke in `currentColor` instead, so it is
            muted at rest and accent on hover like everything else here. */}
        <svg className="clip" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11.5l-8.6 8.6a5.6 5.6 0 0 1-7.9-7.9l8.6-8.6a3.7 3.7 0 0 1 5.3 5.3l-8.6 8.6a1.9 1.9 0 0 1-2.6-2.6l7.9-7.9" />
        </svg>
        <input
          type="file"
          name="files"
          multiple
          aria-label={label}
          onChange={event => {
            const input = event.currentTarget;
            const chosen = [...(input.files ?? [])];
            // Nothing chosen means the dialog was cancelled, and cancelling is
            // not a request to post an empty form.
            if (chosen.length === 0) return;

            /*
             * Weighed here, before a byte goes anywhere.
             *
             * The server measures this too and refuses politely — but only for
             * a request that reaches it. A server action's body has a ceiling of
             * its own, and past that the framework rejects the POST before our
             * code is ever called: a red runtime error with a stack trace and a
             * link to the Next.js docs, thrown at somebody whose mistake was
             * picking a video. There is nothing on our side that can soften
             * that, so the request is not made.
             *
             * The same sentence the server would have said, from the same key.
             */
            const total = chosen.reduce((sum, file) => sum + file.size, 0);
            if (total > limit) {
              setRefused(
                tooBig
                  .replace('{size}', String(Math.round(total / 1024 / 1024)))
                  .replace('{limit}', String(Math.round(limit / 1024 / 1024))),
              );
              // Emptied, so the picker is not left holding something that is
              // never going to be sent — and so choosing the same file again,
              // after reading this, still counts as a change.
              input.value = '';
              return;
            }

            setRefused(null);

            const form = input.form;
            const button = go.current;
            if (!form || !button) return;

            // Through the button, not the form: this form's own action is
            // `confirmSend`, so submitting it without naming a submitter would
            // answer "I picked a file" with the confirmation panel.
            if (typeof form.requestSubmit === 'function') form.requestSubmit(button);
            else button.click();
          }}
        />
      </label>
      <button ref={go} type="submit" className="attach-go" formAction={attach}>
        {addLabel}
      </button>
      {/* Beside the tile it was refused at, not in the banner at the top of the
          page — the reviewer is looking at the clip they just pressed. `status`
          rather than `alert`: nothing is broken and nothing was lost, they
          picked a file that will not fit. */}
      {refused && (
        <p className="meta attach-refused" role="status">
          {refused}
        </p>
      )}
    </>
  );
}
