import { requireMachine } from '@/lib/auth/guard';
import { noteRun } from '@/lib/desk/automation';
import { sweepStuckTasks } from '@/lib/tasks/sweep';

export const dynamic = 'force-dynamic';

/**
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/sweep`
 *
 * Hourly from cron, next to the five-minute sync. Separate from `/api/worker`
 * on purpose: the worker is the thing that gets killed mid-job, and asking it
 * to also be the thing that notices it was killed mid-job is how the gap this
 * closes got there in the first place.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  noteRun('sweep');

  const url = new URL(request.url);
  const graceMinutes = Number(url.searchParams.get('graceMinutes'));
  const limit = Number(url.searchParams.get('limit'));

  try {
    const result = await sweepStuckTasks({
      ...(Number.isFinite(graceMinutes) && graceMinutes >= 0
        ? { graceMs: graceMinutes * 60_000 }
        : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
