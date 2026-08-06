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
 * The reply as HTML: paragraphs on blank lines, `<br>` on single ones.
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
    .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
