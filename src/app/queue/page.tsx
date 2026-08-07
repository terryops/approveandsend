import { requirePage } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';
import { listJobs, queueStats, type QueueStats } from '@/lib/queue';

import { deleteJobNow, releaseJobNow, retryJobNow, runQueue, sweepNow } from '../actions';

export const dynamic = 'force-dynamic';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();

  const query = await searchParams;
  const stats = queueStats();
  const jobs = listJobs({ limit: 50 });

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <span className="grow meta">
          {(Object.entries(stats) as [keyof QueueStats, number][]).map(([status, count]) => (
            <span key={status} style={{ marginRight: 14 }}>
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
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.type}</td>
                  <td>
                    <span className={`tag ${job.status === 'failed' ? 'failed' : ''}`}>
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
