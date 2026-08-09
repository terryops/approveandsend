import { describe, expect, it } from 'vitest';

import { htmlToText } from '../thread-context';
import { previewHtml, replyHtml, replyText } from './render';

describe('replyHtml', () => {
  it('makes paragraphs of blank lines and breaks of single ones', () => {
    expect(replyHtml('Hi Ana,\nthanks for writing.\n\nThe refund is on its way.')).toBe(
      '<p style="margin:0 0 12px">Hi Ana,<br>thanks for writing.</p>\n<p style="margin:0 0 12px">The refund is on its way.</p>',
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
    expect(replyHtml('One\n\n\n\nTwo')).toBe('<p style="margin:0 0 12px">One</p>\n<p style="margin:0 0 12px">Two</p>');
  });

  it('makes a list of a block of bullets', () => {
    expect(replyHtml('We need:\n\n- the URL\n- the steps')).toBe(
      '<p style="margin:0 0 12px">We need:</p>\n<ul style="margin:0 0 12px;padding-left:22px">\n  <li>the URL</li>\n  <li>the steps</li>\n</ul>',
    );
  });

  it('leaves a dash that is not a bullet alone', () => {
    expect(replyHtml('10:00-19:00 UTC+8 - so it may be tomorrow')).toBe(
      '<p style="margin:0 0 12px">10:00-19:00 UTC+8 - so it may be tomorrow</p>',
    );
  });

  it('emphasises the sentence the drafter marked', () => {
    expect(replyHtml('**The refund has been issued.** It takes 5-10 days.')).toBe(
      '<p style="margin:0 0 12px"><strong>The refund has been issued.</strong> It takes 5-10 days.</p>',
    );
  });

  it('leaves a lone or unbalanced asterisk as punctuation', () => {
    // Prices and footnote markers are full of these, and turning half a mail
    // bold because somebody wrote `2 * 3` is worse than showing the asterisk.
    expect(replyHtml('2 * 3 and **not closed')).toBe('<p style="margin:0 0 12px">2 * 3 and **not closed</p>');
  });

  it('cannot be talked into a tag by the text it emphasises', () => {
    const html = replyHtml('**<b>hi</b>**');

    expect(html).toBe('<p style="margin:0 0 12px"><strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>');
  });

  /*
   * The marks that were missing, and the reason each one is here: a support
   * answer is a numbered procedure, a link to the page the customer needs, and
   * an order id that has to be legible as an id.
   */
  it('numbers a run of numbered lines, and keeps the number the reviewer started on', () => {
    expect(replyHtml('1. open Exports\n2. copy the id')).toBe(
      '<ol style="margin:0 0 12px;padding-left:22px">\n  <li>open Exports</li>\n  <li>copy the id</li>\n</ol>',
    );
    // A procedure continued after a paragraph is somebody counting deliberately.
    expect(replyHtml('4. press Save')).toContain('<ol style="margin:0 0 12px;padding-left:22px" start="4">');
  });

  it('makes a section title of a hash, at a size relative to the reader', () => {
    expect(replyHtml('# What I can see')).toBe(
      '<h2 style="margin:0 0 8px;font-size:1.3em;line-height:1.3">What I can see</h2>',
    );
    expect(replyHtml('## Next steps')).toContain('<h3 style="margin:0 0 8px;font-size:1.15em');
    // Past the third level it is bold at body size: a reply nested that deep has
    // a bigger problem than its type.
    expect(replyHtml('#### Detail')).toContain('font-size:1em');
    // Never `<h1>`: that claims to be the title of the document it is in, and
    // the document is the reader's mailbox.
    expect(replyHtml('# x')).not.toContain('<h1');
  });

  it('needs the space, so a channel and a rank stay prose', () => {
    expect(replyHtml('#1 priority is the export')).toBe(
      '<p style="margin:0 0 12px">#1 priority is the export</p>',
    );
    expect(replyHtml('Ask in #support')).toContain('<p style="margin:0 0 12px">Ask in #support');
  });

  it('never runs two headings together into one title', () => {
    expect(replyHtml('# One\n# Two')).toBe(
      '<h2 style="margin:0 0 8px;font-size:1.3em;line-height:1.3">One</h2>\n' +
        '<h2 style="margin:0 0 8px;font-size:1.3em;line-height:1.3">Two</h2>',
    );
  });

  it('does not mistake a time or a version for a list', () => {
    expect(replyHtml('10:00-19:00 UTC+8')).toBe('<p style="margin:0 0 12px">10:00-19:00 UTC+8</p>');
    expect(replyHtml('2.5 is the version you want')).toContain('<p style="margin:0 0 12px">2.5 is');
  });

  it('starts a list where the bullets start, without needing a blank line first', () => {
    expect(replyHtml('We need:\n- the URL\n- the steps')).toBe(
      '<p style="margin:0 0 12px">We need:</p>\n<ul style="margin:0 0 12px;padding-left:22px">\n  <li>the URL</li>\n  <li>the steps</li>\n</ul>',
    );
  });

  it('links the words the reviewer chose, and only to somewhere a link can go', () => {
    expect(replyHtml('See [the export page](https://acme.example/exports).')).toBe(
      '<p style="margin:0 0 12px">See <a href="https://acme.example/exports">the export page</a>.</p>',
    );
    // Not a scheme a mail client would follow, so it stays the text that was
    // typed — visible and fixable rather than a link that silently does nothing.
    expect(replyHtml('[click](javascript:alert(1))')).toBe(
      '<p style="margin:0 0 12px">[click](javascript:alert(1))</p>',
    );
  });

  it('keeps an id legible as an id, and does not read marks inside one', () => {
    expect(replyHtml('Send me `exp_1a2b**3c`.')).toBe(
      '<p style="margin:0 0 12px">Send me <code>exp_1a2b**3c</code>.</p>',
    );
  });

  it('fences a pasted log, blank lines and all', () => {
    const html = replyHtml('Here is what we see:\n\n```\nERROR rows=0\n\nretry: 3\n```');

    expect(html).toContain('<pre style="margin:0 0 12px;white-space:pre-wrap;overflow-wrap:break-word"><code>');
    expect(html).toContain('ERROR rows=0\n\nretry: 3');
    // Ours are marks too, and a fence is where marks stop.
    expect(replyHtml('```\n**not bold**\n```')).toContain('**not bold**');
  });

  it('quotes what the customer wrote', () => {
    expect(replyHtml('> the file is empty')).toBe(
      '<blockquote style="margin:0 0 12px;padding-left:12px;border-left:2px solid">the file is empty</blockquote>',
    );
  });

  it('emphasises one asterisk, but never inside a word', () => {
    expect(replyHtml('That is *urgent*.')).toContain('<em>urgent</em>');
    // An identifier is one word to a person; half of it in italics is a bug
    // report we would have caused.
    expect(replyHtml('created_at*name*here')).not.toContain('<em>');
    expect(replyHtml('2 * 3')).not.toContain('<em>');
  });

  it('cannot be talked into markup by the placeholder it uses internally', () => {
    // `inline` parks held fragments behind NUL. A reply containing one must not
    // be able to reach in and pull a fragment of our own markup out.
    expect(replyHtml('a\u00000\u0000b **c**')).toBe(
      '<p style="margin:0 0 12px">a0b <strong>c</strong></p>',
    );
  });
});

describe('replyText', () => {
  it('takes the emphasis marks back out and leaves the bullets', () => {
    expect(replyText('**Issued.**\n\n- one\n- two')).toBe('Issued.\n\n- one\n- two');
  });

  it('takes the new marks out too, and keeps the address a link pointed at', () => {
    expect(replyText('Send me `exp_1a2b` from *the top row*.')).toBe(
      'Send me exp_1a2b from the top row.',
    );
    // The href has nowhere to live on this side, so it is spelled out. The two
    // halves still say the same thing — over there it is in the attribute.
    expect(replyText('See [the export page](https://acme.example/exports).')).toBe(
      'See the export page (https://acme.example/exports).',
    );
    // Already the address, so not said twice.
    expect(replyText('[https://acme.example](https://acme.example)')).toBe('https://acme.example');
  });

  it('drops the hashes but keeps the line the heading was', () => {
    // `- one` is what a bullet looks like to anybody; `# What to do next` is
    // what markup looks like to a customer.
    expect(replyText('# What I can see\n\nThe rows are empty.')).toBe(
      'What I can see\n\nThe rows are empty.',
    );
  });

  it('leaves the structure a plain-text reader can already see', () => {
    expect(replyText('1. open Exports\n2. copy the id')).toBe('1. open Exports\n2. copy the id');
    expect(replyText('> the file is empty')).toBe('> the file is empty');
    // The fence is scaffolding for a renderer; the lines inside it are the point.
    expect(replyText('```\nERROR rows=0\n```')).toBe('ERROR rows=0');
  });

  it('stops taking marks out where the fence starts', () => {
    // The fence means literal, and it has to mean that in both halves of the
    // mail or the halves say different things about the one place a customer is
    // most likely to be copying characters out of. This used to drop the ```
    // lines and then run every mark over the log line inside them, so the HTML
    // part quoted it exactly and the plain-text part sent it with the asterisks
    // and backticks silently removed.
    const pasted = 'Here is the log:\n\n```\nERROR **fatal** at [main](x) `tick`\n```\n\nThanks.';

    expect(replyText(pasted)).toContain('ERROR **fatal** at [main](x) `tick`');
    // And prose on either side of the fence is still prose.
    expect(replyText('**Issued.**\n\n```\n**kept**\n```\n\n*See* above.')).toBe(
      'Issued.\n\n**kept**\n\nSee above.',
    );
    // An unclosed fence runs to the end here for the reason it does in `blocks`:
    // if the two disagreed about where the snippet stopped, so would the mail.
    expect(replyText('```\n**one**\n\n**two**')).toBe('**one**\n\n**two**');
  });

  it('says the same words as the HTML part', () => {
    // The property that matters more than either rendering: both halves are
    // the one string the reviewer approved, with nothing added or dropped.
    const approved = '**Issued.** Details:\n\n- the URL\n- the steps';

    const words = (value: string) => value.replace(/[-\s]+/g, ' ').trim();

    expect(words(htmlToText(replyHtml(approved)))).toBe(words(replyText(approved)));
  });
});

/**
 * The three ways a reply can be written.
 *
 * The property under test is the one the top of `render.ts` claims and that the
 * HTML format is most able to break: whatever the reviewer picked, the two parts
 * of the mail say the same thing. `html` is the interesting case — it is the one
 * format where the box is not the plain-text half, so the plain-text half has to
 * be derived from it rather than sent as it.
 */
describe('reply formats', () => {
  it('leaves markdown as the default, so replies written before the choice existed are unchanged', () => {
    expect(replyHtml('**Done.**')).toBe(replyHtml('**Done.**', 'markdown'));
    expect(replyText('**Done.**')).toBe(replyText('**Done.**', 'markdown'));
    expect(replyText('**Done.**', 'markdown')).toBe('Done.');
  });

  it('sends plain text as typed, marks and all', () => {
    // Someone choosing this format is usually pasting something the marks would
    // eat: a log line opening with a dash, or a literal pair of asterisks.
    expect(replyText('- 2 * 3 and **stars**', 'text')).toBe('- 2 * 3 and **stars**');
    expect(replyHtml('- one\n- two', 'text')).toBe(
      '<p style="margin:0 0 12px">- one<br>- two</p>',
    );
    expect(replyHtml('**not bold**', 'text')).toContain('**not bold**');
  });

  it('still escapes in plain-text format, so a pasted tag stays a tag on screen', () => {
    expect(replyHtml('Use <b>this</b>', 'text')).toContain('&lt;b&gt;');
    expect(replyHtml('Use <b>this</b>', 'text')).not.toContain('<b>this</b>');
  });

  it('sends authored HTML as written', () => {
    const authored = '<p>Hi Tom,</p><table><tr><td>Plan</td><td>Pro</td></tr></table>';
    expect(replyHtml(authored, 'html')).toBe(authored);
  });

  it('derives the plain-text half from the HTML rather than shipping tags', () => {
    const authored = '<p>Hi Tom,</p>\n<p>Your refund is on its way.</p>';
    const text = replyText(authored, 'html');

    expect(text).not.toContain('<');
    expect(text).toContain('Hi Tom,');
    expect(text).toContain('Your refund is on its way.');
  });

  it('says the same thing in both parts, in every format', () => {
    // The guarantee the whole file exists for, asserted across the new axis.
    const cases: [string, 'text' | 'markdown' | 'html'][] = [
      ['Hi,\n\nAll done.', 'markdown'],
      ['Hi,\n\nAll done.', 'text'],
      ['<p>Hi,</p>\n<p>All done.</p>', 'html'],
    ];

    for (const [source, format] of cases) {
      const fromHtml = htmlToText(replyHtml(source, format)).replace(/\s+/g, ' ').trim();
      const fromText = replyText(source, format).replace(/\s+/g, ' ').trim();
      expect(fromHtml).toBe(fromText);
    }
  });
});

/**
 * The preview, which exists because the format used to apply only inside the
 * send path — so the confirmation panel showed `**bold**` and the customer got
 * bold text, on the one screen whose whole purpose is showing what goes out.
 */
describe('previewHtml', () => {
  it('is the mail, so the screen and the recipient cannot disagree', () => {
    for (const format of ['markdown', 'text'] as const) {
      expect(previewHtml('Hi,\n\n**Done.**', format)).toBe(replyHtml('Hi,\n\n**Done.**', format));
    }
  });

  it('passes every mark this desk can write straight through', () => {
    // The sanitiser is an allowlist, and an allowlist that does not know about
    // our own renderer is a preview that quietly shows less than the mail. Every
    // tag `replyHtml` emits has to survive it, attributes included.
    const written = [
      'Try [the export page](https://acme.example/exports) and send me `exp_1a2b`.',
      '',
      '4. open Exports',
      '5. copy the id',
      '',
      '> the file is empty',
      '',
      '```',
      'ERROR rows=0',
      '```',
    ].join('\n');

    expect(previewHtml(written)).toBe(replyHtml(written));
    expect(previewHtml(written)).toContain('start="4"');
    expect(previewHtml(written)).toContain('<a href="https://acme.example/exports">');
  });

  it('renders the marks the reviewer typed rather than showing them', () => {
    expect(previewHtml('**API** access is paid.')).toContain('<strong>API</strong>');
    expect(previewHtml('**API** access is paid.')).not.toContain('**API**');
  });

  it('drops what no mail client would run either, without touching what is sent', () => {
    const hostile = '<p>Hi</p><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(1)">x</a>';

    const preview = previewHtml(hostile, 'html');
    expect(preview).not.toContain('<script');
    expect(preview).not.toContain('onclick');
    expect(preview).not.toContain('javascript:');
    expect(preview).toContain('<p>Hi</p>');

    // The sent mail is deliberately untouched by the preview's hardening.
    expect(replyHtml(hostile, 'html')).toBe(hostile);
  });

  /*
   * Every one of these went through the blacklist this replaced, and the first
   * two went through it without needing a trick: `<svg/onload=` has no space in
   * front of the handler, and the pattern required one.
   *
   * The reason this matters is who writes the markup. In `html` format the draft
   * is the model's, and the model wrote it after reading mail from a stranger —
   * so the input to this function is reachable by whoever sent the email, and the
   * output goes to `dangerouslySetInnerHTML` in a logged-in reviewer's session.
   */
  it('is an allowlist, so the tricks that beat a blacklist do not apply', () => {
    const payloads = [
      '<svg/onload=alert(1)>',
      '<img/onerror=alert(1) src=x>',
      '<img src=x onerror=alert(1)>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="java&#9;script:alert(1)">x</a>',
      '<a href="java&Tab;script:alert(1)">x</a>',
      '<A HREF="JaVaScRiPt:alert(1)">x</A>',
      '<button formaction="javascript:alert(1)">x</button>',
      '<form><button formaction=javascript:alert(1)>x</button></form>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<style>*{x:expression(alert(1))}</style>',
      '<div style="background:url(javascript:alert(1))">x</div>',
      // The quoted `>` used to end the tag early and leave the handler behind.
      '<a title="a>b" onclick=alert(1)>x</a>',
      '<!--><script>alert(1)</script>-->',
    ];

    for (const payload of payloads) {
      const preview = previewHtml(payload, 'html');
      expect(preview, payload).not.toMatch(/\son[a-z]+\s*=/i);
      expect(preview, payload).not.toMatch(/javascript:/i);
      expect(preview, payload).not.toMatch(/<(script|iframe|svg|form|button|style)\b/i);
      expect(preview, payload).not.toMatch(/formaction|expression\s*\(/i);
    }
  });

  it('keeps the markup a reply is actually written with', () => {
    expect(previewHtml('<a href="https://x.example/a?b=1&amp;c=2">go</a>', 'html')).toBe(
      '<a href="https://x.example/a?b=1&amp;c=2">go</a>',
    );
    expect(previewHtml('<table><tr><td colspan="2">x</td></tr></table>', 'html')).toBe(
      '<table><tr><td colspan="2">x</td></tr></table>',
    );
    // A tag that is not on the list loses the tag and keeps the words. Hiding
    // part of a reply from the one person whose job is to read all of it is the
    // worse failure.
    expect(previewHtml('<marquee>Refund issued</marquee>', 'html')).toBe('Refund issued');
  });

  it('never shows less of the reply than the send carries', () => {
    // The stripped-whole pattern used to end at "…or the end of the string", so
    // a single unclosed or self-closing one of them deleted the entire rest of
    // the panel while `replyHtml` — the thing that actually goes out — kept it.
    // An inline icon is enough to do it, and the reviewer approves what is left.
    const withIcon = '<p>Your refund of £40 has been issued.</p><svg viewBox="0 0 8 8"/><p>It lands in 3-5 days.</p>';
    const unclosed = '<div>Kept<style>and this too';

    expect(previewHtml(withIcon, 'html')).toContain('It lands in 3-5 days.');
    expect(previewHtml(withIcon, 'html')).not.toContain('<svg');
    expect(previewHtml(unclosed, 'html')).toContain('and this too');

    // A closed pair still goes with its contents: the inside of an `<svg>` is
    // path data, and nobody is reviewing that.
    expect(previewHtml('<p>Hi</p><svg><path d="M0 0"/></svg>', 'html')).toBe('<p>Hi</p>');

    // The property behind all three: every word of the mail reaches the panel.
    const words = (value: string) => value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    for (const reply of [withIcon, unclosed]) {
      expect(words(previewHtml(reply, 'html')), reply).toBe(words(replyHtml(reply, 'html')));
    }
  });

  it('will not let a reply paint over the screen it is being reviewed on', () => {
    // Not script — script was never the interesting attack here. An element the
    // model can position over the panel hides the reply, the risk banner and the
    // Send button underneath something of its own choosing, and it does it with
    // declarations that run nothing and that the blacklist this replaced had no
    // opinion about.
    const overlay =
      '<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9;background-color:#fff">Approved by security</div>';

    const preview = previewHtml(overlay, 'html');
    expect(preview).not.toMatch(/position|fixed|z-index|width|height/i);
    expect(preview).toContain('Approved by security');

    // And what a reply legitimately writes still arrives, including everything
    // `replyHtml` puts there itself — a preview that quietly restyles the mail
    // is the same divergence one file over.
    expect(previewHtml('<p style="margin:0 0 12px;color:#333">Hi</p>', 'html')).toBe(
      '<p style="margin:0 0 12px;color:#333">Hi</p>',
    );
    const written = '# Title\n\n> quoted\n\n- one\n\n```\nlog\n```';
    expect(previewHtml(written)).toBe(replyHtml(written));
  });
});
