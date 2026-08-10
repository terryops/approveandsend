/**
 * Whether the reviewer wants their own edits marked in the box.
 *
 * The marks answer a real question — "which of these words are mine rather than
 * the model's" — and it is not a question everybody is asking. A reviewer
 * rewriting a reply from scratch gets a box where nearly every line is under a
 * green wash, which is a true statement about the draft and an unreadable way to
 * edit Chinese, where the block glyphs sit inside the highlight rather than on
 * it. So it is a preference, and the default is on because the marks are the
 * more useful state on the ordinary task: a draft with two sentences changed.
 *
 * `localStorage` rather than a column on the operator. This is a view
 * preference, not a fact about the reply — nothing on the wire changes, no other
 * reviewer is affected, and the send path never reads it. Putting it in the
 * database would mean a migration, a server action and a round trip to answer a
 * question the browser can answer alone, and it would still be wrong for the
 * reviewer who wants the marks on their laptop and off on the shared screen.
 *
 * Everything here is defended against storage throwing, which it does: Safari in
 * private mode, and any browser where the user has denied site data. The
 * fallback is the default rather than an error, so the desk works with the
 * preference simply not being remembered.
 */

const KEY = 'aas.draft-diff';
const EVENT = 'aas:draft-diff';

/** On unless it has been turned off, so a browser that cannot answer says yes. */
export function diffShown(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setDiffShown(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Not remembered, still applied. See the note above.
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Both events, because the preference has two ways of changing.
 *
 * `EVENT` is this tab pressing the button — `storage` does not fire in the tab
 * that wrote it. `storage` is another tab doing the same, and a reviewer working
 * two tasks side by side who turned the marks off did not mean "in this window
 * only".
 */
export function onDiffChange(run: () => void): () => void {
  window.addEventListener(EVENT, run);
  window.addEventListener('storage', run);
  return () => {
    window.removeEventListener(EVENT, run);
    window.removeEventListener('storage', run);
  };
}
