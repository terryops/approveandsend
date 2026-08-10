import { describe, expect, it } from 'vitest';

import { mark, type MarkName } from './marks';

/**
 * What the box would hold afterwards, and what would be selected in it.
 *
 * The unit under test returns a replacement over a range, because that is what
 * the browser needs to keep its undo stack. Every assertion here is about the
 * text a reviewer would then be looking at, so the range is applied first —
 * otherwise the tests are about the shape of the return value rather than about
 * whether the button does the right thing.
 */
function press(name: MarkName, value: string, from: number, to = from) {
  const edit = mark(name, value, from, to);
  const after = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
  return {
    after,
    selected: edit.text.slice(edit.select[0], edit.select[1]),
    caret: edit.from + edit.select[0],
  };
}

/** The offsets of `part` in `value`, so the tests read as text rather than sums. */
function at(value: string, part: string): [number, number] {
  const from = value.indexOf(part);
  return [from, from + part.length];
}

describe('wrapping marks', () => {
  it('wraps the selection and keeps it selected', () => {
    const value = 'we can refund that today';
    const { after, selected } = press('bold', value, ...at(value, 'refund'));
    expect(after).toBe('we can **refund** that today');
    expect(selected).toBe('refund');
  });

  it('opens an empty pair with the caret between the halves', () => {
    const { after, caret } = press('italic', 'sorry ', 6);
    expect(after).toBe('sorry **');
    expect(caret).toBe(7);
  });

  it('takes the mark off when the marks sit outside the selection', () => {
    // What a double-click hands over: the word, without its asterisks.
    const value = 'we can **refund** that';
    const { after, selected } = press('bold', value, ...at(value, 'refund'));
    expect(after).toBe('we can refund that');
    expect(selected).toBe('refund');
  });

  it('takes the mark off when the marks sit inside the selection', () => {
    // What dragging across the whole thing hands over: the asterisks too.
    const value = 'we can **refund** that';
    const { after, selected } = press('bold', value, ...at(value, '**refund**'));
    expect(after).toBe('we can refund that');
    expect(selected).toBe('refund');
  });

  it('wraps a selection that starts at the very front of the box', () => {
    // `from - pad.length` is negative here. Looking for the mark in front of a
    // selection that has nothing in front of it has to come back empty rather
    // than counting backwards from the end of the string.
    const { after, selected } = press('bold', 'refund that', 0, 6);
    expect(after).toBe('**refund** that');
    expect(selected).toBe('refund');
  });

  it('marks code with a single backtick', () => {
    const value = 'the id is ORD-9912 there';
    const { after } = press('code', value, ...at(value, 'ORD-9912'));
    expect(after).toBe('the id is `ORD-9912` there');
  });
});

describe('links', () => {
  it('hangs an empty address off the selected words', () => {
    const value = 'see the refund policy for that';
    const { after, caret } = press('link', value, ...at(value, 'refund policy'));
    expect(after).toBe('see the [refund policy]() for that');
    // Inside the parentheses, which is the half still missing.
    expect(after.slice(caret - 1, caret + 1)).toBe('()');
  });

  it('puts the caret in the words when there was no selection', () => {
    const { after, caret } = press('link', '', 0);
    expect(after).toBe('[]()');
    expect(caret).toBe(1);
  });
});

describe('line marks', () => {
  it('bullets every line the selection touches', () => {
    const value = 'one\ntwo\nthree';
    // Three characters in the middle, spanning no line completely.
    const { after } = press('ul', value, 1, 6);
    expect(after).toBe('- one\n- two\nthree');
  });

  it('grows a caret with no selection to the line it sits on', () => {
    const { after } = press('quote', 'as discussed', 4);
    expect(after).toBe('> as discussed');
  });

  it('numbers a numbered list as it goes', () => {
    const value = 'send the form\nwe check it\nyou get the refund';
    const { after } = press('ol', value, 0, value.length);
    expect(after).toBe('1. send the form\n2. we check it\n3. you get the refund');
  });

  it('renumbers a bulleted list rather than marking it twice', () => {
    const value = '- send the form\n- we check it';
    const { after } = press('ol', value, 0, value.length);
    expect(after).toBe('1. send the form\n2. we check it');
  });

  it('takes the mark off when every line already has it', () => {
    const value = '- one\n- two';
    const { after } = press('ul', value, 0, value.length);
    expect(after).toBe('one\ntwo');
  });

  it('completes a part-marked selection instead of stripping it', () => {
    const value = '- one\ntwo\n- three';
    const { after } = press('ul', value, 0, value.length);
    expect(after).toBe('- one\n- two\n- three');
  });

  it('leaves blank lines blank', () => {
    const value = 'one\n\ntwo';
    const { after } = press('ul', value, 0, value.length);
    expect(after).toBe('- one\n\n- two');
    // And the numbering does not count the gap it skipped.
    expect(press('ol', value, 0, value.length).after).toBe('1. one\n\n2. two');
  });

  it('does not reach into the line after a selection ending on a break', () => {
    const value = 'one\ntwo';
    // Selecting "one\n" — the trailing newline is the end of line one, not the
    // start of line two.
    const { after } = press('ul', value, 0, 4);
    expect(after).toBe('- one\ntwo');
  });

  it('marks a heading at level two', () => {
    const { after } = press('heading', 'What happens next', 0);
    expect(after).toBe('## What happens next');
  });

  it('leaves a quote inside a list alone', () => {
    // Quote and list are layers rather than alternatives, so one does not strip
    // the other the way a bullet and a number do.
    const value = '- one';
    const { after } = press('quote', value, 0, value.length);
    expect(after).toBe('> - one');
  });
});
