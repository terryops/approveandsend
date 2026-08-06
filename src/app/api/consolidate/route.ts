import { requireMachine } from '@/lib/auth/guard';
import { enqueueConsolidateRules } from '@/lib/queue/handlers';
import { consolidationGate } from '@/lib/rules/consolidate';

export const dynamic = 'force-dynamic';

/**
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/consolidate`
 *
 * Weekly from cron. This only enqueues — the pass itself takes long enough
 * that doing it in the request would need a timeout nobody can predict. The
 * gate is checked here as well as in the handler so that a skipped week
 * doesn't leave a job in the queue at all.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const force = new URL(request.url).searchParams.get('force') === '1';
  const gate = consolidationGate();

  if (!force && !gate.shouldRun) {
    return Response.json({ queued: false, ...gate });
  }

  const result = enqueueConsolidateRules({ force });
  return Response.json({ queued: !result.deduped, jobId: result.job.id, ...gate });
}
