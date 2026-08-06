import { requireMachine } from '@/lib/auth/guard';
import { snapshot } from '@/lib/db/snapshot';
import { importLegacy } from '@/lib/import/legacy';
import { importLegacyRules } from '@/lib/import/legacy-rules';

export const dynamic = 'force-dynamic';

/**
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/import/legacy \
 *    -d '{"path":"/srv/old/data/tasks.db","messagePrefix":"4243...0002"}'`
 *
 * A route rather than a CLI because the import has to run against the same
 * database the app has open, in the same process, with the same migrations
 * applied. A script would be a second way in with its own connection and its
 * own idea of where the config lives, for something most installs run once.
 *
 * Start with `"limit": 5` and read what comes back. Nothing is destroyed by a
 * second full run — tasks are matched on message id, rules on what they say —
 * but a run with the wrong `messagePrefix` imports rows that the next one
 * cannot recognise, and that is a duplicate archive rather than a mistake you
 * can repeat your way out of.
 *
 * Both halves in one call, because they are one migration and the rules are
 * the half people forget. Answered mail is context; a rule is a decision
 * somebody made after getting a reply wrong, and it cannot be regenerated from
 * the mail. `"rules": false` skips them for a mail-only trial run.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await requireMachine(request))) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { path?: unknown; messagePrefix?: unknown; limit?: unknown; rules?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Body is not JSON' }, { status: 400 });
  }

  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return Response.json({ error: 'path is required' }, { status: 400 });

  const limit = Number(body.limit);
  const messagePrefix = typeof body.messagePrefix === 'string' ? body.messagePrefix.trim() : '';

  try {
    // Before, not after. An import writes a few thousand rows into a live
    // database, and the way back from a wrong `messagePrefix` is a file.
    const backup = await snapshot('import');

    const capped = Number.isInteger(limit) && limit > 0 ? { limit } : {};

    const result = importLegacy({
      path,
      ...(messagePrefix ? { messagePrefix } : {}),
      ...capped,
    });

    // After the mail, so that a file which is not an old database at all fails
    // on the table everyone knows the name of rather than on `analysis_rules`.
    const rules = body.rules === false ? null : importLegacyRules({ path, ...capped });

    return Response.json({
      ...result,
      ...(rules ? { rules } : {}),
      ...(backup ? { backup } : {}),
      ...(messagePrefix
        ? {}
        : {
            warning:
              'No messagePrefix: the imported conversations carry no provider id, so a mail sync will not recognise them and may re-ingest answered mail as new tasks.',
          }),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
