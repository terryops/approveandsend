import { redirect } from 'next/navigation';

import { requirePage } from '@/lib/auth/guard';
import { shouldOnboard } from '@/lib/setup/state';
import { countTasksByStatus, listTasks } from '@/lib/tasks/store';
import { TASK_STATUSES, isTaskStatus, type TaskStatus } from '@/lib/tasks/types';

import { loadDemo, logout, runQueue, syncNow } from './actions';

export const dynamic = 'force-dynamic';

const FILTERS: (TaskStatus | 'all')[] = ['awaiting_review', 'pending', 'failed', 'sent', 'all'];

const LABELS: Record<string, string> = {
  awaiting_review: 'To review',
  pending: 'Waiting',
  drafting: 'Drafting',
  failed: 'Failed',
  sent: 'Sent',
  dismissed: 'Dismissed',
  all: 'Everything',
};

function when(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16).replace('T', ' ');
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();

  // An install with no configuration and no data has nothing to show here but
  // an explanation of why it is empty, which is what the wizard is. It stops
  // once setup is finished or dismissed — nobody gets sent to /setup because
  // they cleared their inbox.
  if (shouldOnboard()) redirect('/setup');

  const params = await searchParams;
  const requested = typeof params.status === 'string' ? params.status : 'awaiting_review';
  const status = isTaskStatus(requested) ? requested : null;

  const tasks = listTasks({ ...(status ? { status } : {}), limit: 100 });
  const counts = countTasksByStatus();

  const notice =
    typeof params.error === 'string'
      ? { kind: 'error', text: params.error }
      : typeof params.sent === 'string'
        ? { kind: 'ok', text: 'Sent. The learning job is queued.' }
        : typeof params.synced === 'string'
          ? { kind: 'ok', text: `Synced. ${params.synced} new email(s).` }
          : typeof params.demo === 'string'
            ? {
                kind: 'ok',
                text: `Loaded ${params.demo} sample emails and a rulebook. None of it is real, and nothing will be sent.`,
              }
            : null;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          {TASK_STATUSES.filter((s) => counts[s]).map((s) => (
            <span key={s} className="meta" style={{ marginRight: 14 }}>
              {LABELS[s] ?? s}: <strong>{counts[s]}</strong>
            </span>
          ))}
        </div>
        <form action={syncNow}>
          <button type="submit">Fetch mail</button>
        </form>
        <form action={runQueue}>
          <button type="submit">Run queue</button>
        </form>
        <form action={logout}>
          <button type="submit">Sign out</button>
        </form>
      </div>

      {notice && (
        <p className="banner" style={notice.kind === 'ok' ? { borderColor: 'var(--line)' } : {}}>
          {notice.text}
        </p>
      )}

      <div className="filters">
        {FILTERS.map((f) => (
          <a
            key={f}
            href={`/?status=${f}`}
            className={requested === f ? 'active' : ''}
          >
            {LABELS[f] ?? f}
          </a>
        ))}
      </div>

      <div className="card">
        {tasks.length === 0 ? (
          <div className="empty">
            <p>Nothing here. Fetch mail to pull the inbox in.</p>
            {/* Only offered on a genuinely empty database — see seedDemoData. */}
            <form action={loadDemo}>
              <button type="submit">Load sample data</button>
            </form>
          </div>
        ) : (
          <ul className="list">
            {tasks.map((task) => (
              <li key={task.id}>
                <div className="row">
                  <a className="subject grow" href={`/tasks/${task.id}`}>
                    {task.subject || '(no subject)'}
                  </a>
                  <span className={`tag ${task.status}`}>{LABELS[task.status] ?? task.status}</span>
                </div>
                <div className="meta">
                  {task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
                  {task.receivedAt ? ` · ${when(task.receivedAt)}` : ''}
                  {task.scope ? ` · ${task.scope}` : ''}
                </div>
                {task.analysis?.intent && <div className="snippet">{task.analysis.intent}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
