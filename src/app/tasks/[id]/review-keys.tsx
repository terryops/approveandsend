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
 * The marks under the draft box, switched on only once this has run.
 *
 * A textarea cannot colour part of its own text, so the highlight is a second
 * copy of the same string rendered behind it and the box on top is made
 * transparent. That trick has one failure mode and it is fatal: if the script
 * does not arrive, transparent text in an empty-looking box is an editor nobody
 * can use. So the transparency is added here rather than in the stylesheet —
 * no script, no overlay, and the box is the plain one it has always been.
 *
 * The marks describe the draft as it was last saved. The moment somebody types,
 * they stop being true — so the first keystroke takes the overlay off and the
 * box goes back to being an ordinary opaque textarea until the next render puts
 * a fresh diff underneath. A highlight that is sometimes wrong is worse than one
 * that is sometimes absent; the whole job of this one is to say "these words are
 * yours, those are the model's".
 *
 * Dropping the class rather than rewriting the mirror, and that is the whole of
 * the fix to a bug that was waiting to happen. The mirror's children are
 * rendered by the server component, which means React holds a fiber for each
 * `<mark>` and `<span>` in it. Setting `textContent` threw all of those nodes
 * away while React still believed in them, and the next reconciliation of this
 * subtree — a Save redirect, or one of TaskPoller's two-second refreshes — would
 * either `removeChild` a node that is no longer a child, which throws, or
 * quietly update orphans so the new highlights never appeared. This never writes
 * into the mirror at all; `.draft-mirror` is `display: none` without the class,
 * so taking the class off is enough.
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
    const mirror = box?.querySelector<HTMLElement>('.draft-mirror');
    const area = box?.querySelector<HTMLTextAreaElement>('textarea.draft');
    if (!box || !mirror || !area) return;

    box.classList.add('overlay');

    // A textarea scrolls its own content; the copy underneath has to follow, or
    // the marks slide off the words the moment the reply runs past the box.
    const onScroll = () => {
      mirror.scrollTop = area.scrollTop;
    };

    const onInput = () => {
      box.classList.remove('overlay');
      area.removeEventListener('scroll', onScroll);
      area.removeEventListener('input', onInput);
    };

    area.addEventListener('scroll', onScroll);
    area.addEventListener('input', onInput);
    return () => {
      area.removeEventListener('scroll', onScroll);
      area.removeEventListener('input', onInput);
      box.classList.remove('overlay');
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
