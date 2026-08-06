import { requireMachine } from '@/lib/auth/guard';
import { getDb } from '@/lib/db';
import { saveContext } from '@/lib/context/store';
import { coerceBlock } from '@/lib/context/types';
import { getTask } from '@/lib/tasks/store';

export const dynamic = 'force-dynamic';

/**
 * A lookup that finished somewhere else, posted back in.
 *
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/tasks/$id/context \
 *    -d '{"sourceId":"crm","label":"CRM","title":"Account","prompt":"..."}'`
 *
 * Context sources run inside `enrich-context` and have to finish while a mail
 * is waiting. Some lookups cannot: a browser scrape behind a login, a report
 * that takes four minutes, a question a person answers in Slack. Those run on
 * their own schedule and put the answer here when they have it, and the card
 * appears on the review screen the next time it is loaded.
 *
 * The system this replaced had three endpoints of this shape — one per
 * external agent it farmed work out to — because it had no queue, so every
 * lookup was somebody else's job. Two of the three are now ordinary context
 * sources that run in-process, and this is what is left: the case where the
 * work genuinely cannot happen inside a job with a timeout.
 *
 * What it will not accept is a draft. The third old endpoint let an outside
 * process write the reply text directly, which walked around the version
 * history and the audit trail both — the two records that exist to answer "who
 * decided this". A machine token is for adding facts. Deciding what to say
 * with them stays where it can be traced.
 */

interface Payload {
  sourceId?: unknown;
  label?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { taskId } = await params;

  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return Response.json({ error: 'Body is not JSON' }, { status: 400 });
  }

  const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
  if (!sourceId) {
    // Named, because the row it writes is keyed on it: a callback that does
    // not say which lookup it is would overwrite whichever one went last.
    return Response.json({ error: 'sourceId is required' }, { status: 400 });
  }

  const db = getDb();
  if (!getTask(taskId, db)) {
    return Response.json({ error: 'No such task' }, { status: 404 });
  }

  const block = coerceBlock(body);
  if (!block) {
    // Nothing to show and nothing to say. Storing it would put an empty card
    // on the screen, which reads as a lookup that found nothing rather than
    // one that was posted wrong.
    return Response.json({ error: 'Nothing to store: needs a title and either fields or prompt' }, { status: 400 });
  }

  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : block.title;
  saveContext(taskId, sourceId, label, block, db);

  return Response.json({ stored: sourceId });
}
