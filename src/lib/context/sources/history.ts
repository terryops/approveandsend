import { getDb, type Db } from '../../db';
import { tokenize } from '../../rules/similarity';
import { IMPORTED_SEND } from '../../tasks/events';
import type { ContextBlock, ContextSource, LookupSubject } from '../types';

/**
 * What we have already said to this person.
 *
 * Every other source reaches outside for something the mailbox does not know.
 * This one reaches into the database the product already keeps, which makes it
 * the only lookup that needs no credentials, no configuration and no vendor —
 * it works on the first email of the first install.
 *
 * It is also the fact a human reviewer most reliably has and the model most
 * reliably lacks. Answering "sorry you're having trouble, could you tell me
 * more" to someone on their fourth email about the same thing is the single
 * most common way support writing goes wrong, and it is invisible from the
 * message in front of you.
 */

interface PriorRow {
  id: string;
  subject: string;
  sent_at: string | null;
  draft: string | null;
  final_reply: string | null;
  /** 'composed' means we started it. Nobody wrote to us. */
  origin: string;
  /** 1 where the send is an archive record rather than something we did. */
  imported: number;
}

const LOOKBACK = 6;

/** How much of the draft survived to the sent reply, 0 to 1. */
function kept(draft: string, sent: string): number {
  const before = new Set(tokenize(draft));
  const after = new Set(tokenize(sent));
  if (before.size === 0) return 1;

  let shared = 0;
  for (const token of after) if (before.has(token)) shared += 1;

  return shared / before.size;
}

function times(count: number): string {
  return count === 1 ? 'once' : `${count} times`;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
}

function ago(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

export function priorReplies(email: string, exceptTaskId: string, db: Db = getDb()): PriorRow[] {
  return db
    .prepare(
      `SELECT t.id, t.subject, t.sent_at, t.draft, t.final_reply, t.origin,
              EXISTS (
                SELECT 1 FROM task_events e
                 WHERE e.task_id = t.id AND e.action = 'sent' AND e.detail = ?
              ) AS imported
         FROM tasks t
        WHERE t.status = 'sent'
          AND t.id != ?
          -- COLLATE NOCASE rather than LOWER() on both sides: same answer,
          -- but it can use the index, which LOWER(from_address) cannot.
          AND t.from_address = ? COLLATE NOCASE
        ORDER BY COALESCE(t.sent_at, t.created_at) DESC
        LIMIT ?`,
    )
    .all(IMPORTED_SEND, exceptTaskId, email.trim(), LOOKBACK) as PriorRow[];
}

export function describeHistory(rows: PriorRow[]): ContextBlock | null {
  // Nobody needs telling that a first-time sender is a first-time sender; the
  // absence of a card says it, and says it in no tokens.
  if (rows.length === 0) return null;

  const [latest] = rows;
  if (!latest) return null;

  const days = daysSince(latest.sent_at);

  // Two things were being counted as one, and both of them overstated the
  // relationship. A mail the desk started is not a reply — saying "we have
  // replied to them thrice" about somebody who has never written to us
  // invites a draft that apologises for going over old ground with a stranger.
  const started = rows.filter(row => row.origin === 'composed').length;
  const answered = rows.length - started;
  const when = days === null ? '' : `, most recently ${ago(days)}`;

  const sentences: string[] = [];
  if (started === 0) {
    sentences.push(`We have replied to them ${times(answered)} before${when}.`);
  } else if (answered === 0) {
    sentences.push(
      `We have written to them ${times(started)} before${when} — they did not write to us, we started it.`,
    );
  } else {
    sentences.push(
      `We have ${rows.length} earlier messages with them${when}: ${times(answered)} answering them, ${times(started)} where we wrote first.`,
    );
  }

  // The count is what the database holds, which is not the same as what the
  // customer received. Records carried over from an older desk say an answer
  // was approved; whether it was ever delivered is not in them, and a reply
  // that refers to a mail nobody got reads as a lie about having helped.
  const imported = rows.filter(row => row.imported).length;
  if (imported > 0) {
    sentences.push(
      `${imported === rows.length ? 'Those are' : `${imported} of those are`} records carried over from the desk that ran before this one, which recorded answers as approved rather than as delivered — so do not tell them what we have already sent, or refer to it as though they read it.`,
    );
  }

  if (latest.subject.trim()) {
    sentences.push(`That exchange was about "${latest.subject.trim()}".`);
  }

  // Only worth saying when there is enough to be a pattern rather than an
  // anecdote, and only in the direction that changes how to write: that the
  // drafts for this person have needed rewriting.
  const edited = rows.filter(row => row.draft && row.final_reply && kept(row.draft, row.final_reply) < 0.6);
  if (rows.length >= 2 && edited.length >= 2) {
    sentences.push(
      `Drafts for this person have usually been rewritten before sending (${edited.length} of ${rows.length}), so aim closer than usual to what was actually sent.`,
    );
  }

  return {
    title: 'Earlier conversations',
    fields: [
      { label: started === 0 ? 'Replies sent' : 'Messages sent', value: String(rows.length) },
      ...(days === null ? [] : [{ label: started === 0 ? 'Last reply' : 'Last message', value: ago(days) }]),
      // On the card as well as in the prompt: the reviewer is the one who can
      // go and check the mailbox, and the number is only trustworthy to
      // whoever knows where it came from.
      ...(imported === 0
        ? []
        : [
            {
              label: 'Recorded by',
              value:
                imported === rows.length
                  ? 'the previous desk — approved, delivery unconfirmed'
                  : `${imported} of ${rows.length} by the previous desk`,
            },
          ]),
      ...(latest.subject.trim()
        ? [{ label: 'About', value: latest.subject.trim(), href: `/tasks/${latest.id}` }]
        : []),
    ],
    prompt: sentences.join(' '),
  };
}

export const historySource: ContextSource = {
  id: 'history',
  label: 'Earlier conversations',

  async lookup(subject: LookupSubject): Promise<ContextBlock | null> {
    if (!subject.email.trim()) return null;
    return describeHistory(priorReplies(subject.email, subject.taskId));
  },
};
