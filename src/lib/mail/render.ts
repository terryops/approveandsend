/**
 * Turning the approved reply into the HTML half of the mail.
 *
 * Derived from the same string that goes out as `text`, never composed
 * separately. The reviewer approved one thing; a mail whose two parts could
 * differ would mean the sentence they read is not necessarily the sentence the
 * customer reads, and no amount of care in the drafter can fix that.
 *
 * Plain text alone would be defensible. It is not what happens in practice:
 * a support desk that answers an HTML thread in text/plain has its replies
 * rendered in a monospace block by half the clients in use, and quoted badly
 * by the rest. Sending both parts costs nothing and lets each client pick.
 */

import { escapeHtml, sanitise } from './sanitise';
import { htmlToText } from '../thread-context';

/**
 * How the reviewer wrote this particular reply.
 *
 * `markdown` is what the desk did before there was a choice — two marks, bold
 * and bullets — and it stays the default so that every reply already on disk
 * renders exactly as it always did.
 *
 * `text` is for the reply the marks would damage: a pasted log line beginning
 * with a dash, a price written as `**` of something, a config snippet.
 *
 * `html` hands the HTML part to the operator. It is the one format where what
 * is typed is what is transmitted, and it is deliberately a per-reply choice
 * rather than a setting — the answer to "should this desk write HTML" is nearly
 * always no, and the answer to "does this one reply need a table in it" is
 * occasionally yes.
 */
export type ReplyFormat = 'text' | 'markdown' | 'html';

/** The formats a reply can be written in, in the order the switcher shows them. */
export const REPLY_FORMATS: readonly ReplyFormat[] = ['markdown', 'text', 'html'];

/** Narrows whatever came off a form or out of the database. */
export function isReplyFormat(value: unknown): value is ReplyFormat {
  return value === 'text' || value === 'markdown' || value === 'html';
}

/**
 * The marks, and the rule that decides which ones exist.
 *
 * The reviewer edits the reply in a plain textarea, so every mark has to be
 * something a person types without thinking and can still read when it is *not*
 * rendered — because half the time it is not: it sits unrendered in the box for
 * the whole of the review, and it goes out unrendered in the `text/plain` half
 * of every mail. A mark that fails that test makes the reply worse in two of the
 * three places it is read.
 *
 * There were two of these, `**bold**` and a `- ` bullet, and two is too few for
 * the mail this desk actually sends. A support answer is a numbered procedure, a
 * link to the page the customer needs, an order id that has to be legible as an
 * id, and now and then a pasted log line. Written as prose those become "first,
 * then, after that", a bare URL the client may or may not linkify, an id run
 * together with the sentence around it, and a paragraph of machine output.
 *
 * So: emphasis, both weights; bullets; numbers; headings; links; code, inline
 * and fenced; and a quote. What is still missing is missing on purpose — tables,
 * because a table typed in pipes is unreadable in the box and unreadable in the
 * plain-text half; images and footnotes, for the same reason.
 *
 * Every mark is applied *after* escaping. That is what makes the whole file
 * safe: `*`, `` ` ``, `[` and `]` are not characters escaping touches, so the
 * only tags in the output are the ones written below, and a customer quoting
 * `<script>` at us cannot get it back.
 */

/* Inline. Order matters, and `inline()` below is where it is enforced. */
const CODE = /`([^`\n]+)`/g;
const LINK = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const BOLD = /\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g;
/*
 * One asterisk, and never one touching a word character.
 *
 * `2 * 3` is arithmetic and `file*` is a glob, but the pair that decides this is
 * `some_var*name` against `*emphasis*`: a desk answering about software pastes
 * identifiers all day, and turning half of one italic is a worse failure than
 * not offering italics at all. Underscores get no italics for the same reason,
 * and there the collision is not occasional — `created_at_utc` is one word to a
 * person and three emphasis marks to a parser.
 */
const ITALIC = /(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g;

/*
 * A link only becomes a link if it is one.
 *
 * Recognised rather than screened — the same allowlist shape as the preview
 * sanitiser, and for a stricter reason: this string is going into a stranger's
 * mailbox with our name on it. `javascript:` in an href would be stripped by
 * every mail client alive, which is exactly why it must not be *sent*: what
 * arrives would be a link that silently does nothing, from a desk that promised
 * a human read it. Anything not recognised keeps its brackets and travels as the
 * literal text the reviewer typed, which is visible, fixable, and true.
 */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:)[^\s]+$/i;

/**
 * The inline marks, in the one order that composes.
 *
 * Code first and held aside, because a snippet is quoted precisely so that what
 * is inside it is *not* interpreted — `**` in a log line is two asterisks. Then
 * links, whose opening tag is held aside too: an URL is allowed to contain a `*`
 * and a mark applied afterwards would rewrite the address rather than the words.
 * What is left after both is prose, which is where emphasis belongs.
 *
 * The placeholder is a NUL, which cannot survive `normalise` — see `replyHtml` —
 * so nothing a reviewer or a customer can type collides with it.
 */
function inline(escaped: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;

  return escaped
    .replace(CODE, (_whole, body: string) => hold(`<code>${body}</code>`))
    .replace(LINK, (whole, label: string, href: string) =>
      SAFE_HREF.test(href) && label ? `${hold(`<a href="${href}">`)}${label}${hold('</a>')}` : whole,
    )
    .replace(BOLD, '<strong>$1</strong>')
    .replace(ITALIC, '<em>$1</em>')
    .replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => held[Number(index)] ?? '');
}

/* Block. None of these carry the `g` flag: they are tested as well as replaced,
   and a global regex remembers where it got to between tests. */
const BULLET = /^[-*]\s+(?=\S)/;
const ORDERED = /^(\d{1,9})[.)]\s+(?=\S)/;
const QUOTE = /^>\s?/;
const FENCE = /^```/;
/*
 * A heading, and the space after the hashes is what makes it one.
 *
 * This was the mark left out, on the argument that a reply with sections is a
 * document and should have been a help page. The argument is wrong, and the way
 * it got caught is worth keeping: the first realistic draft written to try the
 * other marks opened a section with `**What I can see**`. Somebody reaching for
 * bold to fake a heading is the whole case for having one — they wanted the
 * mark, could not have it, and used the nearest thing, which renders as a
 * shouted sentence rather than as a title and tells a screen reader nothing.
 *
 * The space is required, so `#1 priority` and a `#channel` stay prose.
 */
const HEADING = /^(#{1,6})\s+(?=\S)/;

type BlockKind = 'p' | 'ul' | 'ol' | 'quote' | 'code' | 'heading';
interface Block {
  kind: BlockKind;
  lines: string[];
  /** Only for `ol`, and only when the reviewer did not start at 1. */
  start?: number;
  /** Only for `heading`: how many hashes were typed. */
  level?: number;
}

function kindOf(line: string): Exclude<BlockKind, 'code'> {
  if (HEADING.test(line)) return 'heading';
  if (BULLET.test(line)) return 'ul';
  if (ORDERED.test(line)) return 'ol';
  if (QUOTE.test(line)) return 'quote';
  return 'p';
}

/**
 * The reply cut into blocks, walked a line at a time.
 *
 * This used to split on blank lines and ask whether the resulting chunk happened
 * to be all bullets. That is a narrower rule than it looks: a list needed a blank
 * line above it or it was a paragraph full of dashes, which is not how anybody
 * writes and not what the box showed them. Walking the lines means a run of
 * bullets is a list wherever it starts, and it is what makes fenced code
 * possible at all — a fence contains blank lines, and splitting on those cut
 * every snippet in half.
 */
function blocks(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  let open: Block | null = null;
  const close = () => {
    if (open) out.push(open);
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (FENCE.test(line)) {
      close();
      const body: string[] = [];
      // An unclosed fence runs to the end rather than being abandoned: somebody
      // who opened one meant everything after it, and a half-pasted log is
      // better shown as a log than as prose full of newlines.
      for (i += 1; i < lines.length && !FENCE.test(lines[i]!); i += 1) body.push(lines[i]!);
      out.push({ kind: 'code', lines: body });
      continue;
    }

    if (line.trim() === '') {
      close();
      continue;
    }

    const kind = kindOf(line);

    // One line, and never joined to the next one. Every other kind here
    // accumulates a run — a second bullet belongs to the list above it — but a
    // heading followed by a heading is two sections, not a two-line title.
    if (kind === 'heading') {
      close();
      out.push({ kind, lines: [line], level: HEADING.exec(line)![1]!.length });
      continue;
    }

    if (!open || open.kind !== kind) {
      close();
      open = { kind, lines: [] };
      // `<ol start>`, because a procedure continued after a paragraph — "4. now
      // press Save" — is a reviewer counting deliberately, and renumbering it
      // from 1 makes the reply contradict itself.
      if (kind === 'ol') open.start = Number(ORDERED.exec(line)![1]);
    }
    open.lines.push(line);
  }

  close();
  return out;
}

/**
 * The gap between two paragraphs, stated rather than left to the client.
 *
 * This is the one exception to the no-styling rule below, and it is not a
 * cosmetic one. A bare `<p>` inherits the client's default margin, which is
 * `1em` on the top *and* the bottom — and whether the two collapse into one gap
 * is exactly where mail clients stop agreeing. Anything with a browser engine
 * collapses them and shows about 16px; Outlook renders through Word, which does
 * not collapse adjacent margins, and shows about 32px. So the same approved
 * reply arrived with comfortable paragraphs for half the recipients and with a
 * blank line and a half between every sentence for the rest, and nothing in this
 * app could see it happen.
 *
 * Top margin zeroed and one modest bottom margin, in pixels rather than `em`,
 * because `em` on a `<p>` resolves against whatever font size the client decided
 * to use and the point here is that everyone gets the same gap.
 */
const BLOCK_STYLE = 'margin:0 0 12px';

/** The same, plus the indent a list loses when its margins are zeroed. */
const LIST_STYLE = `${BLOCK_STYLE};padding-left:22px`;

/*
 * A snippet wraps rather than scrolls.
 *
 * `overflow-x:auto` is the web answer and it is the wrong one here: a mail
 * client is not a browser viewport, and the ones that ignore the declaration
 * simply cut the line off at the edge of the message — so the id somebody was
 * sent is the half of the id that fitted. Wrapping is ugly on a long line and
 * always legible, which is the right trade for a support reply.
 */
const CODE_STYLE = `${BLOCK_STYLE};white-space:pre-wrap;overflow-wrap:break-word`;

/* The rule down the side of a quote takes no colour, so it inherits the reader's
   own text colour — the file picks no colours, and this is how it keeps to that
   while still drawing a line. */
const QUOTE_STYLE = `${BLOCK_STYLE};padding-left:12px;border-left:2px solid`;

/**
 * A heading, sized relative to the reader rather than at a size of our choosing.
 *
 * `em`, and this is not the same call as the `px` margins above — it is the same
 * principle applied to the other kind of thing. A gap should be identical for
 * everybody, so it is absolute. A text size belongs to the reader: they picked
 * it, their client picked it, their phone picked it, and an absolute one here
 * would be exactly the "14px sans-serif" this file refuses to ship. What is ours
 * is the *ratio* — that a section title reads as larger than the sentence under
 * it — and a ratio is what `em` states.
 *
 * Left alone, `<h1>` in a webmail client is about 2em: a banner across a support
 * reply, which is not what somebody typing `#` in a mail meant by it. Three
 * steps is all this needs, and the fourth hash onwards is bold at body size,
 * because a reply nested four sections deep has a bigger problem than its type.
 *
 * The tag starts at `h2`, not `h1`. An `<h1>` claims to be the title of the
 * document it is in, and the document is the reader's mailbox.
 */
function heading(block: Block): string {
  const level = block.level ?? 1;
  const tag = `h${Math.min(level + 1, 6)}`;
  const size = level === 1 ? '1.3em' : level === 2 ? '1.15em' : '1em';
  const text = inline(escapeHtml(block.lines[0]!.replace(HEADING, '')));
  return `<${tag} style="margin:0 0 8px;font-size:${size};line-height:1.3">${text}</${tag}>`;
}

function items(lines: string[], mark: RegExp): string {
  return lines.map(line => `  <li>${inline(escapeHtml(line.replace(mark, '')))}</li>`).join('\n');
}

function paragraph(lines: string[]): string {
  return inline(escapeHtml(lines.join('\n'))).replace(/\n/g, '<br>');
}

function render(block: Block): string {
  switch (block.kind) {
    case 'code':
      // Escaped and nothing else. The whole point of the fence is that what is
      // inside it is not a mark, and that includes ours.
      return `<pre style="${CODE_STYLE}"><code>${escapeHtml(block.lines.join('\n'))}</code></pre>`;
    case 'ul':
      return `<ul style="${LIST_STYLE}">\n${items(block.lines, BULLET)}\n</ul>`;
    case 'ol': {
      const from = block.start && block.start !== 1 ? ` start="${block.start}"` : '';
      return `<ol style="${LIST_STYLE}"${from}>\n${items(block.lines, ORDERED)}\n</ol>`;
    }
    case 'heading':
      return heading(block);
    case 'quote':
      return `<blockquote style="${QUOTE_STYLE}">${paragraph(
        block.lines.map(line => line.replace(QUOTE, '')),
      )}</blockquote>`;
    default:
      return `<p style="${BLOCK_STYLE}">${paragraph(block.lines)}</p>`;
  }
}

/**
 * The reply as HTML: paragraphs on blank lines, `<br>` on single ones, lists for
 * a run of bullets or numbers, a quote, a snippet, and the inline marks above.
 *
 * No wrapper table, no font stack, no colour. Everything a desk would put there
 * — a brand colour, a logo, a 14px sans-serif — is a decision about someone
 * else's mail client, and the ones that ignore it are the ones whose users
 * complained. The signature is already part of the text. The only declarations
 * here are the block gaps, which exist so that every client renders the one
 * approved reply the same way rather than to make it look like anything in
 * particular.
 *
 * Nothing is linkified either. A URL written as a URL travels as one — every
 * mail client already turns those blue — and doing it here means shipping a URL
 * regex that will one day mangle an address in a refund confirmation. `[text](url)`
 * is a different thing: it is a reviewer saying which words the link belongs to.
 */
export function replyHtml(text: string, format: ReplyFormat = 'markdown'): string {
  // NUL is stripped rather than escaped, because `inline` uses it as a
  // placeholder and a reply that contained one could otherwise reach in and pull
  // out a fragment of its own markup.
  const normalised = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  if (!normalised) return '';

  // Authored as HTML, so it leaves as HTML. Nothing is escaped and nothing is
  // wrapped: the operator wrote markup on purpose, and re-escaping it would put
  // `&lt;p&gt;` in a customer's mailbox. The plain-text half is derived from it
  // rather than from the box — see `replyText` — so the two still cannot say
  // different things, which is the property this file exists to protect.
  if (format === 'html') return normalised;

  // Plain text means plain: paragraphs and line breaks still happen, because
  // those are in the whitespace rather than in any mark, but `**` stays two
  // asterisks and a leading dash stays a dash. Somebody who picked this format
  // did so because they are pasting something the marks would eat.
  if (format === 'text') {
    return normalised
      .split(/\n{2,}/)
      .map(block => `<p style="${BLOCK_STYLE}">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
      .join('\n');
  }

  return blocks(normalised).map(render).join('\n');
}

/*
 * What the customer will see, for the reviewer to look at first.
 *
 * The format was doing its whole job inside `sendReply` and nowhere else, so a
 * reply written in Markdown was shown to the reviewer as the characters they
 * typed and to the customer as bold text and bullets — and the confirmation
 * panel, whose entire reason to exist is showing what the send will actually
 * read, was showing something the recipient never gets. Same function as the
 * mail so the two cannot drift: a preview built from its own renderer would be
 * a second opinion about the reply, which is the thing this file refuses to have.
 *
 * This *is* a sanitiser, and the note that used to sit here saying otherwise was
 * wrong in a way worth writing down. It said the markup in `html` format is the
 * operator's own, typed behind their own password — but the operator did not
 * type it. The model did, and the model wrote it after reading an email from a
 * stranger. The route from a hostile customer to markup rendered inside a logged
 * in reviewer's session is: get the drafter to emit a tag. That is one prompt
 * injection, and the output of this function is handed to
 * `dangerouslySetInnerHTML` on the review screen and again on the confirmation
 * panel.
 *
 * The sanitiser itself lives in `sanitise.ts`, because the customer's own letter
 * is now rendered through it too and two sanitisers written to the same
 * intentions drift. The policy is the empty one: a reply preview may show a
 * remote image, since whoever put it there is on this side of the desk, and its
 * links are ones a reviewer approved.
 *
 * What is sent is still untouched by any of this — `replyHtml` is what goes on
 * the wire, and mail clients do their own sanitising. This is about the screen.
 */

export function previewHtml(text: string, format: ReplyFormat = 'markdown'): string {
  return sanitise(replyHtml(text, format));
}

/**
 * The marks taken back out, for the half of the mail that has no tags to put
 * them in.
 *
 * Everything structural stays exactly as typed — a bullet is what a bullet looks
 * like in plain text, and so is `1.` and so is `> `. Only the marks that exist
 * to become a tag come out, because there is no tag on this side and `**Done.**`
 * in a customer's terminal is two asterisks they have to read past.
 *
 * A link is the one that cannot simply be unwrapped: `[the export page](url)`
 * has to keep the address or the sentence points at nothing. It becomes
 * `the export page (url)`, which is the convention every mail on earth uses, and
 * it is why this half can be longer than the HTML one without the two halves
 * disagreeing — the href is not missing over there, it is in the attribute.
 */
function marksOut(prose: string): string {
  return prose
    .replace(CODE, '$1')
    .replace(LINK, (whole, label: string, href: string) =>
      SAFE_HREF.test(href) && label ? (label === href ? href : `${label} (${href})`) : whole,
    )
    .replace(BOLD, '$1')
    .replace(ITALIC, '$1');
}

/**
 * And a fence is where that stops, on this side of the mail as well as the
 * other.
 *
 * This used to drop the ``` lines and then run every mark over what was left,
 * fenced body included — so the HTML half emitted `<pre><code>` with the log
 * line exactly as pasted, and the plain-text half of the same mail sent
 * `ERROR fatal at [main](x) tick`: asterisks gone, backticks gone, inside the
 * one construct that exists to say "this is literal". A customer reading in a
 * terminal client was shown a doctored log.
 *
 * Walked a line at a time, the way `blocks` walks it, and for the same reason —
 * an unclosed fence runs to the end there, so it has to run to the end here or
 * the two halves disagree about where the snippet stopped.
 */
function unmark(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(marksOut(prose.join('\n')));
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i]!)) {
      flush();
      // The delimiters go — they are scaffolding for a renderer — and every line
      // between them travels exactly as it was typed.
      for (i += 1; i < lines.length && !FENCE.test(lines[i]!); i += 1) out.push(lines[i]!);
      continue;
    }
    // The hashes go, the line stays. `- one` is what a bullet looks like to
    // anybody; `# What to do next` is what markup looks like to a customer, and
    // the blank lines already around a heading are what makes it read as one.
    prose.push(lines[i]!.replace(HEADING, ''));
  }

  flush();
  return out.join('\n');
}

export function replyText(text: string, format: ReplyFormat = 'markdown'): string {
  const normalised = text.replace(/\r\n/g, '\n').trim();
  // Derived from the markup rather than sent as the markup.
  //
  // This is the one place the HTML format is not simply "whatever was typed".
  // Putting raw tags in the `text/plain` part would mean the client that chose
  // plain text — every screen reader, every terminal client, every phone on a
  // bad connection — shows the customer angle brackets. Running it back through
  // the same reader the drafter uses on incoming mail keeps the promise the top
  // of this file makes: one approved reply, two renderings of it.
  if (format === 'html') return htmlToText(normalised);
  // Plain text is already the plain text. Leaving `**` alone here is the whole
  // point of the format — stripping it would edit a reply somebody chose not to
  // have marked up.
  if (format === 'text') return normalised;
  return unmark(normalised);
}
