/**
 * How tall the reply box should open.
 *
 * It was a fixed 260px with the reply scrolling inside it, which is the one
 * shape a review screen cannot afford: the whole job is reading the reply before
 * it goes, and a box showing two thirds of it asks the reviewer to approve text
 * they have not read. Nobody scrolls a box they were not told was scrolling.
 *
 * So the box opens at the length of what is in it. The exception is a reply that
 * quotes the mail it answers — an unbounded thread the reviewer has already read,
 * which would push the buttons a screen and a half down the page for nothing
 * gained. That one is cut where the quote starts, plus enough of it to see that
 * it is there.
 *
 * A count of rows rather than pixels, and an estimate rather than a measurement:
 * this runs on the server, where nothing knows the width of the box or the
 * metrics of the font. Browsers that support `field-sizing: content` size it
 * exactly and ignore this `rows` — see `textarea.draft` in globals.css. `rows` is
 * what the rest of them get, and being a line or two out is a box with some
 * slack in it rather than a reply nobody read.
 */

/**
 * The line a client writes above a quote.
 *
 * Matched on the verb at the end rather than the date at the start, because the
 * date is the part that differs between every client and the verb is the part
 * that makes the line an attribution. In the languages this desk speaks: a
 * German client writes `Am … schrieb …:` where an English one writes `On … wrote:`
 * for the same act, and a reply read by a reviewer in Chinese may well be
 * quoting `在 … 写道：`.
 *
 * The header separators are the other half. Outlook and its imitators do not
 * write a sentence; they draw a line and start a header block.
 *
 * And every one of them insists on a digit somewhere in the line, which is the
 * cheap way to tell an attribution from a sentence. "The customer wrote:" is
 * prose in a reply and would otherwise cut the box off above the very thing the
 * reviewer was quoting; a real attribution carries the date of the mail.
 */
const ATTRIBUTION = [
  /^(?=.*\d).{0,160}\bwrote\s*:$/i,
  // German puts the name after the verb — `Am 7.8.2026 um 11:00 schrieb Martin:`
  // — so the verb is in the middle of the line rather than at the end of it.
  /^(?=.*\d).{0,160}\bschrieb\b.{0,80}[:：]$/i,
  /^(?=.*\d).{0,160}\ba écrit\s*:$/i,
  /^(?=.*\d).{0,160}\bescribió\s*:$/i,
  /^(?=.*\d).{0,160}(?:写道|寫道)\s*[:：]$/,
  /^(?=.*\d).{0,160}書きました\s*[:：]$/,
  /^-{2,}\s*(?:original message|forwarded message|ursprüngliche nachricht|mensaje original|message d'origine|原始邮件|转发的邮件|原始郵件)/i,
  /^(?:from|von|de|发件人|寄件者|差出人)\s*[:：]\s*\S/i,
];

/** Three of these in a row is a thread, not a reviewer quoting one line. */
const QUOTE_MARK = /^\s{0,3}>/;
const QUOTE_RUN = 3;

/**
 * Where a quoted earlier mail begins, or -1.
 *
 * The attribution line wins over the `>` run when both are present, which is
 * the usual case — the sentence is written above the indent, and cutting below
 * it would leave "On Tuesday, Martin wrote:" as the last thing on the screen
 * with nothing after it.
 */
export function quotedFrom(text: string): number {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }

  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // A blank line is the start of nothing, and the `.{0,160}` patterns would
    // happily match one.
    if (trimmed !== '' && ATTRIBUTION.some(pattern => pattern.test(trimmed))) {
      return offsets[i]!;
    }

    if (QUOTE_MARK.test(line)) {
      run += 1;
      if (run === QUOTE_RUN) return offsets[i - QUOTE_RUN + 1]!;
    } else if (trimmed !== '') {
      // Blank lines between quoted lines are part of the quote; prose is not.
      run = 0;
    }
  }
  return -1;
}

/**
 * Roughly how many characters fit on a line of the box.
 *
 * Two numbers because there are two boxes: the reply sits alone in its card
 * until there is a translation to put beside it, and then the pair splits the
 * width — see `.compare` in globals.css. Counted off the rendered page rather
 * than derived from the type scale, which is why they are round.
 */
const WIDE = 76;
const NARROW = 38;

/**
 * The floor, which is not the ceiling's argument in reverse.
 *
 * A two-line acknowledgement still needs a box somebody can write a reply in —
 * the reviewer is as likely to be adding four paragraphs as approving the two.
 * Kept in step with the `min-height` on `textarea.draft`, which is this same
 * decision said in pixels for the browsers that ignore `rows`.
 */
const MIN_ROWS = 10;

/** Enough of a quote to see that it is a quote: the attribution and the first
 *  lines under it. Nobody reads further into a thread they have already had. */
const QUOTE_TAIL = 3;

/**
 * A ceiling for everything else, which exists for pasted logs rather than for
 * replies. Eighty rows is longer than any mail this desk has sent; a reply that
 * reaches it is a stack trace somebody dropped in the box, and a page that is a
 * mile of textarea helps nobody read it.
 */
const MAX_ROWS = 80;

/** East Asian characters take two columns of a box this narrow. Everything else
 *  counts as one, including the marks that are arguably zero — a reply is not a
 *  terminal and this is not a layout engine. */
function columns(line: string): number {
  let width = 0;
  for (const char of line) {
    const code = char.codePointAt(0)!;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
        ? 2
        : 1;
  }
  return width;
}

export interface ReplyBox {
  /** For the `rows` attribute: the whole reply, or the cut. */
  rows: number;
  /** Whether the cut happened, so the stylesheet can cap the box as well. */
  quoted: boolean;
}

export function replyBox(text: string, options: { narrow?: boolean } = {}): ReplyBox {
  const width = options.narrow ? NARROW : WIDE;
  const cut = quotedFrom(text);
  const shown = cut === -1 ? text : text.slice(0, cut);

  let rows = cut === -1 ? 0 : QUOTE_TAIL;
  for (const line of shown.split('\n')) {
    rows += Math.max(1, Math.ceil(columns(line) / width));
  }

  return {
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows)),
    quoted: cut !== -1,
  };
}
