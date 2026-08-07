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

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ESCAPES[char] ?? char);
}

/**
 * Two marks, and no more: `**bold**` and a `- ` bullet at the start of a line.
 *
 * The reviewer edits the reply in a plain textarea, so every mark has to be
 * something a person can type without thinking and can still read when it is
 * not rendered. That rules out the rest of Markdown — a support desk does not
 * need headings, and nobody types a reference link into a refund reply. It
 * also rules out asking the drafter for HTML, which is what the desk this
 * replaced did: the tags survive fine until a reviewer needs to change a
 * sentence, and then they are editing markup under a deadline.
 *
 * Emphasis is applied after escaping, which is safe because `*` is not a
 * character escaping touches — and the customer never sees a stray `<b>` they
 * did not approve, because the only tags here are the ones this file writes.
 */
const BOLD = /\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g;

function inline(escaped: string): string {
  return escaped.replace(BOLD, '<strong>$1</strong>');
}

/** True for a block where every line opens a bullet. */
function isList(lines: string[]): boolean {
  return lines.every(line => /^[-*]\s+\S/.test(line));
}

/**
 * The reply as HTML: paragraphs on blank lines, `<br>` on single ones, `<ul>`
 * for a run of bullets, `<strong>` for the emphasis the drafter asked for.
 *
 * Deliberately no styling, no wrapper table and no font stack. Everything a
 * desk would put there — a colour, a logo, a 14px sans-serif — is a decision
 * about someone else's mail client, and the ones that ignore it are the ones
 * whose users complained. The signature is already part of the text.
 *
 * Nothing is linkified either. Every mail client already does that, and doing
 * it here means shipping a URL regex that will one day mangle an address in a
 * refund confirmation.
 */
export function replyHtml(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (!normalised) return '';

  return normalised
    .split(/\n{2,}/)
    .map(block => {
      const lines = block.split('\n');
      if (isList(lines)) {
        const items = lines
          .map(line => `  <li>${inline(escapeHtml(line.replace(/^[-*]\s+/, '')))}</li>`)
          .join('\n');
        return `<ul>\n${items}\n</ul>`;
      }
      return `<p>${inline(escapeHtml(block)).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

/**
 * The same reply as the plain-text half: the marks taken back out.
 *
 * `**like this**` is readable enough that leaving it in would not be a
 * disaster, but it is still asterisks in a customer's mailbox, and the whole
 * point of the two-part mail is that each client shows the better of two
 * renderings of one approved sentence. Bullets stay — a dash in front of a
 * list item is what plain text has always looked like.
 */
export function replyText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim().replace(BOLD, '$1');
}
