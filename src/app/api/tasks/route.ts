import { after } from 'next/server';

import { requireMachine } from '@/lib/auth/guard';
import { normaliseTopicSlug } from '@/lib/config/workspace';
import { isValidEmail } from '@/lib/mail/address';
import { enqueueCompose } from '@/lib/queue/handlers/compose-message';
import { nudgeQueue } from '@/lib/queue/nudge';
import { createTask } from '@/lib/tasks/store';

export const dynamic = 'force-dynamic';

/**
 * Handing work in from outside the process.
 *
 * The desk can already write a mail nobody asked for — that is `/compose`, and
 * a composed task is reviewed, edited, translated and sent by exactly the code
 * that answers a customer. What it could not do was be told to. The only door
 * was a form, so every conversation a desk might reasonably start on the back
 * of something that happened elsewhere — a review left on a store page, a
 * churned subscription, a form submission, a support call somebody took —
 * arrived here as a person reading another screen and retyping it into this
 * one.
 *
 * This is that same door with a token on it. It deliberately knows nothing
 * about what it is being handed: it takes an address, a brief and a label, and
 * from the enqueue on it is indistinguishable from the form. Everything that
 * decides *which* reviews are worth writing to, what the brief should say and
 * where the facts come from belongs to the program on the other end of it —
 * that program is where a particular company's business lives, and keeping it
 * there is the difference between a product and one company's tooling.
 *
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/tasks \
 *    -d '{"to":"a@example.com","brief":"Thank them for the 2-star review …",
 *         "externalId":"review:8412","source":"store-reviews"}'`
 *
 * Repeatable by design. A caller that re-reads its whole list every five
 * minutes and hands in all of it is the normal, correct implementation of a
 * sync, so an `externalId` it has already sent returns the task it made the
 * first time with `existed: true` and enqueues nothing.
 */

/** A brief longer than this is a document; the drafter clips it anyway. */
const MAX_BRIEF = 8_000;
/** Long enough for any label; short enough that the column is not a payload. */
const MAX_LABEL = 200;

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export async function POST(request: Request): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Expected a JSON object' }, { status: 400 });
  }

  const to = text(body.to, MAX_LABEL);
  const brief = text(body.brief, MAX_BRIEF);

  // Both refused rather than defaulted. A task with no recipient cannot be
  // sent and a task with no brief has nothing for the model to write from;
  // either one is a row a reviewer opens, cannot use and has to delete, which
  // is worse than a 400 the caller's log will show.
  if (!isValidEmail(to)) {
    return Response.json({ error: '"to" must be an email address' }, { status: 400 });
  }
  if (!brief) {
    return Response.json({ error: '"brief" is required' }, { status: 400 });
  }

  const priority = Number(body.priority);

  const { task, existed } = createTask({
    origin: 'composed',
    // Where a customer's words would be, which is what `compose` reads. The
    // drafter is told which of the two it is looking at; nothing downstream of
    // it needs to care.
    body: brief,
    fromAddress: to,
    ...(text(body.name, MAX_LABEL) ? { fromName: text(body.name, MAX_LABEL) } : {}),
    subject: text(body.subject, MAX_LABEL),
    ...(text(body.externalId, MAX_LABEL) ? { externalId: text(body.externalId, MAX_LABEL) } : {}),
    ...(text(body.source, MAX_LABEL) ? { source: text(body.source, MAX_LABEL) } : {}),
    // A caller that already knows what this is about says so, and the drafter
    // skips the classification call it would otherwise pay for. An unknown slug
    // is stored and simply matches no rules — the same outcome as not sending
    // one, which is why it is not worth a 400 over.
    ...(normaliseTopicSlug(body.scope) ? { scope: normaliseTopicSlug(body.scope)! } : {}),
    // Ahead of the inbox by default, like the compose form: a program handing
    // in one specific person to write to has already done the triage that the
    // overnight backlog has not.
    priority: Number.isFinite(priority) && priority >= 1 && priority <= 9 ? Math.round(priority) : 3,
  });

  // Nothing on the second call: the first one enqueued a job, and that job has
  // either produced a draft, is producing one, or failed on the row where a
  // person can see it. Re-enqueuing on every sync would rewrite a draft a
  // reviewer is halfway through editing.
  if (!existed) {
    enqueueCompose(task.id);
    // The queue is turned by cron every few minutes, which is fine for mail
    // that arrived on its own. This is a caller that will be looking for a
    // result, so it gets the same kick the compose form gives itself; the guard
    // in `nudgeQueue` is what stops a batch of fifty building fifty workers.
    after(() => nudgeQueue(5));
  }

  return Response.json({ taskId: task.id, existed, status: task.status }, { status: existed ? 200 : 201 });
}
