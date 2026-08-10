/**
 * The one sanitiser, and the two policies that use it.
 *
 * There are two places markup written by somebody else reaches a logged-in
 * reviewer's browser, and until this file they had one of them covered. The
 * covered one is the reply preview — `previewHtml` in `render.ts` — where the
 * markup is the *model's*, written after reading mail from a stranger, so one
 * prompt injection is the whole distance from a hostile customer to a tag on
 * our own origin. The other is the customer's letter itself, which was never
 * rendered at all: the HTML was thrown away at ingest and the reviewer read a
 * regex-flattened transcript of it.
 *
 * Rendering the letter means the second route opens, and the honest way to open
 * it is with the same code rather than a second sanitiser written to the same
 * intentions. Two sanitisers drift; the one that gets the next fix is the one
 * somebody happened to be looking at.
 *
 * What differs between the two is a policy, not a mechanism:
 *
 *   - our own reply preview trusts an `https://` image, because whoever put it
 *     there is on this side of the desk;
 *   - a stranger's letter does not, because a remote image in inbound mail is a
 *     read receipt — it tells the sender the address is live and that a person
 *     opened it, from our IP, at a time they choose to record.
 *
 * So `SanitisePolicy` decides what an image may be and whether links are
 * foreign, and everything else — the tag allowlist, the attribute allowlist,
 * the style allowlist, the URL shapes — is the same for both because there is
 * no argument for it being different.
 *
 * The rule throughout is allowlist: unknown tag, tag goes; unknown attribute,
 * attribute goes; a URL that is not visibly `http`, `https`, `mailto`, `tel` or
 * `cid` from its first character, attribute goes. Nothing has to be recognised
 * as dangerous to be removed, which is the property a blacklist cannot have —
 * the three regexes this replaced let `<svg/onload=…>`, `<img/onerror=… src=x>`,
 * `&#106;avascript:`, `java&Tab;script:` and `formaction="javascript:…"` all
 * through.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ESCAPES[char] ?? char);
}

/**
 * Gone with everything inside them: none of these has content worth showing.
 *
 * Two patterns, because a closed pair and a stray tag are not the same thing.
 * There used to be one, ending in `(?:<\/\1\s*>|$)` — "or the rest of the
 * string" — and that `$` is a trapdoor: one inline `<svg …/>` icon, or a
 * `<style` nobody closed, deleted everything after it *from the preview only*.
 * `replyHtml` is what goes on the wire and it kept the lot, so the panel showed
 * a two-line mail and the send was five paragraphs. The one promise that screen
 * makes is that what is on it is what leaves, and that inverted it.
 *
 * A pair still loses its content — the inside of an `<svg>` is path data, and
 * the inside of a `<style>` is a stylesheet for the whole page, which is most of
 * why inbound mail cannot be rendered as it arrived. A tag with no partner loses
 * only itself, and what followed stays: it is text with no tag around it, which
 * is the rule the allowlist below already applies to every other unknown tag.
 */
const REMOVED = 'script|style|iframe|object|embed|noscript|template|svg|math|title|head';
/** The attribute run, so a quoted `>` inside the opening tag does not end it. */
const ATTRS = String.raw`(?:"[^"]*"|'[^']*'|[^"'>])*`;
const REMOVED_PAIR = new RegExp(String.raw`<(${REMOVED})\b${ATTRS}>[\s\S]*?<\/\1\s*>`, 'gi');
const REMOVED_TAG = new RegExp(String.raw`<\/?(?:${REMOVED})\b${ATTRS}>`, 'gi');
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;
/**
 * The markup that is not a tag, and would otherwise be printed as words.
 *
 * A letter from a real mail client is a whole document: it opens `<!DOCTYPE
 * html>`, and if it was written in Word it is wearing `<?xml …?>` and a row of
 * `<![if !mso]>` conditionals as well. None of those is in the tag allowlist, so
 * none of them was being *removed* — the allowlist drops a tag and keeps its
 * text, and there is no text here, only the escaped angle brackets of the
 * declaration itself at the top of the reviewer's letter.
 *
 * After `COMMENTS`, deliberately: `<!--[if mso]>` is a comment and is already
 * gone by the time this runs, so what is left for `<![^>]*>` to match is the
 * downlevel-revealed kind that a browser does treat as markup.
 */
const DECLARATIONS = /<![^>]*>|<\?[\s\S]*?\?>/g;
/** A tag, with quoted attribute values allowed to contain `>`. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * The tags a mail actually renders. Everything else loses its tag and keeps its
 * text — dropping the content too would hide part of a letter from the one
 * person whose job is to read all of it.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'wbr', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  /*
   * The tags a reply never has and a letter has constantly.
   *
   * This list started as "what a support reply is written with", which is the
   * right list for the half of the job that existed then. Mail is not written
   * by hand: `<font color=#c00>` is what Foxmail, an enterprise Outlook and
   * every 网易企业邮 signature still emit, `<center>` and `<strike>` come with
   * them, and the semantic containers arrive from anything templated. All of
   * them were losing their tag and keeping their text — which is the right
   * default for something unrecognised and the wrong answer for a paragraph
   * whose only styling was the `<font>` around it.
   *
   * Every one of these is inert: a container, or presentation with no URL and
   * no behaviour in it.
   */
  'font', 'center', 'strike', 'big', 'tt',
  'abbr', 'cite', 'q', 'mark', 'time', 'bdi', 'bdo',
  'figure', 'figcaption', 'address',
  'article', 'section', 'header', 'footer', 'main', 'aside', 'nav',
]);

/** And the attributes they may keep. Every `on*` handler fails this by not being in it. */
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'style', 'align', 'valign',
  'width', 'height', 'colspan', 'rowspan', 'start', 'dir', 'lang',
  /*
   * How mail written before CSS says what colour something is.
   *
   * `bgcolor` on a `<td>` is the way a banner, a header bar and every
   * alternating table row gets its background, and it is still how most of the
   * templated mail arriving at a support address does it — the `style`
   * attribute is the modern spelling, not the common one. Dropping these turned
   * a designed letter into an undesigned one and reported nothing.
   *
   * `border`, `cellpadding` and `cellspacing` are the same argument for the grid
   * of a table: without them a table of line items is columns of text with
   * nothing separating them, which is the layout the plain-text version already
   * had. None of the five can carry a URL or a behaviour.
   */
  'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color', 'face', 'size',
]);

/**
 * `style` is the one attribute whose *contents* need the same treatment as the
 * attribute list itself, and it used to be the one place this was a blacklist:
 * three tokens — `expression(`, `url(`, `javascript:` — screening for ways to
 * run script.
 *
 * Script was never the interesting attack here. `position:fixed; top:0;left:0;
 * width:100%;height:100%` runs nothing and walks through all three, and what it
 * does is paint an element of the sender's choosing over the letter, the risk
 * banner and the Send button — on the one screen in the app whose entire job is
 * to be worth trusting. A blacklist has to have heard of the trick; this does
 * not.
 *
 * The attribute cannot simply be dropped: `replyHtml` writes the block gaps
 * inline — see `BLOCK_STYLE` — so a preview with no styles is a preview of a
 * differently spaced mail, and a letter with no styles is a table-layout
 * newsletter with its rows run together. So it is named the other way round,
 * and the line is where the box *is* against how it looks: colour, type,
 * spacing, borders and wrapping stay; anything that takes an element out of its
 * place in the flow or decides its size is not on the list and therefore goes —
 * `position`, `top`, `z-index`, `width`, `transform`, `opacity`, `display`,
 * `float`, `overflow`, and whatever is invented next.
 */
const ALLOWED_STYLES = new Set([
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-style', 'border-width', 'border-radius', 'border-collapse',
  'border-spacing',
  /*
   * `background` as well as `background-color`, and the shorthand is the one
   * that actually arrives — `background:#f5f5f5` is what a template writes.
   *
   * Safe for the same reason `background-color` is, and it is the value rule
   * below that makes it safe rather than the name: a shorthand can carry
   * `url(…)` and cannot get one past a rule that rejects parentheses.
   */
  'color', 'background', 'background-color',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-indent',
  'text-transform', 'vertical-align', 'white-space', 'word-break', 'overflow-wrap',
  'list-style-type',
]);

/**
 * And the ones a letter may only have inside a frame of its own.
 *
 * Every entry here is on the "where the box is" side of the line drawn above,
 * and the line was drawn there because the box was on our screen. Give the
 * letter its own document and the argument reverses: these are how a mail says
 * that its two columns are two columns, and without them a table layout — which
 * is what all mail layout is — collapses into one.
 *
 * `position` included. Inside the frame the worst it can do is cover part of the
 * letter with another part of the letter, which a sender could achieve by
 * writing different words.
 */
const FRAMED_STYLES = new Set([
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
  'box-sizing', 'opacity', 'visibility',
  'background-image', 'background-position', 'background-repeat', 'background-size',
  'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap',
  'table-layout', 'caption-side', 'empty-cells',
]);

/**
 * And the shape a value may take, which is what keeps `url(…)` out without
 * naming it: no parentheses, so no function of any kind — not `url`, not
 * `expression`, not `calc`, not `attr`, not `var`. No colon either, so nothing
 * smuggles a second declaration past the split below.
 */
const SAFE_STYLE_VALUE = /^[-#%.,\/!'"\s\w]+$/;

/**
 * The one exception, and it is the difference between a letter having colours
 * and a letter not having them.
 *
 * "No parentheses" is a good rule that took `rgb(51,51,51)` with it, and that is
 * not an edge case — it is how every WYSIWYG composer on the web writes a
 * colour. `color`, `background`, `border` and the rest were surviving the
 * property check and then being dropped at the value, so a letter written in
 * anything but hex arrived in the desk's default black.
 *
 * Recognised rather than screened, like everything else here: a colour function
 * by name, with nothing between its brackets but numbers, separators and units.
 * The check is done by *removing* these from the value and holding what is left
 * to the rule above, so a value gets no weaker for containing one —
 * `1px solid rgb(0,0,0)` passes on the strength of `1px solid`, `url(rgb(1,1,1))`
 * still fails on the `url(` its inner group leaves behind, and so does
 * `expression(rgb(1,1,1))`.
 */
const COLOR_FUNCTION = /(?:rgba?|hsla?)\(\s*[-\d.,%\s\/]*\)/gi;

function safeStyleValue(value: string): boolean {
  return SAFE_STYLE_VALUE.test(value.replace(COLOR_FUNCTION, ' '));
}

/** The declarations that survive both, `;`-joined, or `''` if none do. */
function declarations(value: string, framed: boolean): string {
  return value
    .split(';')
    .map(part => part.trim())
    .filter(part => {
      const colon = part.indexOf(':');
      if (colon < 1) return false;
      const property = part.slice(0, colon).trim().toLowerCase();
      const setting = part.slice(colon + 1).trim();
      const allowed = ALLOWED_STYLES.has(property) || (framed && FRAMED_STYLES.has(property));
      return allowed && setting !== '' && safeStyleValue(setting);
    })
    .join(';');
}

/**
 * A `<style>` block, kept only for a letter that has its own document.
 *
 * It is the single biggest thing missing from a letter rendered without a
 * frame, and it is unkeepable without one: a stylesheet is page-wide, so the
 * rule a newsletter writes for `.button` would find our buttons and the one it
 * writes for `body` would find the desk.
 *
 * Inside the frame the selectors can only reach the letter, so what is left to
 * check is the CSS itself. This one is a blacklist and it is the only one in the
 * file, which needs saying out loud: an allowlist over CSS syntax means banning
 * parentheses, and a stylesheet with no parentheses has no `@media` — which is
 * most of what a mail's stylesheet is for. So the shape of the argument here is
 * different from everywhere else. The enforcement is the frame: `sandbox` with
 * no `allow-scripts` means nothing in this document executes, and the CSP means
 * nothing in it fetches. These two tokens are what is left over after the
 * browser has already made both guarantees.
 *
 * `@import` and `url(…)` are the ways CSS reaches the network — a stylesheet
 * from wherever the sender likes, and a background image that is a tracking
 * pixel wearing a hat. `expression(…)` is script in a declaration, and has been
 * dead since IE10; it is here because it costs one token.
 *
 * Anything containing a `<` goes in its entirety. A stylesheet is not a place a
 * tag can legitimately appear, and one holding a `</style` is trying to end
 * early and start something else.
 */
const AT_IMPORT = /@import[^;{]*(?:;|$)/gi;
const CSS_REACHES_OUT = /(?:url|expression)\s*\(/i;

function stylesheet(css: string): string {
  if (css.includes('<')) return '';
  const stripped = css.replace(AT_IMPORT, '');
  return CSS_REACHES_OUT.test(stripped) ? '' : stripped;
}

/**
 * A URL this page will follow, recognised rather than screened.
 *
 * Allowlisted from the first character, which is what makes the entity tricks
 * irrelevant: `&#106;avascript:` and `java&Tab;script:` are not rejected for
 * looking like `javascript:` — they are rejected for not looking like `https://`.
 * A decoder that misses one entity therefore costs a broken link, not a script.
 *
 * `&amp;` is decoded first because it is the one entity that belongs in a real
 * URL, and a query string of two parameters would otherwise fail the shape.
 */
const SAFE_URL = /^(?:https?:\/\/|mailto:|tel:|cid:)[^\s"'<>`]*$/i;
const SAFE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;

function safeUrl(raw: string, isImage: boolean): string | null {
  const value = raw.trim().replace(/&amp;/gi, '&');
  if (SAFE_URL.test(value)) return value;
  if (isImage && SAFE_IMAGE.test(value)) return value;
  return null;
}

export interface SanitisePolicy {
  /**
   * The output is going into a sandboxed iframe of its own.
   *
   * This is not a relaxation of the security rules — every tag, attribute and
   * declaration below is still checked, and `sandbox` with no `allow-scripts`
   * means nothing in the document can execute even if one got through. It is a
   * relaxation of the *layout* rules, and it is the frame that earns it.
   *
   * The two lists below refuse `<style>`, `class`, `width`, `display`,
   * `position` and the rest for one reason: rendered inline on the review
   * screen, a letter's stylesheet selects our elements and a letter's
   * `position:fixed` paints over the Send button. Both stop being true the
   * moment the letter has a document of its own. `position:fixed` inside the
   * frame is fixed to the frame; a stylesheet inside it cannot see out; a
   * 600px table can be 600px wide because the frame is the thing that scrolls.
   *
   * And the cost of refusing them is not small. A letter with its CSS in a
   * `<style>` block and its layout in classes — which is most templated mail —
   * arrives with no styling at all, and one with its widths stripped arrives
   * with its columns collapsed. That is the screenshot this flag exists because
   * of: a Stripe receipt rendered as a full-width blue field with the card
   * squeezed into the left third of it.
   */
  framed?: boolean;
  /**
   * What an already-safe `img src` becomes, or null to drop the image.
   *
   * Called only with URLs that have passed the shapes above, so a policy is
   * deciding between kinds of legitimate URL rather than doing the security. Its
   * job in inbound mail is `cid:` — the reference an HTML letter uses to point
   * at its own attached image, which means nothing to a browser and has to be
   * turned into a URL on our own origin — and refusing everything remote.
   */
  image?: (src: string) => string | null;
  /**
   * Links somebody else wrote: open in a new tab, tell the destination nothing.
   *
   * `noopener` because a link that replaces this tab through `window.opener` is
   * a phishing page wearing our address bar, and `nofollow` because a support
   * desk is not a vote for whatever a customer pasted. Off for our own reply
   * preview, where the link is one a reviewer approved and the mail client will
   * decide how to open it anyway.
   */
  foreignLinks?: boolean;
}

function attributes(source: string, policy: SanitisePolicy): string[] {
  const kept: string[] = [];
  for (const match of source.matchAll(ATTR)) {
    const name = match[1]!.toLowerCase();
    // `class` is half of what a `<style>` block is for, and useless without
    // one — so it is kept exactly where the stylesheet is: inside the frame.
    const named = name === 'class' || name === 'id';
    if (!ALLOWED_ATTRS.has(name) && !(policy.framed && named)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';

    if (name === 'href' || name === 'src') {
      const url = safeUrl(value, name === 'src');
      if (!url) continue;
      const final = name === 'src' && policy.image ? policy.image(url) : url;
      if (final) kept.push(`${name}="${escapeHtml(final)}"`);
      continue;
    }
    // Kept declaration by declaration rather than screened as a string — see
    // `ALLOWED_STYLES` for why the string version was the wrong shape.
    if (name === 'style') {
      const style = declarations(value, policy.framed === true);
      if (style) kept.push(`style="${escapeHtml(style)}"`);
      continue;
    }
    kept.push(`${name}="${escapeHtml(value)}"`);
  }
  return kept;
}

/** `<style>…</style>`, matched before the pass below deletes it. */
const STYLE_BLOCK = /<style\b(?:"[^"]*"|'[^']*'|[^"'>])*>([\s\S]*?)<\/style\s*>/gi;

export function sanitise(html: string, policy: SanitisePolicy = {}): string {
  // Held back before `REMOVED_PAIR` gets to them, filtered, and put back at the
  // front — a stylesheet has to precede what it styles, and a letter that wrote
  // its `<style>` in a `<head>` we are about to discard has nowhere else to put
  // it. Outside a frame this never runs and the block is deleted like any other.
  const sheets: string[] = [];
  const source = policy.framed
    ? html.replace(STYLE_BLOCK, (_whole, css: string) => {
        const kept = stylesheet(css);
        if (kept.trim()) sheets.push(kept);
        return '';
      })
    : html;

  const stripped = source
    .replace(COMMENTS, '')
    .replace(DECLARATIONS, '')
    .replace(REMOVED_PAIR, '')
    .replace(REMOVED_TAG, '');
  let out = sheets.length ? `<style>${sheets.join('\n')}</style>` : '';
  let at = 0;

  // Text between the tags keeps its entities — it has already been escaped by
  // `replyHtml` on every format but `html` — and loses any bare `<`, which is
  // either an unterminated tag or a character the browser would guess at.
  for (const match of stripped.matchAll(TAG)) {
    out += stripped.slice(at, match.index).replace(/</g, '&lt;');
    at = match.index + match[0].length;

    const name = match[2]!.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue;

    if (match[1]) {
      out += `</${name}>`;
      continue;
    }

    const attrs = attributes(match[3] ?? '', policy);
    // An `<img>` whose only reason to exist was a src the policy refused is not
    // rendered as a broken-image icon with somebody's alt text in it. There is
    // nothing to show and a placeholder in the middle of a sentence is worse
    // than the gap.
    if (name === 'img' && !attrs.some(a => a.startsWith('src='))) continue;
    if (name === 'a' && policy.foreignLinks && attrs.some(a => a.startsWith('href='))) {
      attrs.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
    }
    out += `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  }

  return out + stripped.slice(at).replace(/</g, '&lt;');
}
