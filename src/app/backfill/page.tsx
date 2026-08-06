import { requirePage } from '@/lib/auth/guard';
import {
  countBackfillByStatus,
  listBackfillItems,
  totalRulesLearned,
} from '@/lib/backfill/store';
import { DEFAULT_SCAN_LIMIT } from '@/lib/backfill/scan';
import { t } from '@/lib/i18n';

import { clearBackfillHistory, startBackfill, stopBackfill } from '../actions';

export const dynamic = 'force-dynamic';

const STATUSES = ['pending', 'learning', 'learned', 'skipped', 'failed'];

function statusLabel(status: string): string | undefined {
  switch (status) {
    case 'pending':
      return t('backfill.statusQueued');
    case 'learning':
      return t('backfill.statusWorking');
    case 'learned':
      return t('backfill.statusLearned');
    case 'skipped':
      return t('backfill.statusSkipped');
    case 'failed':
      return t('backfill.statusFailed');
    default:
      return undefined;
  }
}

function when(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export default async function BackfillPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();

  const params = await searchParams;
  const counts = countBackfillByStatus();
  const items = listBackfillItems({ limit: 200 });
  const rules = totalRulesLearned();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const notice =
    typeof params.started === 'string'
      ? t('backfill.noticeStarted')
      : typeof params.stopped === 'string'
        ? t('backfill.noticeStopped', { n: params.stopped })
        : typeof params.cleared === 'string'
          ? t('backfill.noticeCleared')
          : null;

  return (
    <>
      <h1>{t('backfill.heading')}</h1>

      <p className="prose">{t('backfill.intro')}</p>

      <p className="prose meta">
        {t('backfill.explainerBefore')} <em>{t('backfill.explainerWould')}</em>{' '}
        {t('backfill.explainerAfter')}
      </p>

      {notice && <p className="banner">{notice}</p>}

      <div className="card">
        <form action={startBackfill} className="row">
          <label className="grow">
            {t('backfill.lookBackLabel')}
            <input type="number" name="months" defaultValue={12} min={1} max={120} />
            {t('backfill.monthsUnit')}
          </label>
          <label className="grow">
            {t('backfill.atMostLabel')}
            <input type="number" name="limit" defaultValue={DEFAULT_SCAN_LIMIT} min={1} max={5000} />
            {t('backfill.repliesUnit')}
          </label>
          <button type="submit">{t('backfill.scanButton')}</button>
        </form>
      </div>

      {total > 0 && (
        <>
          <div className="row" style={{ margin: '16px 0' }}>
            <div className="grow">
              {STATUSES.filter((s) => counts[s]).map((s) => (
                <span key={s} className="meta" style={{ marginRight: 14 }}>
                  {statusLabel(s)}: <strong>{counts[s]}</strong>
                </span>
              ))}
              <span className="meta">
                {t('backfill.rulesProduced')}: <strong>{rules}</strong>
              </span>
            </div>
            {counts.pending ? (
              <form action={stopBackfill}>
                <button type="submit">{t('backfill.stopButton')}</button>
              </form>
            ) : null}
            <form action={clearBackfillHistory}>
              <button className="danger" type="submit">
                {t('backfill.clearHistoryButton')}
              </button>
            </form>
          </div>

          <div className="card">
            <ul className="list">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="row">
                    <span className="subject grow">{item.subject || t('backfill.noSubject')}</span>
                    <span className={`tag ${item.status === 'learned' ? 'sent' : item.status}`}>
                      {statusLabel(item.status) ?? item.status}
                      {item.rulesLearned > 0
                        ? ` · ${t('backfill.rulesLearnedCount', { n: item.rulesLearned })}`
                        : ''}
                    </span>
                  </div>
                  <div className="meta">
                    {item.counterparty}
                    {item.sentAt ? ` · ${when(item.sentAt)}` : ''}
                    {/* Why an email taught nothing is worth reading: a mailbox
                        that is mostly notifications says so here rather than
                        looking like a broken run. */}
                    {item.skipReason ? ` · ${item.skipReason}` : ''}
                    {item.error ? ` · ${item.error}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
