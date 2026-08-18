import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import { getWorkspaceConfig, topicTone } from '@/lib/config/workspace';
import { automation } from '@/lib/desk/automation';
import { deskToday } from '@/lib/desk/today';
import { deskUntouched } from '@/lib/desk/untouched';
import { t, topicName, topicNameMap, type MessageKey } from '@/lib/i18n';
import { shouldOnboard } from '@/lib/setup/state';
import { categories, categoryFilter } from '@/lib/tasks/categories';
import {
  countTasksByStatus,
  countTasksBySource,
  countUnopened,
  listTasks,
} from '@/lib/tasks/store';
import {
  deskedAt,
  deskTitle,
  isTaskStatus,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
} from '@/lib/tasks/types';
import { day, daysAgo, split } from '@/lib/time';

import { bulkDelete, bulkDismiss, bulkReopen, loadDemo, syncNow } from './actions';
import { TaskLink } from './pending';
import { SearchForm } from './search-form';

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
  'sent',
  'failed',
  'all',
  'dismissed',
];

/** Not for us. Reachable by its own tab, and absent from every other. */
const BIN: readonly TaskStatus[] = ['dismissed'];

/**
 * Which of the two kinds of dismissal a row is.
 *
 * The bin holds two things that arrived by very different routes: mail the
 * filter threw out on its own — `junk.ts` writes its reason onto `error` — and
 * mail a person read and put down. Only the first is worth auditing, and it is
 * the smaller half (fourteen against forty on this desk), so a single list
 * sorted by date buries exactly the rows somebody opened this tab to check.
 *
 * The reason is the discriminator rather than a column of its own, because it
 * is the same fact: nothing but the filter writes an `error` on a dismissal,
 * and a filtered row with no reason on it would be a bug worth seeing as one.
 */
function filtered(task: Task): boolean {
  return Boolean(task.error?.trim());
}

/**
 * The machine's turn.
 *
 * These rows appear under the review queue rather than in it. Mixed in, every
 * line makes the reader ask "is this one mine?" before reading it; split off,
 * every line in the group above is theirs. They are still on the screen because
 * "nothing is waiting on me" and "nothing is happening at all" are two very
 * different afternoons, and the tabs alone cannot tell them apart without a
 * click.
 */
const MACHINE: readonly TaskStatus[] = ['pending', 'drafting', 'sending'];

/** Its complement, derived rather than typed out — a status added later belongs
    to one side or the other, and it should not take an edit here to say which. */
const NOT_MACHINE: readonly TaskStatus[] = TASK_STATUSES.filter(s => !MACHINE.includes(s));

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
 * All of it on the desk's clock, like every other date this app renders — one
 * clock for the whole install rather than each reader's own, so two people in
 * two places reading the same queue are reading the same thing. The full
 * timestamp rides along in a `title` for anyone who needs the real number.
 */
function when(iso: string | null): { label: string; full: string } | null {
  if (!iso) return null;
  const parts = split(iso);
  if (!parts) return null;

  const full = `${parts.date} ${parts.time}`;
  const days = daysAgo(iso) ?? 0;

  if (days <= 0) return { label: parts.time, full };
  if (days === 1) return { label: t('inbox.timeYesterday'), full };
  if (days < 7) return { label: t('inbox.timeDaysAgo', { count: days }), full };
  if (parts.date.slice(0, 4) === day(new Date().toISOString()).slice(0, 4)) {
    return { label: parts.date.slice(5), full };
  }
  return { label: parts.date, full };
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

/**
 * What the light says. Its own function because the pill is now written twice
 * — once as a link and once as a label — and a three-branch ternary copied
 * into both is how the two stop agreeing.
 */
function queueLight(state: ReturnType<typeof deskToday>['queue']): MessageKey {
  if (state === 'running') return 'chrome.queueRunning';
  return state === 'stalled' ? 'chrome.queueStalled' : 'chrome.queueIdle';
}

/**
 * Whether a tab has two dates to be read by.
 *
 * "Everything" and "sent" do; the rest are lists of mail nobody has answered
 * yet, where a reply-date order is a list in no order at all under a column of
 * blanks. Answered here rather than inline, because the tab you are standing in
 * and the tab a link opens both have to ask it and they are different tabs.
 */
function canSort(status: string): boolean {
  return status === 'all' || status === 'sent';
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

  // Not what this screen shows — a reviewer sees every task an admin does —
  // but what it is allowed to point at. Two of the pills below open screens
  // that are now admin-only. See the note on each.
  const admin = await isAdmin();

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
  const searchFilter = search ? { search, topicLabels: topicNameMap() } : {};

  // Where the work came from, which is the other half of the question the tabs
  // answer. Carried alongside the status rather than folded into it: "waiting on
  // me" and "is a chargeback" are two facts about the same row, and a single row
  // of tabs can only ever hold one of them.
  //
  // Unlike the status tab, this one *is* carried into a search. A search that
  // ignored it would answer a question nobody asked — you are standing in the
  // chargebacks because chargebacks are what you are working on, and finding a
  // newsletter from March does not help.
  const from = typeof params.from === 'string' ? params.from : 'all';
  const fromFilter = categoryFilter(from);

  // Which clock the list is read by, on the two tabs that hold answered mail.
  //
  // Arrival and reply are the same order right up until the desk falls behind,
  // and then they are the two different questions worth asking: "what came in
  // lately" is the queue, "what went out lately" is what you check before
  // telling somebody their reply is on its way. Elsewhere the choice would be
  // between one date and a column of blanks, so the control does not appear.
  //
  // Neither is priority order. That is a claim about what to do next, and both
  // of these are readings of what already happened.
  const sortable = canSort(requested);
  const sort = sortable && params.sort === 'sent' ? 'sent' : 'received';

  const tasks = listTasks({
    ...fromFilter,
    ...(sortable ? { order: sort === 'sent' ? ('sent' as const) : ('newest' as const) } : {}),
    // A search reaches into the bin; browsing does not. Hiding a dismissed
    // match would mean the search box quietly failing on the mail most likely
    // to be looked up.
    ...(status ? { status } : search ? {} : { excludeStatuses: BIN }),
    ...searchFilter,
    limit: 100,
  });
  // Counted through the same search, so a tab never advertises rows the list
  // below it will not show.
  const counts = countTasksByStatus({ ...fromFilter, ...searchFilter });
  const unopened = countUnopened();
  const LABELS = labels();

  // The source tabs, counted across every status rather than through the one
  // you are standing in — which is the one place these two rows deliberately do
  // not agree, and it is worth the inconsistency.
  //
  // Scoped to the status, the number under Chargebacks would be what is
  // awaiting review this second, which for a chargeback is almost always none:
  // the desk opens it, the model is still drafting it, and the tab reads 0 and
  // disappears for the hour that matters most. This row answers "what kinds of
  // work are on this desk", the row beside it answers "how much of it is at
  // which stage", and only the second is a question about status.
  //
  // The bin is left out unless you are standing in it, exactly as the list
  // leaves it out: a desk with sixty dismissed pitches should not read as a
  // desk with sixty pieces of mail.
  const fromCounts = countTasksBySource({
    ...(status === 'dismissed' ? { status } : { excludeStatuses: BIN }),
    ...searchFilter,
  });
  const sources = categories(fromCounts, getWorkspaceConfig().sourceLabels, from);

  /** Every tab href, so the two rows never drop each other's state. */
  const href = (next: { status?: string; from?: string; sort?: string }) => {
    const query = new URLSearchParams();
    const nextStatus = next.status ?? requested;
    const nextFrom = next.from ?? from;
    // Only when it is not the default, so the ordinary inbox URL stays the
    // short one — and judged against the tab being *opened*, not the one being
    // left. Carried the other way, clicking "awaiting review" from a list read
    // by reply date would put `sort=sent` in the address of a tab that has no
    // reply dates in it, where it would sit invisibly and change what the tab
    // you came from does when you go back to it.
    const nextSort = next.sort ?? (canSort(nextStatus) ? sort : 'received');
    if (nextStatus) query.set('status', nextStatus);
    if (nextFrom && nextFrom !== 'all') query.set('from', nextFrom);
    if (nextSort === 'sent') query.set('sort', nextSort);
    if (search) query.set('q', search);
    return `/?${query.toString()}`;
  };

  // The bin, split by who did the dismissing. Everywhere else one list is
  // right; here the two halves answer different questions and the one being
  // asked is almost always "what did the filter eat".
  const bin = status === 'dismissed';
  const groups = groupBySender(bin ? tasks.filter(t => !filtered(t)) : tasks);
  const filteredGroups = bin ? groupBySender(tasks.filter(filtered)) : [];
  // Read here rather than in the root layout, which is where it used to live.
  //
  // Two things were wrong with that and they pull in opposite directions. It
  // was four counts and a queue read on every render of every screen, for a
  // group the header only ever shows on this one — and it was *frozen*, because
  // a root layout does not re-render when you navigate: send five replies and
  // the header still reported the count from when the tab was opened, and the
  // light that exists to catch a dead crontab could not change state without a
  // reload. Read by the screen that shows it, both stop being true.
  const today = deskToday();

  // The machine's rows, under their own heading, and only on the tab where the
  // distinction is the point. On `sent` or `all` nobody is reading for whose
  // turn it is, so the extra heading would be a line that separates nothing.
  // Not while searching either: a search is looking for one email, and the
  // answer should not be filed under a subheading.
  const machineGroups =
    requested === 'awaiting_review' && !search
      ? groupBySender(listTasks({ ...fromFilter, excludeStatuses: NOT_MACHINE, limit: 100 }))
      : [];

  // Whether this desk has ever had anything on it, which is a different
  // question from whether the tab in front of you is empty — and the only one
  // that decides whether the sample-data button is worth showing. Asked only
  // once the list has already come back empty, because that is the only time
  // the answer is used and it is two more queries.
  const untouched = tasks.length === 0 && !search && deskUntouched();

  // Whether anything outside this app is calling its four endpoints.
  //
  // The light beside this one reports the worker and cannot report the sync:
  // it watches the jobs table, and mail that was never fetched enqueues
  // nothing, so a desk with a dead crontab and a desk with a quiet morning both
  // read "idle". This is the half that says which — and it is a pointer to the
  // page that explains it rather than a state of the light, because the answer
  // is never "look at the queue", it is always "go and set up a scheduler".
  //
  // Not while the desk is untouched: somebody who has not finished the wizard
  // is being asked to fix something they have not been offered yet.
  const unscheduled = !untouched && automation().silent;

  // A badge on every row is a badge on no row. Where the tab pins the status —
  // which is every tab but "everything" — the badge repeats the tab heading
  // once per line, so it only survives on the lists that genuinely mix.
  const mixed = status === null;

  /**
   * One card per sender, one row per email.
   *
   * A function rather than an inlined `.map` because the machine's rows below
   * are drawn by the same one. Two copies of a six-column grid is how the two
   * halves of this screen drift apart — the day one of them gains a column, the
   * other quietly does not.
   *
   * `machine` is the only difference between them, and it changes two things:
   * the status is written as a word beside the subject instead of worn as a
   * badge (there are three of those statuses, so it is a fact rather than a
   * repeat of the heading), and there is no analysis to show, because nothing
   * has read the email yet.
   */
  const renderGroups = (list: SenderGroup[], machine = false) =>
    list.map((group) => (
      <div className="sender-group" key={group.address}>
        <ul>
          {group.tasks.map((task, index) => {
            // `deskedAt`, so a composed mail is not the one row in the queue
            // with an empty time column — see the helper.
            //
            // Under the reply order the column shows the reply's date instead,
            // because a list sorted by one date and stamped with another reads
            // as a list that is not sorted at all. Unsent rows keep their
            // arrival date: they sit in their own block at the bottom, and a
            // blank there says "no date" rather than "not sent yet".
            const time = when(sort === 'sent' ? (task.sentAt ?? deskedAt(task)) : deskedAt(task));
            const unread = task.status === 'awaiting_review' && !task.openedAt;
            // Worth interrupting for. The whole row changes ground and takes a
            // rule down its left edge, because a pill the size of every other
            // pill is not findable in forty rows — which is what "the risk
            // signal is too weak" meant.
            const care = task.risk?.level === 'high';
            return (
              <li key={task.id} className={`inbox-row${care ? ' care' : ''}`}>
                <input
                  type="checkbox"
                  name="taskId"
                  value={task.id}
                  aria-label={deskTitle(task) || t('inbox.noSubject')}
                />
                {/* Named once. The rows under it are the same person, and
                    repeating the address four times is four chances to misread
                    it as four people.

                    The unopened dot leads the row rather than the subject:
                    it is the first thing the eye crosses on the way in, and at
                    the front of the line it reads as "this one" instead of as
                    punctuation in the middle of a sentence. Per row, not per
                    sender — it says something about this email.

                    `aria-hidden`, so the fact was carried entirely in seven
                    accent-coloured pixels and reached a screen reader not at
                    all. The word rides along beside it. */}
                <span className="sender" title={group.address}>
                  {unread && (
                    <>
                      <span className="dot" aria-hidden="true" />
                      <span className="visually-hidden">{t('inbox.unreadOne')}</span>
                    </>
                  )}
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
                {/* The whole cell is the link, both lines of it: a target the
                    width of the row beats a target the width of a subject line,
                    and there is no client JS here to make the rest of the row
                    clickable. */}
                {/* Not a plain `Link`: a review screen is a dynamic route, so
                    nothing about it is fetched until it is clicked unless
                    something asks. This asks when the pointer arrives — a
                    hundred rows is too many to fetch on sight, and the second
                    between noticing a row and clicking it is long enough to
                    render one. It also draws the bar that says the click
                    landed, for the times the fetch has not finished. See
                    `TaskLink`. */}
                <TaskLink className={`subject ${unread ? '' : 'read'}`} href={`/tasks/${task.id}`}>
                  <span className="line">
                    {deskTitle(task) || t('inbox.noSubject')}
                    {/* Which of the machine's three it is, as a word. A badge
                        would put a third pill on a row whose whole point is
                        that it is not asking anything of you. */}
                    {machine && (
                      <span className="row-status">{LABELS[task.status] ?? task.status}</span>
                    )}
                  </span>
                  {/* Why the filter threw it out, on the row, rather than one
                      click inside each of fifty. Auditing the bin means asking
                      "would I have answered that" fifty times, and the reason
                      is what answers it — "carries a List-Unsubscribe header"
                      settles a newsletter at a glance, and anything that does
                      not settle at a glance is exactly the row worth opening.
                      Only on a dismissal: `error` is also where a failed send
                      writes its stack, and that belongs on the task, not in a
                      list. */}
                  {!machine && task.status === 'dismissed' && task.error ? (
                    <span className="snippet">{task.error}</span>
                  ) : (
                    !machine && task.analysis?.intent && (
                      <span className="snippet">{task.analysis.intent}</span>
                    )
                  )}
                  {/* The reasons, not a badge. A badge has to be remembered to
                      mean anything; a sentence does not, and `task.risk.factors`
                      was already in the data — it just never reached a screen at
                      a size worth reading. */}
                  {care && (
                    <span className="care-why">
                      {[
                        t('task.risk.high'),
                        ...(task.risk?.factors ?? []).map(f => t(`task.riskFactor.${f}`)),
                      ].join(' · ')}
                    </span>
                  )}
                </TaskLink>
                <span className="topic-cell">
                  {task.scope && (
                    // The slug stays on the title: it is what the rules page and
                    // the DB call this, so anybody debugging a rule that did not
                    // fire needs it reachable.
                    // The tone is a class and not a `style`: the colour has to
                    // come from the palette so it follows the theme, and one
                    // written into the markup cannot. See `topicTone`.
                    <span className={`tag topic tone-${topicTone(task.scope)}`} title={task.scope}>
                      {topicName(task.scope)}
                    </span>
                  )}
                </span>
                {/* Only where the list actually mixes. Every row under a tab
                    that names one status wears that status, so the badge was
                    the tab heading repeated forty times — and a queue where
                    every row carries a badge is a queue with no badges. The
                    risk pill went for the same reason one step earlier: the row
                    it sat on is already coloured and already says why. */}
                {mixed && (
                  <span className="tags">
                    <span className={`tag ${task.status}`}>
                      {LABELS[task.status] ?? task.status}
                    </span>
                  </span>
                )}
                <span className="at" {...(time ? { title: time.full } : {})}>
                  {time?.label ?? ''}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    ));

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
      {/* Named, but not shown. Every screen has to open its outline with an
          `h1` — it is what a screen reader's "jump to the heading" lands on, and
          without one the first heading here is a card's "TO REVIEW". Hidden
          rather than drawn, because the header already says where you are: the
          nav marks the active link, and a second "Inbox" in 30px type above the
          search box would be the app telling somebody something they can see. */}
      <h1 className="visually-hidden">{t('nav.inbox')}</h1>

      {/* What the desk has already done, whether anything is moving, and the two
          things you can hand it.

          On this screen because this is the screen it is about — the header
          carried it, gated to the inbox by a client component, and paid for it
          on every other screen in queries that were then thrown away. Above the
          search box rather than on its row: the toolbar gave these buttons up
          once already so the search field could have the width back, and taking
          it again would undo that.

          The numbers are the only place the work that is already done is
          visible at all. The queue only ever shows what is left, which by design
          never looks finished, so a reviewer thirty replies into an afternoon
          has nothing on screen saying so. */}
      <div className="row desk-row">
        <div className="desk-state">
          <p className="desk-today">
            {t('chrome.todaySent', { n: today.sent })}
            {' · '}
            {t('chrome.todayLearned', { n: today.learned })}
          </p>

          {/* Whether the worker is alive — not whether the queue has anything in
              it, which is the question this used to ask and which lit up green
              precisely when the desk was broken. The middle state is the one it
              exists for: work waiting, nothing moving. See `deskToday`. */}
          {/* A link for whoever can act on it and a label for everybody else.
              What it says is worth saying either way — a reviewer waiting on a
              draft has a right to know the desk has stalled — but the screen it
              opens is one of the four an admin keeps, and a pill that bounces
              you back to the page you clicked it from is worse than a pill that
              never offered. */}
          {admin ? (
            <Link className={`queue-light ${today.queue}`} href="/queue">
              <span className="dot" aria-hidden="true" />
              {t(queueLight(today.queue))}
            </Link>
          ) : (
            <span className={`queue-light ${today.queue}`}>
              <span className="dot" aria-hidden="true" />
              {t(queueLight(today.queue))}
            </span>
          )}

          {/* Beside the light rather than instead of it. The two say different
              things — one is about the queue this minute, the other about
              whether anything will ever put work in it — and a desk with a
              scheduler never sees this at all. */}
          {/* Admins only, and this one is hidden rather than defanged: it is
              not a report on the desk, it is a job to do — set a scheduler up —
              and telling somebody who cannot open the settings that the
              settings are wrong is a daily reminder with no button on it. */}
          {unscheduled && admin && (
            <Link className="queue-light unscheduled" href="/setup?where=running">
              <span className="dot" aria-hidden="true" />
              {t('settings.running.nudge')}
            </Link>
          )}
        </div>

        {/* The two things you can do to the desk rather than to a screen: start
            a letter of your own, or pull in the ones that arrived. Next to the
            light that reports what the desk is doing with either.

            Writing came out of the header, where it was the one nav link that
            was an action rather than a place — offered on every screen of the
            app by a row that has no idea what you are in the middle of. Here it
            is one entry point, on the screen where mail is the subject.

            Run queue used to stand where Compose does. It was a button for a
            thing that already happens: the worker runs on a schedule, and the
            light to the left of these says whether it is. What it was really
            for — a stuck queue you want to shove — belongs on `/queue`, which
            has the same button and is one click away through that light. */}
        <div className="desk-actions">
          {/* A glyph, and the word next to it rather than instead of it. The
              icon is what a hand finds in a row of same-sized pills; the word is
              what tells you which one this is, and what a screen reader gets —
              the mark is `aria-hidden`, like the unopened dot on a row.

              U+FE0E after the pencil, or a platform with an emoji font for it
              draws a full-colour cartoon in a row of monochrome type. */}
          <Link className="compose" href="/compose">
            <span className="mark" aria-hidden="true">
              &#9998;&#65038;
            </span>
            {t('inbox.compose')}
          </Link>
          <form action={syncNow}>
            <button type="submit">{t('inbox.fetchMail')}</button>
          </form>
        </div>
      </div>

      {/* Search and the tabs on one line, reading left to right in the order the
          filtering happens: the box reaches everything, the tabs narrow what it
          found. They wrap rather than squeeze — a tab is one word and a number
          and must never be two lines — so on a narrow column or a long-worded
          language the row becomes two rows and nothing is crushed.

          A plain GET form, so a search is a URL: shareable, bookmarkable, and it
          survives the back button. No action, no client state, and the box keeps
          the query in it so you can edit rather than retype.

          The tab is deliberately not carried. Searching means searching
          everything, always, and narrowing afterwards — one rule, rather than a
          box whose reach depends on where you were standing.

          The strings are passed in rather than looked up inside: `t()` reads the
          workspace config off disk, which is a server-only thing to do, and this
          is the one component that runs in the browser. */}
      <div className="row toolbar">
        <SearchForm
          defaultValue={search}
          placeholder={t('inbox.searchPlaceholder')}
          submitLabel={t('inbox.search')}
        />

        {/* The filters carry the counts, so there is no separate line of
            statistics to keep in sync with them. A tab that says how much is
            behind it is the same fact in one place instead of two. */}
        <div className="filters">
          {FILTERS.map((f) => {
            const n = f === 'all' ? allCount : (counts[f as TaskStatus] ?? 0);
            return (
              <Link key={f} href={href({ status: f })} className={requested === f ? 'active' : ''}>
                {LABELS[f] ?? f}
                {n > 0 && <span className="n">{n}</span>}
                {/* Only against awaiting_review, and only when it is not the
                    whole number: "12, all new" is one fact, not two. */}
                {f === 'awaiting_review' && unopened > 0 && unopened < n && (
                  <span className="n unread-count">{t('inbox.unread', { count: unopened })}</span>
                )}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Where it came from, on its own line above the queue.

          Only once something other than mail has arrived. On a desk that takes
          nothing but email — which is most desks, most weeks — this row would be
          two tabs that always say the same thing and always add up to the row
          below, so it stays out of the way until there is a second kind of work
          to tell apart. See `categories`. */}
      {sources.length > 2 && (
        <div className="filters sources">
          {sources.map((category) => (
            <Link
              key={category.key}
              href={href({ from: category.key })}
              className={from === category.key ? 'active' : ''}
            >
              {category.label}
              {category.count > 0 && <span className="n">{category.count}</span>}
            </Link>
          ))}
        </div>
      )}

      {/* Which clock, on its own line under the tabs it applies to.

          Two links rather than a select, for the same reason the tabs are
          links: each one is a URL somebody can keep, and the pair is small
          enough that a control which hides one of its two options behind a
          click would be the more expensive of the two. */}
      {sortable && tasks.length > 0 && (
        <div className="filters sorts">
          <Link
            href={href({ sort: 'received' })}
            className={sort === 'received' ? 'active' : ''}
          >
            {t('inbox.sortReceived')}
          </Link>
          <Link href={href({ sort: 'sent' })} className={sort === 'sent' ? 'active' : ''}>
            {t('inbox.sortSent')}
          </Link>
        </div>
      )}

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
          <Link href="/">{t('inbox.searchClear')}</Link>
        </p>
      )}

      {tasks.length === 0 && (
        <div className="card">
          <div className="empty">
            {search ? (
              <>
                {/* A missed search is not an empty inbox, and must not be
                    answered by offering to invent sample data. */}
                <p>{t('inbox.searchNoResults', { query: search })}</p>
                <p>
                  <Link href="/">{t('inbox.searchClear')}</Link>
                </p>
              </>
            ) : untouched ? (
              <>
                <p>{t('inbox.emptyTitle')}</p>
                {/* Only on a database with nothing in it at all — see
                    `deskUntouched`. `seedDemoData` refuses on a desk that has
                    been used, so on any other empty screen this button was a
                    button that did nothing: it posted, the seed declined, and
                    the redirect landed back on the same empty tab with no
                    message. Offered where it works, and nowhere else. */}
                <form action={loadDemo}>
                  <button type="submit">{t('inbox.loadSampleData')}</button>
                </form>
              </>
            ) : (
              <>
                {/* An empty tab on a desk that has mail on it. Which is a fact
                    about the filter, not about the desk — and the answer to it
                    is the tab that holds everything, not a fictional inbox. */}
                <p>{t('inbox.emptyFilter', { tab: LABELS[status ?? 'all'] })}</p>
                {status !== null && (
                  <p>
                    <Link href={href({ status: 'all' })}>{t('inbox.emptyFilterAll')}</Link>
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Beside the empty state rather than instead of it, which is the whole
          reason this is a second condition and not the other half of a ternary.
          The machine's rows were rendered inside `tasks.length > 0`, so the one
          screen they were written for could never show them: a desk that has
          just synced twelve emails has nothing under Awaiting review and twelve
          rows being drafted, and what it printed was "Nothing under Awaiting
          review" and no sign that anything was happening. That is exactly the
          "nothing is waiting on me" against "nothing is happening at all"
          distinction the group below exists to make. */}
      {(tasks.length > 0 || machineGroups.length > 0) && (
        // One form around every group. The checkboxes share a name, so the post
        // carries every ticked id and nothing else — no client state, and no way
        // for the screen and the request to disagree.
        //
        // The flag goes on the form rather than on each row because the column
        // has to be there or not there for the whole list: a grid whose track
        // count changes row by row is six columns that no longer line up, which
        // is the one thing the fixed widths exist to prevent.
        <form className={`list-form${mixed ? '' : ' no-status'}`}>
          {/* The bin reads as two lists, the filter's and the desk's, with the
              filter's first — somebody who opens this tab is nearly always
              checking what got thrown out on its own, and the rows a colleague
              put down deliberately are not what they came for. Headings on
              both, because an unlabelled list above a labelled one reads as
              part of it. */}
          {bin && filteredGroups.length > 0 && (
            <div className="bin-side">
              <h2>{t('inbox.binFiltered')}</h2>
              {renderGroups(filteredGroups)}
            </div>
          )}

          {bin && groups.length > 0 ? (
            <div className="bin-side">
              <h2>{t('inbox.binByHand')}</h2>
              {renderGroups(groups)}
            </div>
          ) : (
            !bin && renderGroups(groups)
          )}

          {/* The rows the model still has, under their own heading and a notch
              quieter. Kept on the screen because "nothing is waiting on me" and
              "nothing is happening at all" are two very different afternoons —
              and outside the group above, because the value of that group is
              that every line in it is yours.

              The heading says "AI Processing" while everything around it in the
              code says machine: `MACHINE`, `machineGroups`, `.machine-side`.
              That is on purpose and not drift. Internally the question is "whose
              turn is it", which is what splits the list; on screen the answer
              has to name the thing doing the work, because a reviewer reading
              "with the machine" has to translate it before it means anything and
              "AI" is the word the tagline already uses.

              Inside the same form. One list of ticked ids goes out either way;
              a second form here would be a second post that the bulk bar at the
              bottom could not reach. */}
          {machineGroups.length > 0 && (
            <div className="machine-side">
              <h2>{t('inbox.machineSide')}</h2>
              {renderGroups(machineGroups, true)}
            </div>
          )}

          {/* Under the list rather than above it, and carrying no count: it is a
              footer to what you have been reading, not a toolbar you have to get
              past to read anything.

              There was a sentence along this row explaining that ticking boxes
              lets you act on several at once, and that approving is never one of
              them. Both halves were being told to somebody looking at a column
              of checkboxes and three buttons named after what they do — the
              first half is what a checkbox is, and the second is a promise the
              row keeps by not having the button. A caption that describes the
              controls beside it is a caption the controls did not need. */}
          <div className="row bulk">
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
