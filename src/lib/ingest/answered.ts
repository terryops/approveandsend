import { groupIntoThreads } from '../mail/threading';
import type { MailMessage } from '../mail/types';

/**
 * Which inbound messages have already been answered.
 *
 * Without this, the first sync of an established mailbox drafts a reply to
 * every mail in the window — including the several hundred a human answered
 * last week — and a reviewer's first impression of the desk is a queue of work
 * that was finished before they arrived. It is also wrong every day after that,
 * on any mail somebody answered from their own client.
 *
 * The test is "is there a reply of ours in this conversation, sent after this
 * message". Not "is there a reply in this conversation": a customer who writes
 * back after we answered is exactly the case that still needs a draft, and
 * treating the older reply as an answer to the newer question would silently
 * drop the follow-up.
 *
 * Conversations are reconstructed with `groupIntoThreads`, which is
 * deliberately conservative about the subject fallback. Merging two customers
 * would leak one's mail into the other's prompt; merging one customer's two
 * separate tickets would drop a real question. Both are worse than drafting a
 * reply nobody needed.
 */

const time = (m: MailMessage) => new Date(m.receivedAt).getTime();

export interface AnsweredOptions {
  /**
   * How long after an inbound message a reply still counts as answering it.
   *
   * Guards the one case timestamps alone get wrong: a reply written seconds
   * *before* the customer's next mail arrives is not an answer to it, but
   * clock skew between a mail server and ours can make it look like one.
   */
  toleranceMs?: number;
}

/**
 * The ids of `inbound` messages that already have a reply from us.
 *
 * `sent` is what the mailbox's Sent folder returned. An empty list means
 * nothing is filtered, which is the right answer for a provider that cannot
 * list sent mail — better a queue with some finished work in it than a desk
 * that silently swallows real questions.
 */
export function answeredMessageIds(
  inbound: MailMessage[],
  sent: MailMessage[],
  options: AnsweredOptions = {},
): Set<string> {
  const answered = new Set<string>();
  if (inbound.length === 0 || sent.length === 0) return answered;

  const tolerance = options.toleranceMs ?? 60_000;
  const sentIds = new Set(sent.map(m => m.id));

  for (const group of groupIntoThreads([...inbound, ...sent])) {
    const ours = group.filter(m => sentIds.has(m.id));
    if (ours.length === 0) continue;

    // The last thing we said in this conversation. Anything the customer sent
    // before it has been answered; anything after it has not.
    const lastReply = Math.max(...ours.map(time));

    for (const message of group) {
      if (sentIds.has(message.id)) continue;
      if (time(message) <= lastReply + tolerance) answered.add(message.id);
    }
  }

  return answered;
}
