import { describe, expect, it } from 'vitest';

import { htmlToText } from '../thread-context';
import { replyHtml } from './render';

describe('replyHtml', () => {
  it('makes paragraphs of blank lines and breaks of single ones', () => {
    expect(replyHtml('Hi Ana,\nthanks for writing.\n\nThe refund is on its way.')).toBe(
      '<p>Hi Ana,<br>thanks for writing.</p>\n<p>The refund is on its way.</p>',
    );
  });

  it('escapes what the customer or the model put in the text', () => {
    // A reply quoting a customer's own markup is the ordinary case here, not a
    // contrived one: people paste error messages containing tags.
    const html = replyHtml('You sent us <script>alert(1)</script> & we read it.');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('says the same thing as the text part', () => {
    // The property that matters: the two parts of the mail cannot disagree,
    // because one is derived from the other.
    const text = 'Hi Ana,\n\nYour invoice is attached.\n\n— Support';

    expect(htmlToText(replyHtml(text)).replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'));
  });

  it('is empty for an empty reply, so nothing sends an empty part', () => {
    expect(replyHtml('')).toBe('');
    expect(replyHtml('   \n  ')).toBe('');
  });

  it('collapses runs of blank lines rather than emitting empty paragraphs', () => {
    expect(replyHtml('One\n\n\n\nTwo')).toBe('<p>One</p>\n<p>Two</p>');
  });
});
