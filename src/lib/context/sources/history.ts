import { getDb, type Db } from '../../db';
import { tokenize } from '../../rules/similarity';
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
      `SELECT id, subject, sent_at, draft, final_reply
         FROM tasks
        WHERE status = 'sent'
          AND id != ?
          -- COLLATE NOCASE rather than LOWER() on both sides: same answer,
          -- but it can use the index, which LOWER(from_address) cannot.
          AND from_address = ? COLLATE NOCASE
        ORDER BY COALESCE(sent_at, created_at) DESC
        LIMIT ?`,
    )
    .all(exceptTaskId, email.trim(), LOOKBACK) as PriorRow[];
}

export function describeHistory(rows: PriorRow[]): ContextBlock | null {
  // Nobody needs telling that a first-time sender is a first-time sender; the
  // absence of a card says it, and says it in no tokens.
  if (rows.length === 0) return null;

  const [latest] = rows;
  if (!latest) return null;

  const days = daysSince(latest.sent_at);
  const sentences: string[] = [
    `We have replied to them ${rows.length === 1 ? 'once' : `${rows.length} times`} before` +
      (days === null ? '.' : `, most recently ${ago(days)}.`),
  ];

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
      { label: 'Replies sent', value: String(rows.length) },
      ...(days === null ? [] : [{ label: 'Last reply', value: ago(days) }]),
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
