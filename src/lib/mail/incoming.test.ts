import { describe, expect, it } from 'vitest';

import { letterHtml } from './incoming';
import { previewHtml } from './render';

/**
 * The letter is the second place markup somebody else wrote reaches a logged-in
 * reviewer's browser, and it is the more exposed of the two: the reply preview
 * needs a prompt injection first, and this needs an email.
 *
 * So the security half of this file is the same set of payloads `render.test.ts`
 * fires at the preview, fired at the letter. They share a sanitiser and are
 * meant to — the point of these is that the *policy* on top of it did not open
 * anything the shared code closes.
 */
describe('a letter from a stranger', () => {
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
      '<iframe src="javascript:alert(1)"></iframe>',
      '<style>*{x:expression(alert(1))}</style>',
      '<div style="background:url(javascript:alert(1))">x</div>',
      '<a title="a>b" onclick=alert(1)>x</a>',
      '<!--><script>alert(1)</script>-->',
      // A mail is a whole document, so the tags a reply never has are the ones
      // arriving here every day.
      '<html><head><style>body{display:none}</style></head><body onload=alert(1)>x</body></html>',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    ];

    for (const payload of payloads) {
      const { html } = letterHtml(payload);
      expect(html, payload).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, payload).not.toMatch(/javascript:/i);
      expect(html, payload).not.toMatch(/<(script|iframe|svg|form|button|base|meta)\b/i);
      expect(html, payload).not.toMatch(/formaction|expression\s*\(/i);
    }
  });

  /*
   * `position:fixed;top:0;left:0;width:100%;height:100%` is the attack no
   * blacklist sees: it runs nothing, so it beats every check that is looking for
   * script, and what it does is paint an element of the sender's choosing over
   * the risk banner and the Send button.
   *
   * It is allowed now, and the reason is the frame rather than a change of mind.
   * "Fixed" inside a sandboxed iframe is fixed to that iframe: the furthest it
   * reaches is the letter's own 560 pixels. The pair below is the actual
   * contract — the same declaration, refused where the markup shares a document
   * with the Send button and allowed where it does not.
   */
  it('confines a letter to its frame instead of stripping its layout', () => {
    const overlay =
      '<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:99;' +
      'background-color:#fff;color:#333">Nothing to see</div>';

    // In the letter's own document: kept, because a mail's layout is written in
    // exactly these properties and stripping them is what flattened a Stripe
    // receipt into a full-width blue field.
    const framed = letterHtml(overlay).html;
    expect(framed).toContain('position:fixed');
    expect(framed).toContain('width:100%');

    // In the reply preview, which is rendered into this page: still refused, and
    // the colours — which say how a thing looks rather than where it is — still
    // kept. Same sanitiser, different policy.
    const inline = previewHtml(overlay, 'html');
    expect(inline).toContain('background-color:#fff');
    expect(inline).toContain('color:#333');
    expect(inline).not.toMatch(/position|top|left|width|height|z-index/);
  });

  /*
   * The other half of the frame's rent. A stylesheet is page-wide, so a letter
   * could only ever have one once it had a page of its own — and without one,
   * every template that keeps its design in `<style>` and `class` arrived
   * completely unstyled.
   */
  it('keeps a letter’s own stylesheet, minus the parts that reach out', () => {
    const kept = letterHtml(
      '<style>@media (max-width:600px){.col{display:block}} .btn{background:#c00}</style>' +
        '<p class="btn">Buy</p>',
    ).html;
    expect(kept).toContain('@media (max-width:600px)');
    expect(kept).toContain('.btn{background:#c00}');
    expect(kept).toContain('class="btn"');

    // A stylesheet is also a way to fetch things. Both of these lose the whole
    // block rather than the offending rule: a half-applied design is a worse
    // lie than none, and the frame's CSP refuses the fetch regardless.
    for (const reaching of [
      '<style>@import url(https://evil.example/x.css);.a{color:red}</style><p class="a">x</p>',
      '<style>.a{background-image:url(https://tracker.example/p.gif)}</style><p class="a">x</p>',
      '<style>.a{width:expression(alert(1))}</style><p class="a">x</p>',
      '<style>.a{}</style\n><script>alert(1)</script>',
    ]) {
      const { html } = letterHtml(reaching);
      expect(html, reaching).not.toMatch(/tracker\.example|evil\.example|expression\s*\(|<script/i);
    }
  });

  it('reads a document as the letter inside it', () => {
    const { html } = letterHtml(
      '<!DOCTYPE html><html><head><title>Invoice</title></head>' +
        '<body><p>Hello</p></body></html>',
    );

    // The declaration is markup, not words. Kept as text it would print as
    // `<!DOCTYPE html>` across the top of the reviewer's letter.
    expect(html).not.toContain('DOCTYPE');
    expect(html).not.toContain('Invoice');
    expect(html).toBe('<p>Hello</p>');
  });

  it('keeps the structure that was the reason to render it at all', () => {
    const { html } = letterHtml(
      '<table><tr><td>Seats</td><td>12</td></tr></table>' +
        '<p>See <a href="https://acme.test/invoices/3391?a=1&amp;b=2">invoice 3391</a>.</p>',
    );

    expect(html).toContain('<table><tr><td>Seats</td><td>12</td></tr></table>');
    // The address survives, which is the whole complaint against the text
    // version: `htmlToText` kept "invoice 3391" and deleted where it points.
    expect(html).toContain('href="https://acme.test/invoices/3391?a=1&amp;b=2"');
  });

  /*
   * The allowlist started as "what a support reply is written with", and mail
   * is not written by hand. Each of these was arriving every day and losing the
   * only styling it had.
   */
  it('keeps the presentation mail written before CSS', () => {
    const { html } = letterHtml(
      '<table bgcolor="#eeeeee" border="1" cellpadding="8" cellspacing="0">' +
        '<tr><td bgcolor="#ffffff"><font color="#cc0000" face="Arial" size="4">逾期</font></td></tr>' +
        '</table><center>—</center>',
    );

    expect(html).toContain('bgcolor="#eeeeee"');
    expect(html).toContain('border="1"');
    expect(html).toContain('cellpadding="8"');
    expect(html).toContain('<font color="#cc0000" face="Arial" size="4">逾期</font>');
    expect(html).toContain('<center>');
  });

  /*
   * "No parentheses" kept `url(` out and took every non-hex colour with it —
   * which is most of them, because that is what a WYSIWYG composer writes.
   */
  it('keeps a colour written as a function, and still refuses a URL', () => {
    const kept = letterHtml(
      '<p style="color:rgb(51,51,51);background:rgba(0,0,0,.05);border:1px solid rgb(0,0,0)">x</p>',
    ).html;
    expect(kept).toContain('color:rgb(51,51,51)');
    expect(kept).toContain('background:rgba(0,0,0,.05)');
    expect(kept).toContain('border:1px solid rgb(0,0,0)');

    // The exception is written as "remove the colour functions, then apply the
    // old rule", so nothing gets weaker for containing one.
    for (const hostile of [
      '<p style="background:url(https://tracker.example/p.gif)">x</p>',
      '<p style="background:url(rgb(1,1,1))">x</p>',
      '<p style="width:expression(rgb(1,1,1))">x</p>',
      '<p style="color:var(--x)">x</p>',
      '<p style="width:calc(100% - 1px)">x</p>',
    ]) {
      const { html } = letterHtml(hostile);
      expect(html, hostile).toBe('<p>x</p>');
    }
  });

  it('does not paint a dead anchor as a link', () => {
    // An in-mail `#top` points at an id the sanitiser removed, so it goes
    // nowhere. The tag stays and its words stay; `a[href]` in the stylesheet is
    // what keeps it from being underlined in link blue.
    expect(letterHtml('<a href="#top">回到顶部</a>').html).toBe('<a>回到顶部</a>');
    expect(letterHtml('<a name="top"></a><p>x</p>').html).toBe('<p>x</p>');
  });

  it('opens a stranger’s links away from the desk', () => {
    const { html } = letterHtml('<a href="https://acme.test/x">click</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe('the pictures in a letter', () => {
  it('serves an inline image from our own mailbox', () => {
    const { html, remoteImages } = letterHtml(
      '<p>Here is what I see:</p><img src="cid:shot@mail.example" alt="the error">',
      [{ contentId: 'shot@mail.example', href: '/api/attachments/task-1/att-1' }],
    );

    expect(html).toContain('src="/api/attachments/task-1/att-1"');
    expect(html).toContain('alt="the error"');
    expect(remoteImages).toBe(0);
  });

  /*
   * The two sides of the match are written by the same sender and still manage
   * to disagree. The Content-ID header carries angle brackets and the `cid:` URL
   * that refers to it does not; Outlook percent-encodes the `@` in the URL; and
   * case is significant to a `Map` and to nobody else.
   *
   * The brackets are stored here because that is the pessimistic case — the
   * providers already strip them through `normalizeMessageId`, and a match that
   * depends on them having done so is one provider away from breaking.
   */
  it('matches a cid: reference the way another mail client would', () => {
    for (const src of ['cid:shot@mail.example', 'cid:Shot%40mail.example', 'cid:SHOT@MAIL.EXAMPLE']) {
      const { html } = letterHtml(`<img src="${src}">`, [
        { contentId: '<shot@mail.example>', href: '/api/attachments/task-1/att-1' },
      ]);
      expect(html, src).toContain('src="/api/attachments/task-1/att-1"');
    }
  });

  /*
   * The default, and the reason it is not the same thing as loading the image.
   *
   * What the sender learns from a proxied fetch is that a server pulled a
   * picture. What they learn from a direct one is that a person opened their
   * mail, from that IP, in that browser, at that second. The picture shows up
   * either way; only one of them answers the read receipt.
   */
  it('serves a remote picture from our own origin instead of the sender’s', () => {
    const { html, remoteImages } = letterHtml(
      '<p>Hi</p><img src="https://cdn.example/logo.png" alt="logo">',
      [],
      { proxy: url => `/api/letter-image?u=${encodeURIComponent(url)}&s=sig` },
    );

    expect(html).toContain('src="/api/letter-image?u=https%3A%2F%2Fcdn.example%2Flogo.png&amp;s=sig"');
    expect(html).not.toContain('cdn.example/logo.png"');
    // Nothing to report: none were refused.
    expect(remoteImages).toBe(0);
  });

  it('still counts the ones the proxy will not take', () => {
    const { html, remoteImages } = letterHtml(
      '<p>Hi</p><img src="https://tracker.example/o.gif">',
      [],
      { proxy: url => (url.includes('tracker') ? null : url) },
    );
    expect(html).toBe('<p>Hi</p>');
    expect(remoteImages).toBe(1);
  });

  it('does not fetch a picture from whoever sent the mail', () => {
    const { html, remoteImages } = letterHtml(
      '<p>Special offer</p><img src="https://tracker.example/open.gif?id=abc" width="1" height="1">',
    );

    // Not a broken-image icon and not the URL as text: nothing about the pixel
    // reaches the browser, which is the only version of this that does not tell
    // the sender the address is live.
    expect(html).not.toContain('tracker.example');
    expect(html).not.toContain('<img');
    expect(html).toContain('<p>Special offer</p>');
    // Counted, so the screen can say so. A newsletter that is mostly pictures
    // otherwise looks like a renderer that lost most of the mail.
    expect(remoteImages).toBe(1);
  });

  it('does not leave a gap where the pixel was', () => {
    // The paragraph existed to hold a tracking pixel. Emptied and kept, it is a
    // full line box and a 12px gap in the middle of the letter — a blank line
    // the sender did not write and we did.
    const { html } = letterHtml(
      '<p>Before</p><div><p><img src="https://tracker.example/o.gif"></p></div><p>After</p>',
    );
    expect(html).toBe('<p>Before</p><p>After</p>');
  });

  it('shows an image that is already in the letter', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    const { html, remoteImages } = letterHtml(`<img src="${data}">`);
    expect(html).toContain(data);
    expect(remoteImages).toBe(0);
  });

  it('drops a cid: reference to something that is not attached', () => {
    const { html } = letterHtml('<p>See below</p><img src="cid:missing">');
    expect(html).toBe('<p>See below</p>');
  });
});

describe('when the letter is not worth rendering', () => {
  it('says so for a mail with no HTML part', () => {
    expect(letterHtml(null)).toEqual({ html: '', document: '', remoteImages: 0 });
    expect(letterHtml('')).toEqual({ html: '', document: '', remoteImages: 0 });
  });

  it('says so for markup with nothing in it', () => {
    // What a tracking-pixel-only mail leaves once the pixel is refused: a nest
    // of empty rows, each carrying a line box. The caller has plain text and
    // should use it.
    const { html } = letterHtml(
      '<table><tr><td><img src="https://tracker.example/o.gif"></td></tr></table>',
    );
    expect(html).toBe('');
  });

  it('gives up on markup too large to be worth walking', () => {
    const huge = `<p>${'x'.repeat(600_000)}</p>`;
    expect(letterHtml(huge).html).toBe('');
  });

  it('still counts an image as content', () => {
    // No text at all, and it is the whole point of the email: "here is what I'm
    // seeing", pasted straight into Gmail.
    const { html } = letterHtml('<div><img src="cid:x"></div>', [
      { contentId: 'x', href: '/api/attachments/t/a' },
    ]);
    expect(html).toContain('/api/attachments/t/a');
  });
});
