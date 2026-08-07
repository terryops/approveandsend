import { redirect } from 'next/navigation';

import { requirePage } from '@/lib/auth/guard';
import { topicLabel, topicLabelMap } from '@/lib/config/workspace';
import { t } from '@/lib/i18n';
import { shouldOnboard } from '@/lib/setup/state';
import { countTasksByStatus, countUnopened, listTasks } from '@/lib/tasks/store';
import { isTaskStatus, type Task, type TaskStatus } from '@/lib/tasks/types';

import {
  bulkDelete,
  bulkDismiss,
  bulkReopen,
  loadDemo,
  logout,
  runQueue,
  syncNow,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * The tabs, in the order a queue is worked.
 *
 * `dismissed` is last and `all` does not contain it, which is the whole reason
 * it is a tab at all. A public support address gets more pitches than support —
 * on this desk, fifteen auto-dismissed against twenty-three to review — so a
 * list of "everything" that includes them is a list where most rows are a
 * backlink salesman, and a reviewer scrolling past forty of those to find the
 * refund is a reviewer who stops scrolling. So the bin is one click away and
 * nowhere else: nothing is hidden, and nothing that was never for us sits in
 * front of something that was.
 */
const FILTERS: (TaskStatus | 'all')[] = [
  'awaiting_review',
  'pending',
  'failed',
  'sent',
  'all',
  'dismissed',
];

/** Not for us. Reachable by its own tab, and absent from every other. */
const BIN: readonly TaskStatus[] = ['dismissed'];

// Built per request rather than at module scope: the locale is resolved from
// the workspace config, which is not readable while this module is evaluated.
function labels(): Record<TaskStatus | 'all', string> {
  return {
    awaiting_review: t('inbox.statusAwaitingReview'),
    pending: t('inbox.statusPending'),
    drafting: t('inbox.statusDrafting'),
    sending: t('inbox.statusSending'),
    failed: t('inbox.statusFailed'),
    sent: t('inbox.statusSent'),
    dismissed: t('inbox.statusDismissed'),
    all: t('inbox.statusAll'),
  };
}

/**
 * A timestamp at the size it deserves.
 *
 * Today's mail is read by the hour it arrived; last month's is read by the
 * day, and the hour is noise. So the column is one of four widths and never
 * wider, which is what lets it sit at the end of every row without pushing the
 * subject around.
 *
 * All of it in UTC, like every other date this app renders. Not a compromise
 * to dodge a hydration warning — there is no client to hydrate — but the same
 * choice the rest of the app makes: one clock, the server's, so two people in
 * two places reading the same queue are reading the same thing. The full
 * timestamp rides along in a `title` for anyone who needs the real number.
 */
function when(iso: string | null): { label: string; full: string } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const full = date.toISOString().slice(0, 16).replace('T', ' ');
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const now = new Date();
  const days = Math.round((day(now) - day(date)) / 86_400_000);

  if (days <= 0) return { label: full.slice(11), full };
  if (days === 1) return { label: t('inbox.timeYesterday'), full };
  if (days < 7) return { label: t('inbox.timeDaysAgo', { count: days }), full };
  if (date.getUTCFullYear() === now.getUTCFullYear()) return { label: full.slice(5, 10), full };
  return { label: full.slice(0, 10), full };
}

/**
 * Everything one address has waiting, read as one thing.
 *
 * A queue sorted by arrival scatters a person across it: somebody who wrote
 * three times about the same broken export is three rows that each look like a
 * separate problem, and answering the first without seeing the other two is
 * how a customer gets three replies that contradict each other. Grouped, that
 * is one card with three lines and one decision.
 *
 * Order comes from wherever the sender's *first* row sat, so the queue still
 * reads newest-first: a group is pulled together upward, never pushed down.
 * Merging on the address rather than the display name, because "Harry WY" and
 * "Harry Wang" are one person with two mail clients.
 */
interface SenderGroup {
  address: string;
  /** The friendliest name seen on any of them. Never empty. */
  name: string;
  /** Whether `name` came from a display name or was derived from the address. */
  named: boolean;
  tasks: Task[];
}

/**
 * Something 156 pixels can hold.
 *
 * Mail without a display name used to fill the column with the front of an
 * address and an ellipsis — `kambojsmile389@gm…`, `launchranking@f…` — where
 * the truncated half is the domain, which is the half that tells you who it is.
 * The local part alone fits, and it is what a person calls that sender anyway.
 * The address in full stays on the `title`.
 */
function senderName(task: Task): string {
  const given = task.fromName?.trim();
  if (given) return given;
  const local = task.fromAddress.split('@')[0]?.trim();
  return local || task.fromAddress;
}

function groupBySender(tasks: Task[]): SenderGroup[] {
  const groups = new Map<string, SenderGroup>();

  for (const task of tasks) {
    const address = task.fromAddress.trim().toLowerCase();
    const existing = groups.get(address);
    if (existing) {
      existing.tasks.push(task);
      // A later message with a display name names the whole group, since the
      // first one only had an address to go on.
      if (!existing.named && task.fromName?.trim()) {
        existing.name = task.fromName.trim();
        existing.named = true;
      }
      continue;
    }
    groups.set(address, {
      address,
      name: senderName(task),
      named: Boolean(task.fromName?.trim()),
      tasks: [task],
    });
  }

  return [...groups.values()];
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
  const search = typeof params.q === 'string' ? params.q.trim() : '';

  // Searching starts from "all" rather than from the queue, and that is the
  // one deliberate inconsistency here. Somebody searches because they remember
  // an email, not because they remember its status — a search that runs inside
  // the tab you happen to be standing in cannot find the pitch you dismissed
  // last week, which is most of what anybody searches for. Clicking a tab
  // while a query is live still narrows it; the tabs just stop being where the
  // search begins.
  const fallback = search ? 'all' : 'awaiting_review';
  const requested = typeof params.status === 'string' ? params.status : fallback;
  const status = isTaskStatus(requested) ? requested : null;

  // So that typing the tag you can see finds the rows wearing it.
  const searchFilter = search ? { search, topicLabels: topicLabelMap() } : {};

  const tasks = listTasks({
    // A search reaches into the bin; browsing does not. Hiding a dismissed
    // match would mean the search box quietly failing on the mail most likely
    // to be looked up.
    ...(status ? { status } : search ? {} : { excludeStatuses: BIN }),
    ...searchFilter,
    limit: 100,
  });
  // Counted through the same search, so a tab never advertises rows the list
  // below it will not show.
  const counts = countTasksByStatus(searchFilter);
  const unopened = countUnopened();
  const LABELS = labels();
  const groups = groupBySender(tasks);

  // What "all" is a count of, so the tab and the list it opens agree.
  const total = Object.entries(counts).reduce(
    (sum, [key, n]) => (BIN.includes(key as TaskStatus) ? sum : sum + (n ?? 0)),
    0,
  );
  // Except while searching, where "all" really is all of it: the bin is not
  // excluded from a search, so excluding it from the number would understate
  // the result you are looking at.
  const allCount = search
    ? Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)
    : total;

  const notice =
    typeof params.error === 'string'
      ? { kind: 'error', text: params.error }
      : typeof params.sent === 'string'
        ? { kind: 'ok', text: t('inbox.sentLearningQueued') }
        : typeof params.synced === 'string'
          ? { kind: 'ok', text: t('inbox.synced', { count: params.synced }) }
          : typeof params.bulk === 'string'
            ? { kind: 'ok', text: t('inbox.bulkDone', { count: params.bulk }) }
            : typeof params.deleted === 'string'
              ? { kind: 'ok', text: t('inbox.bulkDeleted', { count: params.deleted }) }
              : typeof params.demo === 'string'
                ? {
                    kind: 'ok',
                    text: t('inbox.demoLoaded', { count: params.demo }),
                  }
                : null;

  return (
    <div className="inbox">
      {/* Its own line, above the tabs, and that is a statement about scope: the
          box searches everything and the tabs narrow what it found, so it reads
          top to bottom in the order the filtering happens. It also simply does
          not fit — six tabs, a search field and three buttons come to more than
          this column is wide, and cramming them left one tab dangling on a
          second line.

          A plain GET form, so a search is a URL: shareable, bookmarkable, and it
          survives the back button. No action, no client state, and the box keeps
          the query in it so you can edit rather than retype. */}
      <form className="row searchbar" method="get" action="/">
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder={t('inbox.searchPlaceholder')}
          aria-label={t('inbox.searchPlaceholder')}
        />
        {/* The tab is deliberately not carried. Searching means searching
            everything, always, and narrowing afterwards — one rule, rather than
            a box whose reach depends on where you were standing. */}
        <button type="submit">{t('inbox.search')}</button>
      </form>

      {/* The filters carry the counts, so there is no separate line of statistics
          to keep in sync with them. A tab that says how much is behind it is the
          same fact in one place instead of two. */}
      <div className="row toolbar">
        <div className="filters grow">
          {FILTERS.map((f) => {
            const n = f === 'all' ? allCount : (counts[f as TaskStatus] ?? 0);
            const href = search ? `/?status=${f}&q=${encodeURIComponent(search)}` : `/?status=${f}`;
            return (
              <a key={f} href={href} className={requested === f ? 'active' : ''}>
                {LABELS[f] ?? f}
                {n > 0 && <span className="n">{n}</span>}
                {/* Only against awaiting_review, and only when it is not the
                    whole number: "12, all new" is one fact, not two. */}
                {f === 'awaiting_review' && unopened > 0 && unopened < n && (
                  <span className="n unread-count">{t('inbox.unread', { count: unopened })}</span>
                )}
              </a>
            );
          })}
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

      {/* Only with results: the empty state says it better, and saying it twice
          on one screen reads as two different failures. */}
      {search && tasks.length > 0 && (
        <p className="meta search-note">
          {t('inbox.searchResults', { count: tasks.length, query: search })}{' '}
          <a href="/">{t('inbox.searchClear')}</a>
        </p>
      )}

      {tasks.length === 0 ? (
        <div className="card">
          <div className="empty">
            {search ? (
              <>
                {/* A missed search is not an empty inbox, and must not be
                    answered by offering to invent sample data. */}
                <p>{t('inbox.searchNoResults', { query: search })}</p>
                <p>
                  <a href="/">{t('inbox.searchClear')}</a>
                </p>
              </>
            ) : (
              <>
                <p>{t('inbox.emptyTitle')}</p>
                {/* Only offered on a genuinely empty database — see seedDemoData. */}
                <form action={loadDemo}>
                  <button type="submit">{t('inbox.loadSampleData')}</button>
                </form>
              </>
            )}
          </div>
        </div>
      ) : (
        // One form around every group. The checkboxes share a name, so the post
        // carries every ticked id and nothing else — no client state, and no way
        // for the screen and the request to disagree.
        <form className="list-form">
          {groups.map((group) => (
            <div className="sender-group" key={group.address}>
              <ul>
                {group.tasks.map((task, index) => {
                  const time = when(task.receivedAt);
                  const unread = task.status === 'awaiting_review' && !task.openedAt;
                  return (
                    <li key={task.id} className="inbox-row">
                      <input
                        type="checkbox"
                        name="taskId"
                        value={task.id}
                        aria-label={task.subject || t('inbox.noSubject')}
                      />
                      {/* Named once. The rows under it are the same person, and
                          repeating the address four times is four chances to
                          misread it as four people. */}
                      <span className="sender" title={group.address}>
                        {index === 0 ? (
                          group.name
                        ) : (
                          <span
                            className="continuation"
                            title={t('inbox.alsoFrom', { name: group.name })}
                          >
                            &#9492;
                          </span>
                        )}
                      </span>
                      {/* The whole cell is the link, both lines of it: a target
                          the width of the row beats a target the width of a
                          subject line, and there is no client JS here to make
                          the rest of the row clickable. */}
                      <a className={`subject ${unread ? '' : 'read'}`} href={`/tasks/${task.id}`}>
                        <span className="line">
                          {/* Only where it means something. Every pending task is
                              unread by definition, and a dot on all of them is a
                              dot that tells you nothing. */}
                          {unread && (
                            <span className="dot" title={t('inbox.unreadOne')} aria-hidden="true" />
                          )}
                          {task.subject || t('inbox.noSubject')}
                        </span>
                        {task.analysis?.intent && (
                          <span className="snippet">{task.analysis.intent}</span>
                        )}
                      </a>
                      <span className="topic-cell">
                        {task.scope && (
                          // The slug stays on the title: it is what the rules
                          // page and the DB call this, so anybody debugging a
                          // rule that did not fire needs it reachable.
                          <span className="tag topic" title={task.scope}>
                            {topicLabel(task.scope)}
                          </span>
                        )}
                      </span>
                      <span className="tags">
                        {/* Only when it is worth interrupting for. A queue where
                            every row wears a badge is a queue with no badges. */}
                        {task.risk?.level === 'high' && (
                          <span className="tag risk-high">{t('task.risk.high')}</span>
                        )}
                        <span className={`tag ${task.status}`}>
                          {LABELS[task.status] ?? task.status}
                        </span>
                      </span>
                      <span className="at" {...(time ? { title: time.full } : {})}>
                        {time?.label ?? ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {/* Under the list rather than above it, and carrying no count: it is a
              footer to what you have been reading, not a toolbar you have to get
              past to read anything. */}
          <div className="row bulk">
            <span className="meta grow">{t('inbox.bulkHint')}</span>
            <button type="submit" formAction={bulkDismiss}>
              {t('inbox.bulkDismiss')}
            </button>
            <button type="submit" formAction={bulkReopen}>
              {t('inbox.bulkReopen')}
            </button>
            {/* Last, and the only one that is not reversible: deleting drops the
                note that this message was ever seen, so the next sync ingests it
                again and drafts it again. */}
            <button className="danger" type="submit" formAction={bulkDelete}>
              {t('inbox.bulkDelete')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
