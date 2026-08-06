import { requirePage } from '@/lib/auth/guard';
import {
  countBackfillByStatus,
  listBackfillItems,
  totalRulesLearned,
} from '@/lib/backfill/store';
import { DEFAULT_SCAN_LIMIT } from '@/lib/backfill/scan';

import { clearBackfillHistory, startBackfill, stopBackfill } from '../actions';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = {
  pending: 'Queued',
  learning: 'Working',
  learned: 'Learned from',
  skipped: 'Skipped',
  failed: 'Failed',
};

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
      ? 'Scanning. Run the queue, or wait for the scheduler — this takes a while and it is meant to.'
      : typeof params.stopped === 'string'
        ? `Stopped. ${params.stopped} item(s) will not be read. Anything already generating will finish.`
        : typeof params.cleared === 'string'
          ? 'Cleared. The rules it taught are still in the rulebook.'
          : null;

  return (
    <>
      <h1>Learn from the archive</h1>

      <p className="prose">
        The review loop learns from your edits, which means a fresh install knows nothing
        until you have worked through a few weeks of mail. Your Sent folder already
        contains the answers. This reads them.
      </p>

      <p className="prose meta">
        For each archived reply it drafts what the assistant <em>would</em> write today,
        compares that against what you actually sent, and keeps only what the difference
        teaches. Nothing is sent, nothing appears in your inbox, and every rule it
        produces is listed on the Rules screen with the conversation behind it. Budget
        two or three model calls per email.
      </p>

      {notice && <p className="banner">{notice}</p>}

      <div className="card">
        <form action={startBackfill} className="row">
          <label className="grow">
            Look back
            <input type="number" name="months" defaultValue={12} min={1} max={120} />
            months
          </label>
          <label className="grow">
            At most
            <input type="number" name="limit" defaultValue={DEFAULT_SCAN_LIMIT} min={1} max={5000} />
            replies
          </label>
          <button type="submit">Scan the Sent folder</button>
        </form>
      </div>

      {total > 0 && (
        <>
          <div className="row" style={{ margin: '16px 0' }}>
            <div className="grow">
              {Object.keys(LABELS)
                .filter((s) => counts[s])
                .map((s) => (
                  <span key={s} className="meta" style={{ marginRight: 14 }}>
                    {LABELS[s]}: <strong>{counts[s]}</strong>
                  </span>
                ))}
              <span className="meta">
                Rules produced: <strong>{rules}</strong>
              </span>
            </div>
            {counts.pending ? (
              <form action={stopBackfill}>
                <button type="submit">Stop</button>
              </form>
            ) : null}
            <form action={clearBackfillHistory}>
              <button className="danger" type="submit">
                Clear history
              </button>
            </form>
          </div>

          <div className="card">
            <ul className="list">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="row">
                    <span className="subject grow">{item.subject || '(no subject)'}</span>
                    <span className={`tag ${item.status === 'learned' ? 'sent' : item.status}`}>
                      {LABELS[item.status] ?? item.status}
                      {item.rulesLearned > 0 ? ` · ${item.rulesLearned} rule` : ''}
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
