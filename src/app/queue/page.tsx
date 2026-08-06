import { requirePage } from '@/lib/auth/guard';
import { listJobs, queueStats } from '@/lib/queue';

import { runQueue } from '../actions';

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
          {Object.entries(stats).map(([status, count]) => (
            <span key={status} style={{ marginRight: 14 }}>
              {status}: <strong>{count}</strong>
            </span>
          ))}
        </span>
        <form action={runQueue}>
          <button type="submit">Run queue</button>
        </form>
      </div>

      {typeof query.ran === 'string' && <p className="meta">Processed {query.ran} job(s).</p>}
      {typeof query.error === 'string' && <p className="banner">{query.error}</p>}

      <div className="card">
        {jobs.length === 0 ? (
          <p className="empty">Queue is empty.</p>
        ) : (
          <table className="plain">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Tries</th>
                <th>Created</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.type}</td>
                  <td>
                    <span className={`tag ${job.status === 'failed' ? 'failed' : ''}`}>
                      {job.status}
                    </span>
                  </td>
                  <td>
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className="meta">{job.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="meta">{job.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
