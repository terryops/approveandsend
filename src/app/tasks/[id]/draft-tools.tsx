'use client';

/**
 * The marks, on buttons, for the reviewers who do not type them.
 *
 * Same bargain as `DraftOverlay` one file over, and made the same way: this
 * renders nothing at all until its own script has run. A toolbar is an
 * enhancement — the box works without it, because the box is a textarea and
 * Markdown is text — and a row of buttons that arrived in the HTML and did
 * nothing because the JavaScript never came would be worse than no row at all.
 * `ready` is the whole of the state on this screen and it means one thing: the
 * script is here, so the buttons can do what they say. See `ON_SERVER` below.
 *
 * Nothing is held about the draft itself. There is one copy of it and it is in
 * the textarea, which is the rule the rest of this screen is built on — these
 * buttons reach into that box, hand it a replacement and let go.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { mark, type MarkName } from '@/lib/tasks/marks';

/**
 * Whether this is running in a browser that ran it.
 *
 * `useSyncExternalStore` rather than the `useState(false)` + `useEffect` pair
 * that says the same thing, because the pair says it by rendering twice and
 * setting state from inside an effect — which React now warns about and the
 * lint rule here rejects outright. The three arguments are the whole answer:
 * nothing to subscribe to, `true` on the client, `false` on the server. The
 * server snapshot is the load-bearing one — it is what keeps the buttons out of
 * the HTML on a desk whose JavaScript never arrives.
 */
const NEVER_CHANGES = () => () => {};
const ON_CLIENT = () => true;
const ON_SERVER = () => false;

/**
 * What each button says, in one glyph.
 *
 * Deliberately the marks themselves rather than icons. `B` and `I` are the two
 * every editor on earth has trained people to read; the rest are the Markdown a
 * press produces, which means the button is also a legend for the syntax the
 * reviewer will see appear in the box. Somebody who presses `1.` twice and looks
 * at what happened has learned the format, and the format is the thing they will
 * need next time the toolbar is not what they reach for.
 */
const TOOLS: { name: MarkName; glyph: string }[] = [
  { name: 'bold', glyph: 'B' },
  { name: 'italic', glyph: 'I' },
  { name: 'ul', glyph: '•' },
  { name: 'ol', glyph: '1.' },
  { name: 'quote', glyph: '❝' },
  { name: 'heading', glyph: '#' },
  { name: 'link', glyph: '🔗' },
];

/**
 * The three every editor already has, on the keys they already use.
 *
 * Only three, and the restraint is the point rather than a corner cut. ⌘B, ⌘I
 * and ⌘K are muscle memory from every mail client and document editor a support
 * agent has ever touched, so they are free to learn and expensive to omit. A
 * shortcut for a blockquote is not muscle memory anywhere — it would be a
 * binding this desk invented, taught nobody, and had to defend against whatever
 * the browser wanted that chord for. The buttons cover those.
 *
 * `⌘` in the hint on a desk that may not be a Mac, which is the same call
 * `review-keys.tsx` already made when it printed `⌘↵` on the send button. One
 * symbol everybody recognises beats a platform sniff that gets it wrong on the
 * first Linux box.
 */
const CHORDS: Record<string, MarkName> = { b: 'bold', i: 'italic', k: 'link' };
const HINTS: Partial<Record<MarkName, string>> = { bold: '⌘B', italic: '⌘I', link: '⌘K' };

/**
 * The reply this toolbar belongs to.
 *
 * Found from the button rather than held in a ref, because the card is rendered
 * by a server component and this one is a sibling inside it — there is no React
 * tree connecting the two, and inventing one would mean making the whole reply
 * card a client component to pass a ref down through it. That is the trade the
 * rest of this screen refuses, and for the same reason: the draft would then be
 * React state, and there would be two copies of it.
 */
function draftOf(button: HTMLElement): HTMLTextAreaElement | null {
  return button.closest('.reply-card')?.querySelector<HTMLTextAreaElement>('textarea.draft') ?? null;
}

function apply(name: MarkName, area: HTMLTextAreaElement | null): void {
  // A sent task renders the same box, read-only. The buttons are hidden there,
  // but "hidden" is a stylesheet's opinion and this is the actual rule.
  if (!area || area.readOnly || area.disabled) return;

  const edit = mark(name, area.value, area.selectionStart, area.selectionEnd);

  area.focus();
  area.setSelectionRange(edit.from, edit.to);

  // `execCommand` is deprecated and is still the only way to put text into a
  // textarea that leaves ⌘Z working. Assigning to `.value` wipes the browser's
  // undo stack, and the field that would lose it is the one holding a reply
  // somebody is about to send to a customer. The fallback covers the day a
  // browser finally drops it: the text is right, only the undo is gone, and it
  // has to fire `input` by hand because a scripted write does not.
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, edit.text);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    area.setRangeText(edit.text, edit.from, edit.to, 'end');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }

  area.setSelectionRange(edit.from + edit.select[0], edit.from + edit.select[1]);
}

export function DraftTools({
  labels,
  group,
}: {
  labels: Record<MarkName, string>;
  group: string;
}) {
  const ready = useSyncExternalStore(NEVER_CHANGES, ON_CLIENT, ON_SERVER);

  // On the document rather than on the textarea, for the reason `ReviewKeys`
  // does the same: the box is rendered by a server component, so there is no
  // React tree between this and it to hang an `onKeyDown` on. The listener earns
  // the right to act by checking what has focus, which it has to do anyway —
  // the reason box and the subject line are textareas too, and neither of them
  // is Markdown.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // `altKey` excluded rather than ignored: ⌥⌘I is the browser's inspector on
      // every platform, and swallowing it to italicise would be this desk taking
      // a key that is not its to take.
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;

      const area = event.target;
      if (!(area instanceof HTMLTextAreaElement) || !area.classList.contains('draft')) return;

      const name = CHORDS[event.key.toLowerCase()];
      if (!name || area.readOnly || area.disabled) return;

      event.preventDefault();
      apply(name, area);
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) return null;

  return (
    <div className="draft-tools" role="group" aria-label={group}>
      {TOOLS.map(({ name, glyph }) => (
        <button
          key={name}
          // The first submit button in this form is Send. A button that forgot
          // to say what it is would mail the customer when somebody pressed
          // bold, which is the most expensive default in HTML.
          type="button"
          title={HINTS[name] ? `${labels[name]} (${HINTS[name]})` : labels[name]}
          aria-label={labels[name]}
          data-mark={name}
          // Keeping the selection, which is the entire point. A mousedown on a
          // button takes focus off the textarea and collapses what was
          // highlighted in it, so by the time a click handler ran there would be
          // nothing left to make bold — and the toolbar, which is only on screen
          // while the draft has focus, would be closing as it was pressed.
          onMouseDown={event => event.preventDefault()}
          onClick={event => apply(name, draftOf(event.currentTarget))}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}
