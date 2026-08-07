import { describe, expect, it } from 'vitest';

import { htmlToText } from '../thread-context';
import { replyHtml, replyText } from './render';

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

  it('makes a list of a block of bullets', () => {
    expect(replyHtml('We need:\n\n- the URL\n- the steps')).toBe(
      '<p>We need:</p>\n<ul>\n  <li>the URL</li>\n  <li>the steps</li>\n</ul>',
    );
  });

  it('leaves a dash that is not a bullet alone', () => {
    expect(replyHtml('10:00-19:00 UTC+8 - so it may be tomorrow')).toBe(
      '<p>10:00-19:00 UTC+8 - so it may be tomorrow</p>',
    );
  });

  it('emphasises the sentence the drafter marked', () => {
    expect(replyHtml('**The refund has been issued.** It takes 5-10 days.')).toBe(
      '<p><strong>The refund has been issued.</strong> It takes 5-10 days.</p>',
    );
  });

  it('leaves a lone or unbalanced asterisk as punctuation', () => {
    // Prices and footnote markers are full of these, and turning half a mail
    // bold because somebody wrote `2 * 3` is worse than showing the asterisk.
    expect(replyHtml('2 * 3 and **not closed')).toBe('<p>2 * 3 and **not closed</p>');
  });

  it('cannot be talked into a tag by the text it emphasises', () => {
    const html = replyHtml('**<b>hi</b>**');

    expect(html).toBe('<p><strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>');
  });
});

describe('replyText', () => {
  it('takes the emphasis marks back out and leaves the bullets', () => {
    expect(replyText('**Issued.**\n\n- one\n- two')).toBe('Issued.\n\n- one\n- two');
  });

  it('says the same words as the HTML part', () => {
    // The property that matters more than either rendering: both halves are
    // the one string the reviewer approved, with nothing added or dropped.
    const approved = '**Issued.** Details:\n\n- the URL\n- the steps';

    const words = (value: string) => value.replace(/[-\s]+/g, ' ').trim();

    expect(words(htmlToText(replyHtml(approved)))).toBe(words(replyText(approved)));
  });
});
