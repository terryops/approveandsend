import { after } from 'next/server';

import { hasSession } from '@/lib/auth/guard';
import { nudgeQueue } from '@/lib/queue/nudge';
import { getTask } from '@/lib/tasks/store';
import { deskTitle } from '@/lib/tasks/types';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/working?ids=a,b` — is the model finished with these yet.
 *
 * The one question the rest of this app cannot answer from a server render:
 * *the task you are not looking at*. Redrafting used to hold the reviewer on
 * the task with a panel over the screen, which is the honest way to show a wait
 * when the screen is the only place the answer can appear — and it cost them
 * the thirty seconds. This is the same wait, watched from anywhere: the strip
 * in the header asks about the handful of tasks this browser has started, and
 * nothing else about them is exposed. A status and the heading already on the
 * row, for a session that could open the whole task anyway.
 *
 * The queue turn is not incidental. The panel it replaces was what kept the
 * queue moving while somebody waited — the review screen drained it on every
 * poll (see `nudgeQueue` in the task page) — so a strip that only asked would
 * have left a redraft sitting at `pending` on any install whose crontab is the
 * only thing turning jobs. Asking whether the work is done is now also what
 * gets it done, which is the same bargain as before and available from every
 * screen rather than from one.
 */

/** Enough for a reviewer who kicked off several; past that it is a scraper. */
const MAX_WATCHED = 12;

export async function GET(request: Request): Promise<Response> {
  if (!(await hasSession())) return Response.json({ tasks: [] }, { status: 401 });

  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
    .slice(0, MAX_WATCHED);

  const tasks = ids.flatMap(id => {
    const task = getTask(id);
    return task ? [{ id: task.id, status: task.status, title: deskTitle(task) }] : [];
  });

  // Only while something is actually waiting on it. A strip with nothing in
  // flight has stopped polling by then anyway, but a browser left open on a
  // stale list must not turn the queue every two seconds for the afternoon.
  if (tasks.some(task => task.status === 'pending' || task.status === 'drafting')) {
    after(() => nudgeQueue());
  }

  return Response.json({ tasks }, { headers: { 'Cache-Control': 'no-store' } });
}
