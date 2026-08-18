'use client';

import { useState } from 'react';

/**
 * The two halves of the redraft panel: the note, and what to do with it.
 *
 * Both buttons submit the same form to the same action and differ only in the
 * `mode` they carry — which is why they are one component. Revise amends the
 * reply on the screen; Rewrite throws it away and tries a different approach.
 *
 * Client-side for one reason: Revise is disabled until there is something in
 * the box. Revising with nothing said is the one combination that cannot work —
 * it asks the model to change the draft in no particular way, and pays a minute
 * of the reviewer's time to be handed back what it already had. Rewrite has no
 * such problem, which is why only one of the two is gated.
 *
 * The gate is an affordance, not a rule. Without JavaScript both buttons post,
 * and the server honours a revise with an empty note rather than quietly
 * promoting it to a rewrite: a reviewer who has hand-edited three sentences and
 * pressed the amend button must not have those sentences thrown away because
 * their browser did not run this file. A revise with no instruction wastes a
 * call; a rewrite nobody asked for loses work.
 */
export function RedraftButtons({
  defaultNote,
  notesLabel,
  placeholder,
  reviseLabel,
  rewriteLabel,
  needNote,
  backLabel,
  backHref,
}: {
  defaultNote: string;
  notesLabel: string;
  placeholder: string;
  reviseLabel: string;
  rewriteLabel: string;
  needNote: string;
  backLabel: string;
  backHref: string;
}) {
  const [note, setNote] = useState(defaultNote);
  const canRevise = note.trim() !== '';

  return (
    <>
      <textarea
        name="notes"
        rows={4}
        autoFocus
        aria-label={notesLabel}
        value={note}
        onChange={event => setNote(event.target.value)}
        placeholder={placeholder}
      />
      <div className="actions">
        {/* Primary, because amending a reply somebody has already read and
            edited is the common case; starting over is the exception. */}
        <button
          className="primary"
          type="submit"
          name="mode"
          value="revise"
          disabled={!canRevise}
          // Said rather than left to be worked out. A greyed-out primary button
          // with no explanation is indistinguishable from a broken one.
          title={canRevise ? undefined : needNote}
        >
          {reviseLabel}
        </button>
        <button type="submit" name="mode" value="rewrite">
          {rewriteLabel}
        </button>
        <a className="button-link" href={backHref}>
          {backLabel}
        </a>
      </div>
      {!canRevise && <p className="meta">{needNote}</p>}
    </>
  );
}
