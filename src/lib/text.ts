/**
 * One kind of line break, decided at the door.
 *
 * A `<textarea>` does not submit what it holds. The HTML form-submission rules
 * say the value is normalised to CRLF on the way out, so every reply a reviewer
 * saves arrives with `\r\n` between its paragraphs — while the same reply
 * written by the model arrives with `\n`, because that came from a JSON payload
 * and never touched a form.
 *
 * The two are the same reply. Nothing downstream agrees: `===` says they differ,
 * `.trim()` does not touch the middle of a string, and every comparison in this
 * codebase is one of those two. What that cost, before this existed:
 *
 *   - `recordDraft` refuses to store a version identical to the last one, so a
 *     history of twenty identical saves cannot bury the one edit that mattered.
 *     A reviewer saving without typing produced `\r\n` against the model's `\n`,
 *     the guard saw a change, and the panel filled with copies of one reply.
 *   - The earlier-drafts panel hides any version equal to what is in the box.
 *     Those copies were not equal by two invisible bytes, so they were listed —
 *     several "earlier drafts" that were the current draft.
 *   - Restoring one of them wrote a text differing from the draft only in `\r`,
 *     and a textarea reports its value with the CRs stripped. The button did its
 *     whole job and the screen could not show it. It read as broken, and the
 *     honest reading of "I pressed it and nothing happened" is that it was.
 *
 * So the fix is not another comparison that ignores `\r`; it is not keeping two
 * spellings of the same text. `\n` is what the model writes, what SQLite stores
 * happiest, and what `mail/render.ts` normalises to anyway before it builds the
 * HTML — this only moves that same decision to the point where the text enters,
 * so that everything after it is comparing like with like.
 *
 * Lone `\r` goes too. It is classic Mac OS and effectively extinct, but it costs
 * one character in the pattern and it is the case that makes a paste from an odd
 * source render as one very long line.
 */
export function newlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
