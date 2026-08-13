import { requireMachine } from '@/lib/auth/guard';
import { syncDisputeTasks } from '@/lib/billing/dispute-tasks';

export const dynamic = 'force-dynamic';

/**
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/disputes`
 *
 * Hourly, beside the sweep. Not on the five-minute sync, for a reason that is
 * about money rather than load: this reads every open dispute and then a charge
 * and a customer for each, so it is a handful of Stripe calls per open case,
 * every time it runs. A chargeback carries a three-week deadline. An hour late
 * is not late.
 *
 * Deliberately not in `SCHEDULED`, unlike the other four. This one only does
 * anything on a desk whose Stripe key has the disputes permission, and a job
 * listed as expected but never called reads as a broken crontab on every desk
 * that simply does not use it — which would make that card worth less exactly
 * where it is worth most.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // 200 even when the result carries an `error`. The ordinary cause is a key
  // without the disputes permission, which is a configuration answer rather
  // than a failure of this call — and a crontab that mails non-zero exits would
  // otherwise mail that same answer every hour, for ever.
  return Response.json(await syncDisputeTasks());
}
