import Link from 'next/link';

import { requirePage } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';
import { listTasks } from '@/lib/tasks/store';

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
        {tasks.length === 0
          ? t('sender.none')
          : t('sender.summary', { total: tasks.length, replied: replied.length })}
      </p>

      {tasks.length > 0 && (
        <div className="card">
          <ul className="list">
            {tasks.map(task => (
              <li key={task.id}>
                <div className="row">
                  <a className="subject grow" href={`/tasks/${task.id}`}>
                    {task.subject || t('task.noSubject')}
                  </a>
                  <span className={`tag ${task.status}`}>{t(`task.status.${task.status}`)}</span>
                </div>
                <div className="meta">
                  {when(task.sentAt ?? task.receivedAt)}
                  {task.scope ? ` · ${task.scope}` : ''}
                </div>
                {/* What was actually said, not what was understood. On this
                    page the reply is the record; the analysis of the incoming
                    message is a note-to-self that has already served its
                    purpose. */}
                {task.finalReply && <div className="snippet">{task.finalReply.slice(0, 220)}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
