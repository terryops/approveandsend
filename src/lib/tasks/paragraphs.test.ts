import { describe, expect, it } from 'vitest';

import { paragraphs } from './paragraphs';

describe('cutting a message into paragraphs', () => {
  it('splits on a blank line', () => {
    expect(paragraphs('Hi there,\n\nMy export is empty.')).toEqual([
      'Hi there,',
      'My export is empty.',
    ]);
  });

  it('keeps the line breaks the sender chose inside a paragraph', () => {
    // Hard-wrapped mail near the 78 columns RFC 5322 suggests is still common,
    // and every one of those breaks is the sender's. Only blank lines go.
    const wrapped = 'I paste a YouTube link under Subtitles,\nthe file is accepted,\nand it stops at 11%.';
    expect(paragraphs(wrapped)).toEqual([wrapped]);
  });

  it('treats a run of blank lines as one break, however long it ran', () => {
    expect(paragraphs('One.\n\n\n\n\nTwo.')).toEqual(['One.', 'Two.']);
  });

  // The case this exists for. A line holding a space, a tab or the
  // non-breaking space an HTML signature leaves behind is blank to a reader
  // and not to a splitter, so it used to arrive as a paragraph of its own: an
  // empty `<p>` with a full line box and a 12px margin, three in a row down
  // the middle of a letter.
  it('drops lines that only look blank', () => {
    expect(paragraphs('One.\n \nTwo.')).toEqual(['One.', 'Two.']);
    expect(paragraphs('One.\n\t\nTwo.')).toEqual(['One.', 'Two.']);
    // The one a signature actually leaves behind.
    expect(paragraphs('One.\n\u00a0\nTwo.')).toEqual(['One.', 'Two.']);
    expect(paragraphs('One.\n \n\u00a0\n\t\n \nTwo.')).toEqual(['One.', 'Two.']);
    // And the whitespace at the end of a line that is not blank stays gone
    // without taking the line with it.
    expect(paragraphs('One.   \nTwo.')).toEqual(['One.\nTwo.']);
  });

  it('drops the empty blocks at either end', () => {
    expect(paragraphs('\n \n\nHello.\n\n \n')).toEqual(['Hello.']);
  });

  it('renders nothing at all for a message with nothing in it', () => {
    expect(paragraphs('')).toEqual([]);
    expect(paragraphs('   \n \n\t')).toEqual([]);
  });

  it('reads a mailbox that still speaks CRLF', () => {
    expect(paragraphs('One.\r\n\r\nTwo.')).toEqual(['One.', 'Two.']);
    expect(paragraphs('One.\r\n \r\nTwo.')).toEqual(['One.', 'Two.']);
    // Lone carriage returns too — old clients, and anything that has been
    // through a converter that only half agreed with itself.
    expect(paragraphs('One.\r\rTwo.')).toEqual(['One.', 'Two.']);
  });

  it('leaves an indented block indented after its first line', () => {
    // The shape support mail arrives in: a lead-in, then the details under it.
    // Trimming the block squares up its left edge; the lines below keep the
    // indentation that makes them a list.
    expect(paragraphs('Most recent example:\n  File: hooks.mp4\n  Duration: 00:05:13')).toEqual([
      'Most recent example:\n  File: hooks.mp4\n  Duration: 00:05:13',
    ]);
  });
});
