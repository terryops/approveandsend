/**
 * A readable summary of what a human changed in a draft.
 *
 * This exists because the edit itself is the training signal and models are
 * bad at spotting it unaided: given two nearly identical letters they tend to
 * summarise the letter rather than the difference. Handing them the diff moves
 * the task from "find the change" to "explain the change", which is the one
 * they are actually good at.
 *
 * Sentence granularity, not word or line. Rules are about what a reply says,
 * and a word diff of reflowed prose is mostly noise about where the newlines
 * moved.
 */

/** Splits into sentences, keeping paragraph breaks as their own boundary. */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap(paragraph =>
      paragraph
        // After ., !, ? or their full-width equivalents, followed by space or EOL.
        .split(/(?<=[.!?。！？])\s+/)
        .map(s => s.replace(/\s+/g, ' ').trim()),
    )
    .filter(Boolean);
}

export interface DiffOp {
  kind: 'keep' | 'remove' | 'add';
  text: string;
}

/**
 * Longest common subsequence over sentences.
 *
 * O(n·m), which is fine: a support reply is tens of sentences. The guard below
 * covers the pathological case rather than the expected one.
 */
export function diffSentences(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;

  // 250×250 is 62k cells — instant. Beyond that something has gone wrong with
  // the input and a coarse answer beats a slow one.
  if (n * m > 62_500) {
    return [
      ...before.map((text): DiffOp => ({ kind: 'remove', text })),
      ...after.map((text): DiffOp => ({ kind: 'add', text })),
    ];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'keep', text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'remove', text: before[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', text: after[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'remove', text: before[i++]! });
  while (j < m) ops.push({ kind: 'add', text: after[j++]! });

  return ops;
}

export interface DiffSummaryOptions {
  /** Sentences per side. Enough to see the pattern, not enough to bloat the prompt. */
  maxEntries?: number;
  maxCharsPerEntry?: number;
}

/**
 * The diff as text for a prompt. Unchanged sentences are omitted entirely —
 * they are already in the prompt as the sent reply, and repeating them buries
 * the part that matters.
 */
export function diffSummary(
  before: string,
  after: string,
  options: DiffSummaryOptions = {},
): string {
  const maxEntries = options.maxEntries ?? 12;
  const maxChars = options.maxCharsPerEntry ?? 300;

  const ops = diffSentences(splitSentences(before), splitSentences(after));
  const removed = ops.filter(op => op.kind === 'remove');
  const added = ops.filter(op => op.kind === 'add');

  if (removed.length === 0 && added.length === 0) {
    return 'No textual change — the draft was sent as written.';
  }

  const format = (ops: DiffOp[], marker: string): string[] => {
    const shown = ops.slice(0, maxEntries).map(op => {
      const text = op.text.length > maxChars ? `${op.text.slice(0, maxChars)}…` : op.text;
      return `${marker} ${text}`;
    });
    if (ops.length > maxEntries) {
      shown.push(`${marker} …and ${ops.length - maxEntries} more`);
    }
    return shown;
  };

  const sections: string[] = [];
  if (removed.length > 0) {
    sections.push(`The human removed:\n${format(removed, '-').join('\n')}`);
  }
  if (added.length > 0) {
    sections.push(`The human wrote instead:\n${format(added, '+').join('\n')}`);
  }

  return sections.join('\n\n');
}
