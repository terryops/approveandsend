/**
 * The edit, visible while it is still being made.
 *
 * `rules/diff.ts` already works out what a human changed — but only for the
 * model, inside `learn-from-sent`, which runs after the mail has gone. The
 * person who made the change has never once seen it.
 *
 * This brings the same diff forward onto the review screen: the model's draft is
 * `task.draft`, what the reviewer is typing is the textarea, and the difference
 * between them is the whole of this edit. One pure call — no model, no IO —
 * computed during the render and thrown away with it.
 *
 * In `lib` rather than in the component because the question it answers, "is
 * this edit worth learning from", is one the learning path may well want to ask
 * with the same answer, and that is not a thing to go looking for in a tsx file.
 */

import { diffSentences, splitSentences, type DiffOp } from '@/lib/rules/diff';

export interface EditPreview {
  /** Sentence-by-sentence keep / remove / add, ready to render. */
  ops: DiffOp[];
  /** Sentences the reviewer wrote. */
  added: number;
  /** Sentences the reviewer cut. */
  removed: number;
  /**
   * Whether this edit is anything at all.
   *
   * An unedited draft teaches nothing — the extractor's own prompt says so — so
   * when this is false the whole panel stays away. A box announcing "this will
   * teach: (nothing)" is worse than no box.
   */
  meaningful: boolean;
  /**
   * The change in one line: the first sentence that went, and the first that
   * arrived in its place.
   *
   * Null when the edit was pure addition or pure deletion — there is no "you
   * changed X into Y" to tell, and inventing half of one would be a sentence
   * about an edit that did not happen. The caller falls back to the count.
   *
   * First rather than longest or most-different, because a reply is written top
   * down and the first thing a human reached for is nearly always the thing they
   * were actually fixing.
   */
  headline: { from: string; to: string } | null;
}

/** Long sentences are quoted, not reproduced: this is a label, not the diff. */
function short(text: string, max = 60): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** One run of the reply, and whether the reviewer is the one who wrote it. */
export interface DraftSegment {
  text: string;
  added: boolean;
}

/**
 * How much of a rewritten sentence is actually the rewrite.
 *
 * The diff is sentence-granular on purpose — see `rules/diff.ts`, where the
 * reader is a model being asked what changed. A human reading their own edit
 * wants the opposite: "3 days" became "5 to 10 working days" is one phrase, and
 * marking the whole sentence around it says nothing that the sentence being
 * there did not already say.
 *
 * So the shared head and tail of the pair are shaved off and only the middle is
 * marked. Characters rather than words, because half the mail this desk answers
 * is written in a script with no spaces in it.
 *
 * Returns the range within the sentence, never empty: a pair that shares
 * everything is not a pair the sentence diff would have produced.
 */
function narrow(raw: string, before: string | null): [number, number] {
  if (!before) return [0, raw.length];

  let head = 0;
  while (head < raw.length && head < before.length && raw[head] === before[head]) head++;

  let tail = 0;
  while (
    tail < raw.length - head &&
    tail < before.length - head &&
    raw[raw.length - 1 - tail] === before[before.length - 1 - tail]
  ) {
    tail++;
  }

  const end = raw.length - tail;
  return end > head ? [head, end] : [0, raw.length];
}

/**
 * The reply as one string again, with the reviewer's own sentences marked.
 *
 * The diff is computed over normalised sentences, so reassembling the text from
 * the ops would give back something *nearly* the same as the draft — different
 * line breaks, collapsed double spaces. Nearly is useless here: this is rendered
 * underneath the textarea, character for character, and one lost newline puts
 * every highlight after it on the wrong words.
 *
 * So the draft itself is what gets returned, cut into runs. Each added sentence
 * is located in it with its own whitespace allowed to differ, and everything
 * between the matches is passed through untouched.
 *
 * Only additions. A deleted sentence is not in this text to point at, and the
 * one question the mark answers — "which of these words are mine rather than the
 * model's" — is about what is there.
 */
export function markAdded(after: string, preview: EditPreview): DraftSegment[] {
  // Each addition alongside whatever it replaced, so the mark can be narrowed to
  // the part that actually changed. `null` for a sentence that was purely added.
  const pairs: { text: string; before: string | null }[] = [];
  let pendingRemoval: string | null = null;
  for (const op of preview.ops) {
    if (op.kind === 'remove') {
      pendingRemoval = op.text.trim();
    } else if (op.kind === 'add') {
      const text = op.text.trim();
      if (text) pairs.push({ text, before: pendingRemoval });
      pendingRemoval = null;
    } else {
      pendingRemoval = null;
    }
  }

  if (pairs.length === 0) return [{ text: after, added: false }];

  const out: DraftSegment[] = [];
  let at = 0;

  for (const { text: sentence, before } of pairs) {
    // The sentence as it appears in the draft, where the whitespace inside it
    // may be a newline rather than the single space `splitSentences` left.
    const pattern = new RegExp(
      sentence
        .split(/\s+/)
        .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+'),
    );
    const rest = after.slice(at);
    const found = pattern.exec(rest);
    // Not found means the reviewer has edited since this diff was computed.
    // Skipping the mark is the honest answer; guessing a position is not.
    if (!found) continue;

    const start = at + found.index;
    const end = start + found[0].length;
    // Only the part of it that is not also in the sentence it replaced.
    const [from, to] = narrow(after.slice(start, end), before);

    if (start + from > at) out.push({ text: after.slice(at, start + from), added: false });
    out.push({ text: after.slice(start + from, start + to), added: true });
    at = start + to;
  }

  if (at < after.length) out.push({ text: after.slice(at), added: false });
  return out;
}

/** Whitespace-normalised on both sides, so a reflowed paragraph is not an edit. */
export function previewEdit(before: string | null, after: string): EditPreview {
  const from = (before ?? '').trim();
  const to = after.trim();

  // Nothing to compare against on a task the model never drafted, and nothing to
  // show when the box still says exactly what it was given.
  if (from === '' || from === to) {
    return { ops: [], added: 0, removed: 0, meaningful: false, headline: null };
  }

  const ops = diffSentences(splitSentences(from), splitSentences(to));
  const gone = ops.filter(op => op.kind === 'remove');
  const arrived = ops.filter(op => op.kind === 'add');

  // Quoted down to the part that actually changed, the same way the marks in the
  // box are. "You changed «3 days» into «5 to 10 working days»" is the edit;
  // repeating both whole sentences around it is the paragraph they were in.
  const headline =
    gone.length > 0 && arrived.length > 0
      ? (() => {
          const before = gone[0]!.text.trim();
          const after2 = arrived[0]!.text.trim();
          const [f, t] = narrow(after2, before);
          const [g, h] = narrow(before, after2);
          return { from: short(before.slice(g, h)), to: short(after2.slice(f, t)) };
        })()
      : null;

  return {
    ops,
    added: arrived.length,
    removed: gone.length,
    meaningful: arrived.length > 0 || gone.length > 0,
    headline,
  };
}
