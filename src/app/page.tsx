import { redirect } from 'next/navigation';

import { requirePage } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';
import { shouldOnboard } from '@/lib/setup/state';
import { countTasksByStatus, listTasks } from '@/lib/tasks/store';
import { TASK_STATUSES, isTaskStatus, type TaskStatus } from '@/lib/tasks/types';

import { loadDemo, logout, runQueue, syncNow } from './actions';

export const dynamic = 'force-dynamic';

const FILTERS: (TaskStatus | 'all')[] = ['awaiting_review', 'pending', 'failed', 'sent', 'all'];

// Built per request rather than at module scope: the locale is resolved from
// the workspace config, which is not readable while this module is evaluated.
function labels(): Record<string, string> {
  return {
    awaiting_review: t('inbox.statusAwaitingReview'),
    pending: t('inbox.statusPending'),
    drafting: t('inbox.statusDrafting'),
    failed: t('inbox.statusFailed'),
    sent: t('inbox.statusSent'),
    dismissed: t('inbox.statusDismissed'),
    all: t('inbox.statusAll'),
  };
}

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
  const LABELS = labels();

  const notice =
    typeof params.error === 'string'
      ? { kind: 'error', text: params.error }
      : typeof params.sent === 'string'
        ? { kind: 'ok', text: t('inbox.sentLearningQueued') }
        : typeof params.synced === 'string'
          ? { kind: 'ok', text: t('inbox.synced', { count: params.synced }) }
          : typeof params.demo === 'string'
            ? {
                kind: 'ok',
                text: t('inbox.demoLoaded', { count: params.demo }),
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
          <button type="submit">{t('inbox.fetchMail')}</button>
        </form>
        <form action={runQueue}>
          <button type="submit">{t('inbox.runQueue')}</button>
        </form>
        <form action={logout}>
          <button type="submit">{t('inbox.signOut')}</button>
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
            <p>{t('inbox.emptyTitle')}</p>
            {/* Only offered on a genuinely empty database — see seedDemoData. */}
            <form action={loadDemo}>
              <button type="submit">{t('inbox.loadSampleData')}</button>
            </form>
          </div>
        ) : (
          <ul className="list">
            {tasks.map((task) => (
              <li key={task.id}>
                <div className="row">
                  <a className="subject grow" href={`/tasks/${task.id}`}>
                    {task.subject || t('inbox.noSubject')}
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
