'use client';

/**
 * The keyboard, and the one thing the keyboard has to not break.
 *
 * This screen is a treadmill — forty replies in an afternoon — and every one of
 * them costs a trip to the mouse for the same four buttons. `⌘↵` sends, `S`
 * saves, `R` redrafts, `X` dismisses, `J` and `K` walk the queue.
 *
 * Progressive enhancement, and strictly: every one of these presses a button
 * that is already on the page, or follows a link that is already in the rail. If
 * this file never loads, the desk works exactly as it did — which is the deal
 * DESIGN.md makes about client JavaScript, and the only terms on which a
 * shortcut layer is worth having at all.
 *
 * Nothing here holds state. There is one copy of the draft and it is in the
 * textarea; that is the whole reason this screen has no client components.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { diffShown, onDiffChange, setDiffShown } from './diff-pref';

/**
 * Which element the keystroke was meant for.
 *
 * A reviewer typing "save the file" into the draft must not have the `s`
 * dismiss anything. So every bare letter is ignored while a field has focus —
 * `⌘↵` is the exception, because it is unambiguous and because sending from
 * inside the box you just finished typing in is the whole gesture.
 */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable;
}

/** A submit button in the review form, found by the action it is bound to. */
function press(selector: string): boolean {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) return false;
  button.click();
  return true;
}

/**
 * Whether one of the panels is up.
 *
 * The confirmation, the redraft box and the dismiss box all render *over* the
 * review form, which stays in the document behind them — so every selector below
 * still finds its button, and every key still presses something the reviewer
 * cannot see. `X` on the send confirmation posted `askDismiss` and threw the
 * send away; `⌘↵`, printed on the primary button of the panel itself, reached
 * past it to `confirmSend` and re-opened the panel already on screen.
 *
 * The panels have their own keyboard, and it is one key: `dismiss-on-escape.tsx`
 * closes them. While one is open this layer has nothing to say.
 */
function panelOpen(): boolean {
  return document.querySelector('.confirm-scrim') !== null;
}

export function ReviewKeys({ next, previous }: { next: string | null; previous: string | null }) {
  const router = useRouter();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (panelOpen()) return;

      // Never steal a browser or OS combination. `⌘↵` is claimed below and is
      // the only one of these that carries a modifier at all.
      if (event.altKey || event.ctrlKey || event.shiftKey) {
        if (!(event.key === 'Enter' && (event.metaKey || event.ctrlKey))) return;
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        // The form's own action is `confirmSend`, which is the panel rather than
        // the wire — the same thing the primary button does. Nothing is sent by
        // a keystroke without the confirmation being seen.
        if (press('.review-actions button.primary')) event.preventDefault();
        return;
      }

      if (event.metaKey) return;
      if (typing(event.target)) return;

      switch (event.key.toLowerCase()) {
        case 's':
          if (press('.review-actions button[data-key="save"]')) event.preventDefault();
          break;
        case 'r':
          if (press('.review-actions button[data-key="redraft"]')) event.preventDefault();
          break;
        case 'x':
          if (press('.review-actions button[data-key="dismiss"]')) event.preventDefault();
          break;
        case 'j':
          if (next) {
            event.preventDefault();
            router.push(`/tasks/${next}`);
          }
          break;
        case 'k':
          if (previous) {
            event.preventDefault();
            router.push(`/tasks/${previous}`);
          }
          break;
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, previous, router]);

  return null;
}

/**
 * The diff in place of the draft box, switched on only once this has run.
 *
 * The class is added here and never by the stylesheet, and that is the whole of
 * the progressive-enhancement bargain on this card. `.diffing` hides the
 * textarea; a stylesheet-only version would hide it on a desk whose JavaScript
 * never arrived, leaving a read-only diff where the editor should be and no
 * control able to put it back. No script, no class, and the box is the plain
 * editable one it has always been.
 *
 * Nothing is written into the diff itself. Its children come from the server
 * component, so React holds a fiber for every line in it — the predecessor of
 * this function set `textContent` on a subtree React still believed in, and the
 * next reconciliation (a Save redirect, or one of TaskPoller's refreshes) would
 * either `removeChild` a node that was no longer a child, which throws, or
 * quietly update orphans so the new content never appeared. Toggling one class
 * on the wrapper has neither failure.
 *
 * The staleness that used to need handling is gone with the overlay. The marks
 * described the draft as it was last rendered and went wrong on the first
 * keystroke, so they had to be torn down on `input`. This cannot go stale: while
 * it is showing there is no editor to type into, and the moment there is one,
 * this is not on screen.
 */
export function DraftOverlay({ highlighted }: { highlighted: boolean }) {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Nothing to show, nothing to pay for. The prop was taken, listed as a
    // dependency and then never read, so the trick above ran on every task:
    // a reviewer editing an untouched draft was typing into a transparent
    // textarea whose visible glyphs came from a mirror `<div>`, with no marks in
    // it to justify the swap. Any divergence between the two — a font, a
    // padding, a scroll position — was then a bug on every screen instead of on
    // the ones with something to highlight.
    if (!highlighted) return;

    const box = marker.current?.closest<HTMLElement>('.draft-box');
    const diff = box?.querySelector<HTMLElement>('.reply-diff');
    const area = box?.querySelector<HTMLTextAreaElement>('textarea.draft');
    if (!box || !diff || !area) return;

    // …and only if the reviewer wants it. `DiffToggle` writes the same
    // preference and there is no React tree between the two components, so the
    // agreement between them is the store rather than a prop — see `diff-pref`.
    const sync = () => box.classList.toggle('diffing', diffShown());
    sync();
    const stopWatching = onDiffChange(sync);

    // The diff stands where the editor does, so a reviewer who came to type has
    // to get past it — and clicking the thing you want to edit is what everybody
    // tries first. It sets the preference rather than peeking around it: the
    // switch above says what state this card is in, and a view that quietly
    // disagreed with its own control would be worse than the extra click.
    const onClick = () => {
      setDiffShown(false);
      area.focus();
    };

    diff.addEventListener('click', onClick);
    return () => {
      stopWatching();
      diff.removeEventListener('click', onClick);
      box.classList.remove('diffing');
    };
  }, [highlighted]);

  return <span ref={marker} hidden />;
}

/**
 * The half-sentence that has to survive a change of view.
 *
 * The layout switch is a header control — it governs the whole screen and has to
 * be reachable from the top of a long task — which puts it outside the draft's
 * own form. Its POST would otherwise carry nothing, and `setReviewLayout` would
 * have nothing to keep. This fills that form's hidden fields from the real boxes
 * at the moment of submit: a copy that exists for one request, not a second
 * source of truth.
 *
 * On the form's own `submit` rather than the button's `click`, so a keyboard
 * activation is covered too. And read straight off the DOM — importing the
 * values into React state is the thing this screen is built not to do.
 *
 * It *creates* the hidden fields rather than filling ones that are already in
 * the markup, and that is the safe half of the design rather than a detail. An
 * empty `draft` in this POST cannot be told apart from a draft somebody cleared
 * on purpose, so a form that shipped the fields empty and never got a script to
 * fill them would hand `keepEdits` a blank reply and a blank subject to write
 * over the real ones. Absent is a question `keepEdits` can answer; empty is not.
 *
 * So the limit without JavaScript is: the view still switches, and what was last
 * saved is still exactly what it was. Only an unsaved half-sentence is lost, and
 * it is lost the way any unsaved thing is lost by navigating.
 */
export function CarryDraft() {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const form = marker.current?.closest('form');
    if (!form) return;

    const onSubmit = () => {
      const review = document.querySelector<HTMLFormElement>('form.review-form');
      if (!review) return;
      for (const name of ['subject', 'draft', 'notes'] as const) {
        const from = review.querySelector<HTMLTextAreaElement>(`[name="${name}"]`);
        if (!from) continue;
        let to = form.querySelector<HTMLInputElement>(`input[data-carry="${name}"]`);
        if (!to) {
          to = document.createElement('input');
          to.type = 'hidden';
          to.name = name;
          to.dataset.carry = name;
          form.appendChild(to);
        }
        to.value = from.value;
      }
    };

    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, []);

  return <span ref={marker} hidden />;
}
