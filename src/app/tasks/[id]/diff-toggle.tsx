'use client';

/**
 * The switch for the green marks under the draft.
 *
 * Rendered only where there is something to switch — the card asks for it behind
 * `edit.meaningful` — because a control for a highlight that is not on screen is
 * a control that does nothing, and this card has already thrown two of those out
 * once.
 *
 * Same bargain as `DraftTools` and `DraftOverlay`: without JavaScript this is not
 * in the HTML at all, and it must not be. The marks themselves are added by a
 * script; a button offering to turn off something that was never turned on would
 * be the only broken control on a desk that otherwise degrades cleanly.
 *
 * `useSyncExternalStore` is doing its actual job here rather than standing in
 * for a mount flag. The store is `localStorage` plus two events, which is
 * genuinely external to React and genuinely shared — the same preference is read
 * by `DraftOverlay`, which is a separate component with no tree between them, and
 * written by another tab. The server snapshot is `true` because that is the
 * default the markup is rendered against.
 */

import { useSyncExternalStore } from 'react';

import { diffShown, onDiffChange, setDiffShown } from './diff-pref';

const ON_SERVER = () => true;

export function DiffToggle({ label }: { label: string }) {
  const shown = useSyncExternalStore(onDiffChange, diffShown, ON_SERVER);

  return (
    <button
      // The first submit button in this form sends the reply. Every button in
      // this card says what it is for that reason.
      type="button"
      className={`diff-toggle${shown ? ' active' : ''}`}
      // The state lives here rather than in the wording. A button whose label
      // flips between "show" and "hide" is one a reviewer has to read twice to
      // work out which of the two it is describing — the thing it does, or the
      // thing it is doing now. `aria-pressed` says it once, and correctly, and
      // the stylesheet says the same thing to everybody else.
      aria-pressed={shown}
      title={label}
      onClick={() => setDiffShown(!shown)}
    >
      {label}
    </button>
  );
}
