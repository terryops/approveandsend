import type { MailMessage } from '../mail/types';

/**
 * Telling mail that wants an answer from mail that does not.
 *
 * A real support address gets newsletters, invoices, deploy notifications,
 * password resets, cold sales outreach and bounces. Drafting a reply to each
 * costs three model calls and puts something in the queue that a human has to
 * read and dismiss — which is the cost this desk exists to remove, being spent
 * on mail nobody sent us on purpose.
 *
 * Deliberately deterministic and header-first. Every signal used here is the
 * sender *declaring* that a human did not write this, which is both free and
 * more accurate than a model's opinion of the body. A classifier would cost a
 * call per email to answer a question the mail already answers, and would
 * eventually be wrong about a real customer, which is the failure that matters:
 * a newsletter drafted is a nuisance, a customer silently dropped is the
 * product not working.
 *
 * Nothing here deletes anything. The task is still created — dismissed, with
 * the reason on it — so a desk that suspects it is eating customer mail can go
 * and look instead of taking our word for it.
 */

export interface JunkVerdict {
  /** Short, and written for the person reading the dismissed row. */
  reason: string;
}

/** Local parts that are, by convention, a mailbox that does not read replies. */
const NO_REPLY =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|noreply-|automated)/;

function header(message: MailMessage, name: string): string {
  return (message.headers?.[name] ?? '').trim().toLowerCase();
}

export function junkVerdict(message: MailMessage): JunkVerdict | null {
  // RFC 8058. Present only on mail sent to a list, and the single most
  // reliable bulk signal there is: no human writing to support adds it.
  if (header(message, 'list-unsubscribe')) {
    return { reason: 'Bulk mail — it carries a List-Unsubscribe header.' };
  }

  // RFC 3834's anti-loop header. Answering something marked auto-generated is
  // how two robots end up mailing each other until a quota runs out.
  const auto = header(message, 'auto-submitted');
  if (auto && auto !== 'no') {
    return { reason: `Automated mail — Auto-Submitted: ${auto}.` };
  }

  const precedence = header(message, 'precedence');
  if (['bulk', 'list', 'junk'].includes(precedence)) {
    return { reason: `Bulk mail — Precedence: ${precedence}.` };
  }

  if (header(message, 'x-auto-response-suppress')) {
    return { reason: 'The sender asked for no automatic response.' };
  }

  // An empty Return-Path is a bounce. Replying to it goes nowhere by design.
  if (header(message, 'return-path') === '<>') {
    return { reason: 'A bounce — the Return-Path is empty.' };
  }

  const local = message.from.address.split('@')[0] ?? '';
  if (NO_REPLY.test(local.toLowerCase())) {
    return { reason: `Sent from ${message.from.address}, which does not read replies.` };
  }

  return null;
}
