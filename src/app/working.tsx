'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A draft being written, watched from wherever the reviewer went next.
 *
 * Redrafting used to put a panel over the review screen and keep it there until
 * the model came back. That was the truthful thing to do while the answer could
 * only appear on that one screen — but the wait is tens of seconds, and the
 * screen it pinned somebody to is the screen they had just finished with. The
 * queue is twelve rows deep; making the person who kicked off a redraft sit and
 * watch it is the interface deciding that its own progress is more interesting
 * than their next task.
 *
 * So the wait moved to the top of the window and stopped being modal. Press
 * Redraft, walk away, answer two more emails; the strip says what is still
 * cooking, and when it lands it says so and offers the way back. Nothing here
 * cancels anything and nothing here is load-bearing — the draft is written by
 * the queue whether or not this browser is open, which is why the whole of the
 * state is one list of ids in `sessionStorage` rather than anything on the row.
 *
 * Per tab, deliberately. `sessionStorage` is scoped to the tab, and "what am I
 * waiting for" is a fact about this window: two tabs open on the same desk are
 * two people's worth of attention, and a notice about a task the other tab
 * started is a notice about something you were not doing.
 */

/** Where the watched ids live, and the event that says the list moved. */
const KEY = 'aas.working';
const CHANGED = 'aas:working';
/** The task this tab pressed Redraft on and has not yet been shown the answer to. */
const LANDING = 'aas.landing';

type Row = { id: string; status: string; title: string; translating?: boolean };

/**
 * Still with the model.
 *
 * The two statuses a draft passes through — and the rendering behind it, which
 * is not a status at all. On a desk that reads its mail in another language the
 * draft landing is only half of it: the task turns `awaiting_review` while the
 * translation the reviewer will actually read is still being written, and a
 * strip that announced the first half sent them to a screen with nothing on it
 * they could read. One notice, when both have landed.
 */
function running(row: Row): boolean {
  return row.status === 'pending' || row.status === 'drafting' || row.translating === true;
}

function read(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // A private-mode browser with no storage at all, or somebody's leftover
    // junk under the key. Watching nothing is the correct degraded state: the
    // draft still gets written, it just does not announce itself.
    return [];
  }
}

function write(ids: string[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* see `read` */
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * Puts this task on the list, from the screen that started the work.
 *
 * Rendered by the review screen when it is reached with `?redrafting=1` or
 * `?queued=1` — the two redirects that mean "a job was just kicked for this
 * row". Registering here rather than in the action, because the action runs on
 * the server and the list belongs to the tab that pressed the button.
 */
export function WatchTask({ id }: { id: string }) {
  useEffect(() => {
    const ids = read();
    if (!ids.includes(id)) write([...ids, id]);
    // And a note that this tab is waiting to be *shown* the answer, not merely
    // told it exists. See `LandOnDraft`.
    try {
      sessionStorage.setItem(LANDING, id);
    } catch {
      /* see `read` — a browser with no storage just does not scroll */
    }
  }, [id]);

  return null;
}

/**
 * Putting the reviewer's eye back on the draft, once there is one.
 *
 * The wait is not modal any more — see the note at the top of this file — so
 * the page under it stays where it was: scrolled to the reply box, with the
 * redraft panel's scrim over it, or wherever the reviewer had got to reading
 * the customer's mail. The poller then calls `router.refresh()`, the server
 * sends back a screen with a new draft on it, and React patches it into place
 * *without moving the viewport*. The new reply lands somewhere off-screen and
 * the screen the reviewer is looking at is unchanged, which reads as nothing
 * having happened — the exact failure the strip was built to fix, one step
 * further along.
 *
 * So: rendered only once the draft is actually on the row, and only for the
 * task this tab started. A task opened cold from the inbox has no landing note
 * and does not move, which matters — an unbidden scroll on a page somebody is
 * reading is worse than no scroll at all.
 *
 * The note is cleared before scrolling rather than after, so a screen that
 * re-renders twice does not fight the reviewer for the scroll position if they
 * have already dragged away from it.
 */
export function LandOnDraft({ id, anchor = 'reply' }: { id: string; anchor?: string }) {
  useEffect(() => {
    let waiting: string | null = null;
    try {
      waiting = sessionStorage.getItem(LANDING);
      if (waiting === id) sessionStorage.removeItem(LANDING);
    } catch {
      return;
    }
    if (waiting !== id) return;

    const target = document.getElementById(anchor);
    if (!target) return;
    // Respecting the same preference the rest of the app does: somebody who has
    // asked their system for no animation gets the jump, not the glide.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  }, [id, anchor]);

  return null;
}

export interface WorkingLabels {
  /** While the model is writing. */
  busy: string;
  /** Once the draft is on the row. */
  ready: string;
  /** The link back to it. */
  open: string;
  /** Stop showing a finished one. */
  dismiss: string;
}

export function WorkingStrip({ labels }: { labels: WorkingLabels }) {
  const [ids, setIds] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  // Read by the poll, which is a callback rather than a render — so it needs
  // the path as of the tick, not as of the render that started the chain.
  const where = useRef(pathname);
  useEffect(() => {
    where.current = pathname;
  }, [pathname]);

  // Mounted in the root layout, which renders once per document — so the list
  // is read here and then only ever changes through the event above.
  useEffect(() => {
    const sync = () => setIds(read());
    sync();
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);

  const forget = useCallback((id: string) => {
    write(read().filter(kept => kept !== id));
    setRows(current => current.filter(row => row.id !== id));
  }, []);

  const busy = rows.some(running);
  // Before the first answer comes back everything on the list counts as in
  // flight; otherwise a strip mounted on a fresh navigation would decide, in
  // the frame before it has asked anything, that there was nothing to poll for.
  const waiting = ids.length > 0 && (rows.length === 0 || busy);

  useEffect(() => {
    if (!waiting) return;

    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const ask = async () => {
      try {
        const response = await fetch(`/api/working?ids=${encodeURIComponent(ids.join(','))}`, {
          cache: 'no-store',
        });
        // A signed-out tab: stop asking rather than poll a login redirect for
        // the rest of the afternoon.
        if (!response.ok) {
          if (live) setIds([]);
          return;
        }
        const body: { tasks?: Row[] } = await response.json();
        if (!live) return;
        const fresh = Array.isArray(body.tasks) ? body.tasks : [];
        setRows(fresh);

        // The one case where the notice would be redundant, and worse than
        // redundant: the reviewer is sitting on the task it is about. That
        // screen polls for itself, so the draft arrives where they are already
        // looking — the strip has only to drop the row and make sure the page
        // has been told, in case its own tick is still seconds away.
        const here = /^\/tasks\/([^/]+)\/?$/.exec(where.current)?.[1];
        if (here && fresh.some(row => row.id === here && !running(row))) {
          write(read().filter(kept => kept !== here));
          router.refresh();
        }
      } catch {
        // A dropped connection is not news. The next tick asks again.
      }
      if (live) timer = setTimeout(ask, 2500);
    };

    timer = setTimeout(ask, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `ids.join` rather than the array: a poll must not restart on every render
    // that happens to rebuild the same list.
  }, [waiting, ids, router]);

  const shown = rows.filter(row => ids.includes(row.id));
  if (ids.length === 0) return null;

  return (
    // Polite, because it updates itself: an assertive region would cut across a
    // screen reader every time a status changed.
    <div className="working-strip" aria-live="polite">
      {shown.length === 0 && (
        <p className="working-note">
          <span className="spinner" aria-hidden="true" />
          {labels.busy}
        </p>
      )}
      {shown.map(row => {
        const live = running(row);
        return (
          <p className={`working-note${live ? '' : ' is-done'}`} key={row.id}>
            {live && <span className="spinner" aria-hidden="true" />}
            <span className="what">{live ? labels.busy : labels.ready}</span>
            <span className="which">{row.title}</span>
            {!live && (
              <Link href={`/tasks/${row.id}`} onClick={() => forget(row.id)}>
                {labels.open}
              </Link>
            )}
            {/* Only on a finished one. Dismissing a draft that is still being
                written would look like cancelling it, and nothing here can. */}
            {!live && (
              <button type="button" onClick={() => forget(row.id)} aria-label={labels.dismiss}>
                <span aria-hidden="true">×</span>
              </button>
            )}
          </p>
        );
      })}
    </div>
  );
}
