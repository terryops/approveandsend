/**
 * The queue, kept on the screen — which is the reason columns mode has three of
 * them.
 *
 * Opening an email currently makes the inbox disappear, so going back is a
 * navigation, and going back is the thing this job does forty times a day. With
 * the queue in place, finishing one reply means clicking the next; `/` is for
 * starting and stopping.
 *
 * Columns only. The main column in side-by-side is already two columns of its
 * own, and hanging a rail off that makes three — which is the thing side by side
 * exists to get away from.
 *
 * A server component with no client state: every row is a `<Link>`, the same as
 * the inbox. `J` and `K` walk the same links from the keyboard, and they are an
 * enhancement over this rather than a replacement for it.
 */

import Link from 'next/link';

import { TaskLink } from '../../pending';
import { t } from '@/lib/i18n';
import { countTasksByStatus, listTasks } from '@/lib/tasks/store';
import type { Task } from '@/lib/tasks/types';

/**
 * How long is long enough.
 *
 * Twelve. Not "as many as fit" — a rail nobody can finish reading is the inbox
 * squeezed into a sidebar, and there is already an inbox, with search and paging
 * and bulk actions. The only question this has to answer is "what is next, and
 * is it worth jumping to now".
 */
export const RAIL_SHOWN = 12;

/** No display name, so the part before the @ — same rule as the inbox, same reason. */
function shortName(task: Task): string {
  const given = task.fromName?.trim();
  if (given) return given;
  return task.fromAddress.split('@')[0]?.trim() || task.fromAddress;
}

/**
 * The rows the rail walks, in the order it shows them.
 *
 * Exported because `J` and `K` have to agree with the list on screen about what
 * "next" means, and the page needs the neighbours of the current task to hand
 * them to the keyboard layer. One query, read twice.
 */
export function railTasks(): Task[] {
  return listTasks({ status: 'awaiting_review', limit: RAIL_SHOWN });
}

export function QueueRail({ currentId, rows }: { currentId: string; rows: Task[] }) {
  const counts = countTasksByStatus();
  const waiting = counts['awaiting_review'] ?? 0;
  const more = Math.max(0, waiting - rows.length);

  // Nothing waiting on anybody. A rail reading "0 to review" is 236px held open
  // for something that is not happening.
  //
  // Only `awaiting_review` is ever in here. Pending and drafting are the
  // machine's turn, and there is nothing to do with a task that is still being
  // written — they have a place in the inbox, which is where "is the desk
  // working" gets asked, and none in a column whose whole question is "what is
  // next". The header's queue light is what says the machine is running.
  if (rows.length === 0) return null;

  return (
    <nav className="queue-rail" aria-label={t('task.rail.label')}>
      <p className="rail-head">
        <span>{t('task.rail.waiting', { n: waiting })}</span>
        {/* Said out loud, because a shortcut nobody is told about is a shortcut
            nobody uses. It is also the honest place for it: the keys walk this
            list, so the hint belongs at the top of it. */}
        <span className="rail-keys">
          <kbd>J</kbd>
          <kbd>K</kbd>
          {t('task.rail.keysHint')}
        </span>
      </p>

      <ul>
        {rows.map(task => {
          const here = task.id === currentId;
          const care = task.risk?.level === 'high';
          return (
            <li key={task.id} className={here ? 'here' : ''}>
              {/* `eager`, which the inbox rows deliberately are not. There are
                  twelve of these against a hundred there, they are the same
                  twelve on every task so they are fetched once and reused all
                  afternoon, and `J` and `K` walk them from the keyboard — where
                  there is no pointer to wait for. See `TaskLink`. */}
              <TaskLink href={`/tasks/${task.id}`} current={here} eager>
                {/* Only when there is something to say. No clock: this column
                    answers "what is next", and the hour a mail landed is not
                    part of that — the order already carries it, and the task
                    itself gives the date in full. A strip standing empty above
                    every subject was the whole cost of showing it. */}
                {(care || !task.openedAt) && (
                  <span className="rail-top">
                    {care && <span className="tag risk-high">{t('task.risk.high')}</span>}
                    {/* Said in words as well as marked with a dot. A dot alone
                        is a convention you have to already know; the rail is
                        narrow but not so narrow that two words do not fit. */}
                    {!care && !task.openedAt && (
                      <span className="rail-new">
                        <span className="dot" aria-hidden="true" />
                        {t('task.rail.unopened')}
                      </span>
                    )}
                  </span>
                )}
                <span className="rail-subject">{task.subject || t('task.noSubject')}</span>
                <span className="rail-who">
                  {shortName(task)}
                  {task.analysis?.intent ? ` · ${task.analysis.intent}` : ''}
                </span>
              </TaskLink>
            </li>
          );
        })}
      </ul>

      {/* The rest are not paged through here. Paging is the inbox's job, and it
          has the search and the filters and the checkboxes to do it. */}
      {more > 0 && (
        <p className="rail-foot">
          <Link href="/">{t('task.rail.more', { n: more })}</Link>
        </p>
      )}
    </nav>
  );
}
