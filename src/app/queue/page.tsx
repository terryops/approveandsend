import Link from 'next/link';

import { requireAdminPage } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';
import { listJobs, queueStats, type QueueStats } from '@/lib/queue';
import { readQueue } from '@/lib/queue/verdict';

import { deleteJobNow, releaseJobNow, retryJobNow, runQueue, sweepNow } from '../actions';

export const dynamic = 'force-dynamic';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();

  const query = await searchParams;
  const stats = queueStats();
  const jobs = listJobs({ limit: 50 });
  const verdict = readQueue(jobs);
  const failure = verdict.jobId ? jobs.find(job => job.id === verdict.jobId) : undefined;

  return (
    <>
      {/* Hidden, for the reason the inbox's is — see the note there. */}
      <h1 className="visually-hidden">{t('nav.queue')}</h1>

      {/* First, because this screen is only ever opened because something did
          not happen, and five counts are not an answer to that. The way out is
          the half that matters: `AI_MODEL is required` is fixed in setup, not
          by the Retry button that used to be the only thing on offer. */}
      <div className={`queue-verdict${verdict.stuck ? '' : ' clear'}`}>
        <h2>{t(verdict.what)}</h2>
        {verdict.stuck && (
          <>
            {/* Verbatim. Rewriting an error we did not recognise is how a
                signpost ends up pointing at the wrong setting. */}
            {failure?.error && <p className="what-it-said">{failure.error}</p>}
            {verdict.fix && (
              <div className="actions">
                <Link className="button-link" href={verdict.fix.href}>
                  {t(verdict.fix.label)}
                </Link>
              </div>
            )}
          </>
        )}
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <span className="grow meta stats">
          {/* Each count is one unit and must not come apart. Chinese and
              Japanese wrap between any two characters, so "失败: 1" broke into
              "失" and "败: 1" on a narrow screen — a label split down the middle
              and a number attached to half of it. */}
          {(Object.entries(stats) as [keyof QueueStats, number][]).map(([status, count]) => (
            <span className="stat" key={status}>
              {t(`queue.status.${status}`)}: <strong>{count}</strong>
            </span>
          ))}
        </span>
        <form action={runQueue}>
          <button type="submit">{t('queue.runQueue')}</button>
        </form>
        {/* Deliberately not automatic on page load: it writes to tasks, and a
            repair that runs because somebody opened a tab is a repair nobody
            can say happened. */}
        <form action={sweepNow} style={{ marginLeft: 8 }}>
          <button type="submit">{t('queue.sweep')}</button>
        </form>
      </div>

      {typeof query.ran === 'string' && (
        <p className="meta">{t('queue.processed', { n: query.ran })}</p>
      )}
      {typeof query.swept === 'string' && (
        <p className="meta">{t('queue.swept', { n: query.swept })}</p>
      )}
      {typeof query.retried === 'string' && <p className="meta">{t('queue.retried')}</p>}
      {typeof query.released === 'string' && <p className="meta">{t('queue.released')}</p>}
      {typeof query.deleted === 'string' && <p className="meta">{t('queue.deleted')}</p>}
      {typeof query.error === 'string' && <p className="banner">{query.error}</p>}

      <div className="card">
        {jobs.length === 0 ? (
          <p className="empty">{t('queue.empty')}</p>
        ) : (
          /* Six columns will not fit a phone, and the alternative to scrolling
             them sideways is a stack of error strings one word wide. */
          <div className="scroll-x">
            <table className="plain">
              <thead>
              <tr>
                <th>{t('queue.colType')}</th>
                <th>{t('queue.colStatus')}</th>
                <th>{t('queue.colTries')}</th>
                <th>{t('queue.colCreated')}</th>
                <th>{t('queue.colDetail')}</th>
                {/* Named, not blank: a screen reader announcing the retry
                    and delete buttons otherwise gives them no column. */}
                <th className="visually-hidden">{t('queue.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                /* The row the block above is talking about, marked — so "a job
                   failed" and the fifty rows under it can be joined up without
                   reading every Detail cell. */
                <tr key={job.id} className={job.id === verdict.jobId ? 'failed' : undefined}>
                  <td>{job.type}</td>
                  <td>
                    {/* The status word carries the meaning, but the colour is
                        what gets a failed job found in a list of fifty. */}
                    <span className={`tag ${job.status}`}>
                      {t(`queue.status.${job.status}`)}
                    </span>
                  </td>
                  <td>
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className="meta">{job.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="meta">{job.error ?? ''}</td>
                  <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    {/* Offered only where they mean something. A retry button
                        on a pending job either does nothing or resets an
                        attempt counter that was counting for a reason. */}
                    {job.status === 'failed' && (
                      <form action={retryJobNow}>
                        <input type="hidden" name="jobId" value={job.id} />
                        <button type="submit" className="link">
                          {t('queue.retry')}
                        </button>
                      </form>
                    )}
                    {job.status === 'processing' && (
                      <form action={releaseJobNow}>
                        <input type="hidden" name="jobId" value={job.id} />
                        <button type="submit" className="link">
                          {t('queue.release')}
                        </button>
                      </form>
                    )}
                    {job.status !== 'processing' && (
                      <form action={deleteJobNow}>
                        <input type="hidden" name="jobId" value={job.id} />
                        <button type="submit" className="link danger">
                          {t('queue.delete')}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
