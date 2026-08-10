/**
 * The Markdown a reviewer can apply without knowing Markdown.
 *
 * The renderer has understood bold, italic, code, links, bullets, numbers,
 * quotes and headings since it was written (see `mail/render.ts`), and the desk
 * has never had a way to reach any of it. The box is a plain `<textarea>`, so
 * the marks were available to whoever already had them in their fingers and
 * invisible to everyone else — which on a support desk is most people, and the
 * ones who most need a list to be a list.
 *
 * The work is here rather than in the click handler because it is the part that
 * can be wrong. Where a `**` goes when the selection already has one outside it,
 * what a numbered list does to a selection that is half bullets, where the caret
 * lands afterwards — these are decisions with right answers, and a right answer
 * that only exists inside an event listener is one nothing can check. The
 * component that calls this does three lines of DOM work and no thinking.
 *
 * Everything is expressed as one replacement over one range, never as a new
 * value for the whole box, and that shape is load-bearing rather than tidy: the
 * caller hands it to `execCommand('insertText')`, which is the one way left to
 * change a textarea that the browser's own undo stack still understands. Assign
 * to `.value` instead and ⌘Z stops working on the field a reviewer is about to
 * approve — a worse bug than the one this file fixes.
 */

export type MarkName = 'bold' | 'italic' | 'code' | 'link' | 'ul' | 'ol' | 'quote' | 'heading';

/**
 * One replacement, and where to leave the reviewer afterwards.
 *
 * `select` is relative to `text`, not to the box, because the caller is the only
 * one that knows where `text` will land once the browser has applied it.
 */
export interface Edit {
  /** The range in the current value that `text` stands in for. */
  from: number;
  to: number;
  text: string;
  /** Caret or selection when it is done, as offsets into `text`. */
  select: [number, number];
}

/** The marks that wrap a run of words, and the characters they wrap it in. */
const PAD: Partial<Record<MarkName, string>> = {
  bold: '**',
  italic: '*',
  code: '`',
};

interface LineRule {
  /** Is this line already carrying the mark? */
  has: RegExp;
  /**
   * What comes off before the mark goes on.
   *
   * Wider than `has` for the two list marks, and only for them: a bullet and a
   * number are alternatives rather than layers, so pressing `1.` on a bulleted
   * list should renumber it rather than produce `1. - item`. A quote inside a
   * list is a real thing somebody might mean, so those two are left alone.
   */
  off: RegExp;
  /** The mark itself. Numbered because one of them counts. */
  add: (n: number) => string;
}

const LIST = /^(?:[-*]|\d{1,9}[.)])[ \t]+/;

const LINE: Partial<Record<MarkName, LineRule>> = {
  ul: { has: /^[-*][ \t]+/, off: LIST, add: () => '- ' },
  ol: { has: /^\d{1,9}[.)][ \t]+/, off: LIST, add: n => `${n}. ` },
  quote: { has: /^>[ \t]?/, off: /^>[ \t]?/, add: () => '> ' },
  heading: { has: /^#{1,6}[ \t]+/, off: /^#{1,6}[ \t]+/, add: () => '## ' },
};

/**
 * A mark applied to, or taken off, whatever is selected.
 *
 * `from`/`to` are the textarea's own selection offsets, and an empty selection
 * is not a special case to be rejected — it is the ordinary one. Somebody who
 * presses bold before typing means "the next thing I write is bold", and gets an
 * empty pair with the caret between the halves.
 */
export function mark(name: MarkName, value: string, from: number, to: number): Edit {
  const pad = PAD[name];
  if (pad) return wrap(pad, value, from, to);
  if (name === 'link') return link(value, from, to);

  const rule = LINE[name];
  // Unreachable while `MarkName` is honoured, and cheaper than the alternative:
  // returning something plausible here would put a silent no-op in front of a
  // reviewer instead of a type error in front of whoever added the mark.
  if (!rule) throw new Error(`no such mark: ${name}`);
  return prefix(rule, value, from, to);
}

/**
 * Bold, italic and code: on if it is off, off if it is on.
 *
 * The marks are looked for in two places, and both of them happen. Double-click
 * a bold word and the browser hands over the word *inside* the asterisks; drag
 * across it by hand and you get the asterisks too. A toggle that only understood
 * one of those would un-bold text when the reviewer selected it one way and
 * double-bold it when they selected it the other, which is the kind of bug that
 * reads as the button being broken rather than as the selection being different.
 */
function wrap(pad: string, value: string, from: number, to: number): Edit {
  const selected = value.slice(from, to);

  // Marked, with the marks just outside the selection.
  if (
    from >= pad.length &&
    value.slice(from - pad.length, from) === pad &&
    value.slice(to, to + pad.length) === pad
  ) {
    return {
      from: from - pad.length,
      to: to + pad.length,
      text: selected,
      select: [0, selected.length],
    };
  }

  // Marked, with the marks inside it.
  if (
    selected.length >= pad.length * 2 &&
    selected.startsWith(pad) &&
    selected.endsWith(pad)
  ) {
    const bare = selected.slice(pad.length, -pad.length);
    return { from, to, text: bare, select: [0, bare.length] };
  }

  const text = `${pad}${selected}${pad}`;
  return { from, to, text, select: [pad.length, pad.length + selected.length] };
}

/**
 * `[words](address)`, with the caret in whichever half is still empty.
 *
 * No placeholder text inside either bracket. A `[link](url)` template has to be
 * selected before it can be replaced, and half the time it is not — the reviewer
 * types over some of it, leaves `url` sitting in the middle of the address, and
 * the customer gets a dead link in an approved reply. An empty pair cannot be
 * mistaken for content, and the caret is already in it.
 */
function link(value: string, from: number, to: number): Edit {
  const selected = value.slice(from, to);
  const text = `[${selected}]()`;
  // Words already chosen, so the address is what is missing — and the other way
  // round when the selection was empty.
  const at = selected ? text.length - 1 : 1;
  return { from, to, text, select: [at, at] };
}

/**
 * Lists, quotes and headings, which are properties of whole lines.
 *
 * So the range grows to the lines the selection touches before anything is
 * decided. Half a line cannot be a bullet, and a reviewer who selected three
 * words in the middle of a sentence and pressed the list button meant that
 * sentence.
 *
 * Off only when every line is already marked. A selection where two lines out of
 * three are bullets is somebody finishing a list, not toggling one — so the odd
 * line out joins, rather than the two that were right being stripped.
 */
function prefix(rule: LineRule, value: string, from: number, to: number): Edit {
  const start = value.lastIndexOf('\n', from - 1) + 1;
  // A selection that ends on a line break has not reached the next line, and
  // extending it there would mark a paragraph the reviewer never highlighted.
  const tail = to > from && value[to - 1] === '\n' ? to - 1 : to;
  const found = value.indexOf('\n', tail);
  const end = found === -1 ? value.length : found;

  const lines = value.slice(start, end).split('\n');
  const written = lines.filter(line => line.trim() !== '');
  const marked = written.length > 0 && written.every(line => rule.has.test(line));

  let n = 0;
  const text = lines
    .map(line => {
      // Blank lines are the gaps between paragraphs and stay gaps. Marking them
      // leaves `- ` on a line of its own, which is a bullet with nothing in it
      // in the reply and an empty `<li>` in the customer's mail.
      if (line.trim() === '') return line;
      if (marked) return line.replace(rule.has, '');
      n += 1;
      return rule.add(n) + line.replace(rule.off, '');
    })
    .join('\n');

  return { from: start, to: end, text, select: [0, text.length] };
}
