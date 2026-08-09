import { requireMachine } from '@/lib/auth/guard';
import { noteRun } from '@/lib/desk/automation';
import { syncInbox } from '@/lib/ingest/sync';

export const dynamic = 'force-dynamic';

/**
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/sync`
 *
 * Every five minutes from cron is the intended deployment. It is a POST
 * because it creates tasks, and because a GET would let a link preview bot
 * fetch a mailbox.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // After the guard and before the work: this records that a scheduler exists,
  // which is true the moment an authenticated call arrives. See `noteRun`.
  noteRun('sync');

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit'));
  const since = url.searchParams.get('since');

  try {
    const result = await syncInbox({
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(since ? { since } : {}),
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
