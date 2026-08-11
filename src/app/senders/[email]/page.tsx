import Link from 'next/link';

import { BillingCard } from '../../billing-card';
import { requirePage } from '@/lib/auth/guard';
import { stripeConfigured } from '@/lib/billing/stripe';
import { t } from '@/lib/i18n';
import { listTasks } from '@/lib/tasks/store';
import { deskedAt } from '@/lib/tasks/types';

export const dynamic = 'force-dynamic';

/**
 * One correspondent, everything.
 *
 * The context card on a task already says "we have replied to them 3 times
 * before" in a sentence, which is what the *model* needs. This is for the
 * reviewer who has read that sentence and now has to answer "yes, but what did
 * we tell them?" — usually because the reply in front of them is about to
 * contradict one of those.
 *
 * Chronological, not by priority, and every status: a correspondence read back
 * in queue order is not a correspondence, and the dismissed ones are often the
 * interesting part, because "we decided not to answer this" is a decision too.
 */

function when(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16).replace('T', ' ');
}

export default async function SenderPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  await requirePage();

  const { email: raw } = await params;
  // Next decodes the segment once; an address is not a path and does not need
  // decoding twice, but it does need trimming — a trailing slash in a pasted
  // link arrives here as part of the address.
  const email = decodeURIComponent(raw).trim();

  const tasks = listTasks({ fromAddress: email, order: 'newest', limit: 200 });
  const replied = tasks.filter(task => task.status === 'sent');

  return (
    <>
      <p className="meta">
        <Link href="/">{t('task.backToInbox')}</Link>
      </p>

      <h1>{email}</h1>
      <p className="meta">
        {tasks.length === 0 ? (
          t('sender.none')
        ) : (
          <>
            {t('sender.summary', { total: tasks.length, replied: replied.length })}
            {/* The question that follows "what did we tell them" is almost
                always "and what are they worth to us", so it has an answer on
                the page that raises it.

                Only where the card below is not already carrying it. That card
                answers this question in four facts and then offers the same
                link, so on a desk with Stripe configured this sentence was the
                second door to one screen — and the weaker of the two, because
                it says nothing until it is followed. `stripeConfigured` is the
                same check `BillingCard` opens with and touches no network, so
                the two cannot disagree about which of them is speaking. */}
            {!stripeConfigured() && (
              <>
                {' · '}
                <Link href={`/billing/${encodeURIComponent(email)}`}>{t('sender.billing')}</Link>
              </>
            )}
          </>
        )}
      </p>

      {/* Above the correspondence rather than under it. This page is opened to
          read a thread back, and the thing that changes how the *next* reply
          reads — a lapsed subscription, a refund already given — belongs before
          the reading rather than after it. Renders nothing at all on a desk with
          no Stripe key; see `BillingCard`. */}
      <BillingCard email={email} />

      {tasks.length > 0 && (
        // A line rather than a list of cards. This page is opened to read a
        // correspondence back, and a correspondence has a direction — the rule
        // down the left and a mark per entry are what make forty rows read as
        // one thread instead of forty unrelated records.
        <ol className="thread-line">
          {tasks.map(task => (
            <li key={task.id} className={task.status}>
              <span className={`mark ${task.status}`} aria-hidden="true" />
              <p className="when">
                {when(task.sentAt ?? deskedAt(task))} · {t(`task.status.${task.status}`)}
                {task.scope ? ` · ${task.scope}` : ''}
              </p>
              <p className="what">
                <Link href={`/tasks/${task.id}`}>{task.subject || t('task.noSubject')}</Link>
              </p>

              {/* What was actually said, in full and at body size. It is the
                  only quoted text on this page — everything else is a note
                  about it — and it used to be 220 grey characters with the
                  rest cut off, which is where the promises live: "five to ten
                  working days", "we'll refund this one". Those are precisely
                  the sentences the next reply must not contradict, and a
                  support reply is a few paragraphs, so there is nothing to
                  save by truncating it. */}
              {task.finalReply && <p className="said">{task.finalReply}</p>}

              {/* Deciding not to answer is a decision too, so it stays on the
                  line, and the reason is written at reading weight rather than
                  filed under the row. */}
              {task.status === 'dismissed' && task.rejectionReason && (
                <p className="meta">{t('task.rejectedBecause', { reason: task.rejectionReason })}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
