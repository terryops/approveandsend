import { describe, expect, it } from 'vitest';

import { quotedFrom, replyBox } from './reply-box';

describe('finding the quoted mail in a reply', () => {
  it('finds nothing in a reply that is only a reply', () => {
    expect(quotedFrom('Hi Martin,\n\nThat is fixed now.\n\n— The Acme team')).toBe(-1);
  });

  it('finds the attribution line clients write above a quote', () => {
    const text = 'Fixed.\n\nOn Tue, 7 Aug 2026 at 11:00, Martin Oduya wrote:\n> the export is empty';
    expect(text.slice(quotedFrom(text))).toBe(
      'On Tue, 7 Aug 2026 at 11:00, Martin Oduya wrote:\n> the export is empty',
    );
  });

  it('reads the attribution in the languages the desk speaks', () => {
    for (const line of [
      '2026-08-07 11:00 Martin Oduya <martin@example.com> 写道：',
      'Am 07.08.2026 um 11:00 schrieb Martin Oduya:',
      'Le 7 août 2026 à 11:00, Martin Oduya a écrit :',
      'El 7 ago 2026 a las 11:00, Martin Oduya escribió:',
      '2026年8月7日 11:00 Martin Oduya さんは次のように書きました：',
      '-----Original Message-----',
      'From: Martin Oduya <martin@example.com>',
    ]) {
      expect(quotedFrom(`Fixed.\n\n${line}\nthe export is empty`), line).toBe('Fixed.\n\n'.length);
    }
  });

  it('does not mistake a sentence about writing for an attribution', () => {
    // No date in it, which is the whole of the difference. Cutting the box here
    // would hide the quotation the reviewer wrote it to introduce.
    expect(quotedFrom('Here is what the log wrote:\nExport finished, 0 bytes')).toBe(-1);
  });

  it('takes three quoted lines as a thread and one as a quotation', () => {
    expect(quotedFrom('As you said:\n\n> every export is empty\n\nThat is the bug.')).toBe(-1);

    const thread = 'Fixed.\n\n> every export\n> is empty\n> in both browsers';
    expect(thread.slice(quotedFrom(thread))).toBe('> every export\n> is empty\n> in both browsers');
  });

  it('prefers the attribution to the indent below it', () => {
    const text = 'Fixed.\n\nOn 7 Aug 2026, Martin wrote:\n> one\n> two\n> three';
    expect(text.slice(quotedFrom(text), quotedFrom(text) + 3)).toBe('On ');
  });
});

describe('sizing the reply box', () => {
  it('gives a short reply a box you can still write in', () => {
    expect(replyBox('Fixed, sorry about that.')).toEqual({ rows: 10, quoted: false });
  });

  it('grows to the length of a long reply', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(replyBox(text)).toEqual({ rows: 30, quoted: false });
  });

  it('counts the lines a long paragraph wraps onto', () => {
    // 300 columns of prose is four lines of a 76-column box, plus the floor.
    const paragraph = 'x'.repeat(300);
    expect(replyBox(`${paragraph}\n${paragraph}\n${paragraph}`).rows).toBe(12);
  });

  it('counts a Chinese line as twice its length, because it is twice as wide', () => {
    const wide = replyBox('好'.repeat(76));
    const narrow = replyBox('x'.repeat(76));
    expect(wide.rows).toBe(10); // 152 columns → 2 rows, under the floor
    expect(narrow.rows).toBe(10);
    expect(replyBox('好'.repeat(76 * 8)).rows).toBe(16);
  });

  it('halves the width when a translation is beside it', () => {
    const text = 'x'.repeat(76 * 10);
    expect(replyBox(text).rows).toBe(10);
    expect(replyBox(text, { narrow: true }).rows).toBe(20);
  });

  it('stops at the quote, and says that it did', () => {
    const reply = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const thread = Array.from({ length: 200 }, (_, i) => `> old line ${i}`).join('\n');
    const box = replyBox(`${reply}\nOn 7 Aug 2026, Martin wrote:\n${thread}`);
    // The twelve lines of reply, plus a look at the top of the quote.
    expect(box).toEqual({ rows: 16, quoted: true });
  });

  it('refuses to become a mile of textarea for a pasted log', () => {
    const log = Array.from({ length: 400 }, (_, i) => `at frame ${i}`).join('\n');
    expect(replyBox(log)).toEqual({ rows: 80, quoted: false });
  });
});
