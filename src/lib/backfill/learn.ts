import type { Db } from '../db';
import { getDb } from '../db';
import { draftReply } from '../drafting/draft';
import { mailProvider } from '../mail/config';
import type { MailMessageDetail, MailProvider } from '../mail/types';
import { learnFromSentReply, type LearningOutcome } from '../rules/learn';
import type { Task } from '../tasks/types';
import { htmlToText, trimEmailBody } from '../thread-context';
import { getBackfillItem, updateBackfillItem } from './store';
import type { BackfillItem } from './types';

/**
 * Teaching the rulebook from one archived reply.
 *
 * Nothing in this file may send mail. It reads the mailbox, generates a draft
 * that is thrown away, and writes rules. That is worth stating because the
 * alternative — reusing the review pipeline, which ends in `sendReply` — would
 * put a code path capable of mailing a customer about a two-year-old refund
 * one wrong branch away from a loop that runs hundreds of times unattended.
 * The counterfactual draft never touches a Task row and never reaches SMTP.
 */

export interface RunItemOptions {
  provider?: MailProvider;
  db?: Db;
  /** Run the critic over the counterfactual draft. Default true — see below. */
  critic?: boolean;
  /** Cap on rules from one archived exchange. Default 1. */
  maxNewRules?: number;
}

export interface RunItemResult {
  status: BackfillItem['status'];
  /** Why nothing was learned, when nothing was. */
  reason?: string;
  rulesLearned: number;
  outcome?: LearningOutcome;
}

const MAX_BODY_CHARS = 12_000;

function bodyOf(detail: MailMessageDetail): string {
  const text = detail.text?.trim();
  if (text) return trimEmailBody(text);
  return detail.html ? trimEmailBody(htmlToText(detail.html)) : '';
}

/**
 * A Task that is never stored.
 *
 * `draftReply` wants a Task because that is what it drafts against, but a
 * backfill item is not one and must not become one — five hundred archived
 * conversations in the review queue is exactly the outcome the separate table
 * exists to avoid. Everything the drafter reads is here; everything it does
 * not read is left null rather than invented.
 */
function syntheticTask(item: BackfillItem, incoming: MailMessageDetail, body: string): Task {
  const now = new Date().toISOString();
  return {
    id: `backfill:${item.id}`,
    status: 'pending',
    scope: null,
    priority: 9,
    messageId: incoming.id,
    threadId: incoming.threadId ?? null,
    messageIdHeader: incoming.messageIdHeader ?? null,
    subject: incoming.subject,
    fromAddress: incoming.from.address,
    fromName: incoming.from.name ?? null,
    receivedAt: incoming.receivedAt,
    body,
    analysis: null,
    draft: null,
    finalReply: null,
    reviewerNotes: null,
    sentAt: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The message our reply was answering: the newest message in the thread that
 * came from somebody else, at or before the moment we replied.
 *
 * "Somebody else" is decided by comparing against the sender of our own reply
 * rather than by reading `MAIL_USER`, because the two differ more often than
 * you would think — aliases, shared mailboxes, a support address that forwards
 * to a personal one — and getting it wrong would pair a reply with itself.
 */
export function findAnsweredMessage(
  ours: MailMessageDetail,
  thread: MailMessageDetail[],
): MailMessageDetail | null {
  const us = ours.from.address.toLowerCase();
  const sentAt = new Date(ours.receivedAt).getTime();

  const candidates = thread
    .filter(m => m.id !== ours.id)
    .filter(m => m.from.address.toLowerCase() !== us)
    .filter(m => {
      const at = new Date(m.receivedAt).getTime();
      return Number.isNaN(at) || Number.isNaN(sentAt) || at <= sentAt;
    });

  if (candidates.length === 0) return null;

  return candidates.reduce((newest, m) =>
    new Date(m.receivedAt).getTime() > new Date(newest.receivedAt).getTime() ? m : newest,
  );
}

export async function runBackfillItem(
  itemId: string,
  options: RunItemOptions = {},
): Promise<RunItemResult> {
  const db = options.db ?? getDb();
  const provider = options.provider ?? mailProvider();

  const item = getBackfillItem(itemId, db);
  if (!item) return { status: 'failed', reason: 'No such item', rulesLearned: 0 };

  const skip = (reason: string): RunItemResult => {
    updateBackfillItem(itemId, { status: 'skipped', skipReason: reason }, db);
    return { status: 'skipped', reason, rulesLearned: 0 };
  };

  updateBackfillItem(itemId, { status: 'learning', error: null }, db);

  const ours = await provider.getMessage(item.sentMessageId);
  const sentReply = bodyOf(ours).slice(0, MAX_BODY_CHARS);
  if (!sentReply.trim()) return skip('The reply has no readable body');

  const thread = await provider.getThread(ours);
  const incoming = findAnsweredMessage(ours, thread);
  // Mail we started rather than mail we answered: announcements, cold outreach,
  // a note to a colleague. There is no "what would we have replied" question to
  // ask about a message that replied to nothing.
  if (!incoming) return skip('Nothing inbound preceded this reply');

  const incomingBody = bodyOf(incoming).slice(0, MAX_BODY_CHARS);
  if (!incomingBody.trim()) return skip('The message it answered has no readable body');

  updateBackfillItem(
    itemId,
    {
      incomingMessageId: incoming.id,
      counterparty: incoming.from.address || item.counterparty,
      subject: item.subject || incoming.subject,
    },
    db,
  );

  const task = syntheticTask(item, incoming, incomingBody);

  // The critic runs by default, and its cost is the point. Without it the diff
  // shows what the drafter gets wrong; with it the diff shows what the *whole
  // pipeline* still gets wrong, and a rule teaching something the critic
  // already catches is a rule that earns nothing and costs a prompt slot
  // forever.
  const shadow = await draftReply(task, {
    critic: options.critic !== false,
    recordUsage: false,
    // No looked-up context. A subscription as it stands today says nothing
    // true about the account as it stood when this reply was written two years
    // ago, and a rule learned from a fact the writer never had is a rule
    // learned from fiction.
    context: '',
    db,
  });

  const outcome = await learnFromSentReply(
    {
      taskId: task.id,
      scope: shadow.analysis.scope ?? null,
      incomingSubject: incoming.subject,
      incomingBody,
      originalDraft: shadow.draft,
      sentReply,
      mode: 'counterfactual',
    },
    // One rule per archived exchange. The review loop allows two, but it is
    // reading a deliberate human correction; this is reading a coincidence
    // until proven otherwise, and a run of four hundred items at two rules
    // each would bury the rulebook it is meant to be building.
    { db, maxNewRules: options.maxNewRules ?? 1 },
  );

  // A merge or a replace changed the rulebook just as much as an add did. Only
  // 'skip' — the deduper deciding this rule was already written — taught
  // nothing.
  const learned = outcome.results.filter(r => r.action !== 'skip').length;

  updateBackfillItem(
    itemId,
    { status: 'learned', shadowDraft: shadow.draft, rulesLearned: learned, error: null },
    db,
  );

  return { status: 'learned', rulesLearned: learned, outcome };
}
