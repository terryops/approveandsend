import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/health` — for a container orchestrator, so it is unauthenticated.
 *
 * It answers the only question a restart can fix: is this process up, and can
 * it reach its own database? It deliberately does not touch the model or the
 * mailbox. Those go down for reasons a restart makes worse rather than better,
 * and a health check that fails when an IMAP server is having a bad afternoon
 * turns one outage into a crash loop.
 *
 * The response says nothing a stranger could not learn by loading the login
 * page, which is why it needs no token.
 */
export function GET(): Response {
  try {
    getDb().prepare('SELECT 1').get();
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }

  return Response.json({ ok: true });
}
