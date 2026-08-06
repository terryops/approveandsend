import { requireMachine } from '@/lib/auth/guard';
import { DEFAULT_HANDLERS, createWorker } from '@/lib/queue';

export const dynamic = 'force-dynamic';
// Drafting is one or two LLM calls, and a self-hosted model can take minutes.
export const maxDuration = 600;

/**
 * The scheduled half of the queue: `curl -XPOST host/api/worker` from cron.
 *
 * It drains a bounded batch and returns rather than looping forever, so two
 * overlapping cron ticks cost a little duplicated polling instead of two
 * immortal workers. The lease in `claimNext` is what actually makes that safe.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const max = Number(new URL(request.url).searchParams.get('max'));
  const worker = createWorker({ handlers: DEFAULT_HANDLERS });

  try {
    const outcomes = await worker.drain(Number.isFinite(max) && max > 0 ? max : 10);
    return Response.json({
      processed: outcomes.length,
      jobs: outcomes.map((outcome) => ({
        id: outcome.job.id,
        type: outcome.job.type,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
      })),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
