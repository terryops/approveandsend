import Link from 'next/link';

import { requireAdminPage } from '@/lib/auth/guard';
import {
  countBackfillByStatus,
  listBackfillItems,
  totalRulesLearned,
} from '@/lib/backfill/store';
import { DEFAULT_SCAN_LIMIT } from '@/lib/backfill/scan';
import { t } from '@/lib/i18n';

import { askBackfill, clearBackfillHistory, startBackfill, stopBackfill } from '../actions';
import { DismissOnEscape } from '../dismiss-on-escape';

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

/**
 * How far back the four buttons offer to go.
 *
 * A number box was the wrong control for this. It asks a question nobody has an
 * answer to — there is no seven-month reason — and it hides the thing that
 * actually matters, which is that this is the dial with the price on it. Four
 * spans, all of them on screen: a quarter, a season, half a year, a year.
 */
const WINDOWS = [1, 3, 6, 12];

/**
 * The window the form is set to, read back out of the address.
 *
 * The confirmation is a page state rather than a browser dialog, so the two
 * numbers make a round trip through the URL and have to survive a reload, a
 * bookmark and a hand-edited address. Bounded here the way `askBackfill` bounds
 * them, and defaulted so that the bare page — where nobody has typed anything
 * yet — gets the same answer without a special case.
 */
function askedWindow(params: Record<string, string | string[] | undefined>): {
  months: number;
  limit: number;
} {
  const read = (name: string, fallback: number, min: number, max: number): number => {
    const raw = params[name];
    const value = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };

  // Snapped to one of the four, because an address carrying `months=7` — an old
  // link, a hand edit, a run started before this row was four buttons — would
  // otherwise light none of them, and a group of radios with nothing selected
  // posts no `months` at all. The panel would then quote a span the scan was
  // never going to use.
  const asked = read('months', 12, 1, 120);
  const months = WINDOWS.reduce((best, span) =>
    Math.abs(span - asked) < Math.abs(best - asked) ? span : best,
  );

  return { months, limit: read('limit', DEFAULT_SCAN_LIMIT, 1, 5000) };
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
  await requireAdminPage();

  const params = await searchParams;
  const ask = askedWindow(params);
  /* This page with no panel over it. It carries the two numbers so that
     backing out of the confirmation returns to the form somebody filled in
     rather than to the defaults. */
  const here = `/backfill?months=${ask.months}&limit=${ask.limit}`;
  const counts = countBackfillByStatus();
  const items = listBackfillItems({ limit: 200 });
  const rules = totalRulesLearned();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  // Everything that is no longer waiting to be read, whatever became of it.
  // Learned, skipped and failed are all "done with" as far as a progress bar is
  // concerned — what each of them taught is the breakdown's job, below.
  const done = total - (counts.pending ?? 0);

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
        {/* Asks first. This is the most expensive button on the desk — a run of
            two hundred is some eight hundred model calls and hours of queue —
            and the label reads like listing a folder. */}
        <form action={askBackfill} className="row">
          {/* `row` on the label itself, because each of these is a sentence with
              a box in the middle of it — "look back [12] months" — and a label
              whose parts are stacked block-wise is three fragments instead. The
              gap comes from the spacing scale rather than from spaces in the
              dictionary, which is where a translator would otherwise have to
              remember to put them. */}
          {/* The one control on this row that is not a label wrapping its
              input, because four radios cannot share one: each pill is its own
              label, and the sentence they sit inside is held together by the
              group instead. The unit stays outside it — "look back [1][3][6][12]
              months" is the same sentence the number box was in. */}
          <div className="row grow">
            <span>{t('backfill.lookBackLabel')}</span>
            <div className="window-tabs" role="group" aria-label={t('backfill.lookBackLabel')}>
              {WINDOWS.map(span => (
                <label key={span} className="window">
                  <input
                    type="radio"
                    name="months"
                    value={span}
                    defaultChecked={span === ask.months}
                  />
                  {span}
                </label>
              ))}
            </div>
            <span>{t('backfill.monthsUnit')}</span>
          </div>
          <label className="row grow">
            {t('backfill.atMostLabel')}
            <input type="number" name="limit" defaultValue={ask.limit} min={1} max={5000} />
            {t('backfill.repliesUnit')}
          </label>
          <button type="submit">{t('backfill.scanButton')}</button>
        </form>
      </div>

      {/* What the scan costs, before it is spent.
          Every number here is a property of the run rather than a hedge: four
          calls is classify, draft, critic and extraction — see
          `runBackfillItem` — the tidy every 25 items is `CONSOLIDATE_EVERY`,
          and "nothing is sent" is the whole reason `learn.ts` builds a
          synthetic task instead of reusing the review pipeline. */}
      {params.scan === 'ask' && (
        <div className="confirm-scrim">
          <form
            className="confirm card stack"
            action={startBackfill}
            role="dialog"
            aria-labelledby="scan-title"
          >
            <DismissOnEscape href={here} />

            {/* The panel is what posts the run, so it carries the window it is
                describing. Without these the confirmed scan would silently be
                the defaults rather than what the sentence above the buttons
                just promised. */}
            <input type="hidden" name="months" value={ask.months} />
            <input type="hidden" name="limit" value={ask.limit} />

            <h2 id="scan-title">{t('backfill.scanAsk.title')}</h2>
            <p className="meta">
              {t('backfill.scanAsk.scope', { limit: ask.limit, months: ask.months })}
            </p>
            <p>{t('backfill.scanAsk.cost', { calls: ask.limit * 4 })}</p>
            <p>{t('backfill.scanAsk.time')}</p>
            <p>{t('backfill.scanAsk.safe')}</p>
            <p className="meta">{t('backfill.scanAsk.stoppable')}</p>

            <div className="actions">
              <button className="primary" type="submit">
                {t('backfill.scanAsk.go')}
              </button>
              <Link className="button-link" href={here}>
                {t('backfill.scanAsk.back')}
              </Link>
            </div>
          </form>
        </div>
      )}

      {total > 0 && (
        <>
          {/* A run that takes hours has to keep saying where it has got to and
              what it has brought back. A single line of counts could not: a
              number that has not moved for ten minutes and a run that died look
              exactly alike, and "Queued: 34 · Learned from: 18" is arithmetic
              the reader has to do before it becomes progress. */}
          <div className="scan">
            <div className="head">
              <span className="state">
                {counts.pending ? t('backfill.scanning') : t('backfill.scanDone')}
              </span>
              <span className="meta">{t('backfill.progress', { done, total })}</span>
              {/* What came back, given the same weight as what it cost. Read on
                  its own, a progress bar only ever reports the spending, and
                  the decision this screen supports is whether to let it keep
                  running. */}
              <span className="yield">{t('backfill.yield', { n: rules })}</span>
            </div>

            <div className="bar">
              <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
            </div>

            {/* The breakdown stays. Without it "finished, 0 rules" reads as the
                sentence below — the run working quietly — when it may equally
                be two hundred failures, and those two need to be told apart
                before anybody decides to run it again.
                A count is one unit and must not come apart: Chinese and
                Japanese wrap between any two characters, so "失败: 1" split
                down the middle into a number attached to half a word. */}
            <p className="meta stats breakdown">
              {STATUSES.filter((s) => counts[s]).map((s) => (
                <span key={s} className="stat">
                  {statusLabel(s)}: <strong>{counts[s]}</strong>
                </span>
              ))}
            </p>

            {/* Said out loud, because a stretch with no new rules in it is what
                success looks like here and there is nothing else on the screen
                that would tell you so. */}
            <p className="note">{t('backfill.quieterIsBetter')}</p>

            <div className="actions">
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
