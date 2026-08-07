import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { requireMachine } from '@/lib/auth/guard';
import { snapshot } from '@/lib/db/snapshot';
import { importLegacy } from '@/lib/import/legacy';
import { importLegacyRules } from '@/lib/import/legacy-rules';

export const dynamic = 'force-dynamic';

/**
 * The directory the old database is allowed to be in, or null.
 *
 * Unset is a closed door rather than an open one. `path` comes out of a JSON
 * body and goes into `new Database(path)`, which is a request to open any file
 * on the host as SQLite — and the errors it throws differ enough ("unable to
 * open", "file is not a database", "no such table: tasks") to walk a filesystem
 * with. A one-line migration that most installs run once is not worth leaving
 * that reachable for the rest of the deployment's life, so it has to be turned
 * on, pointed at the directory the old data is in, and turned off after.
 */
function importRoot(): string | null {
  const value = process.env.AAS_IMPORT_ROOT?.trim();
  return value ? value : null;
}

/**
 * The requested path, resolved and confirmed to be inside the root.
 *
 * `realpathSync` on both sides because `resolve` alone answers a question about
 * strings: a symlink inside the root pointing at `/etc/shadow` resolves to a
 * path that starts with the root and opens a file that does not. Comparing real
 * paths, with the separator appended so `/srv/olddata` cannot pass as `/srv/old`,
 * is the check that means what it looks like it means.
 */
function resolveInRoot(root: string, requested: string): string | null {
  const realRoot = realpathSync(root);
  const real = realpathSync(resolve(realRoot, requested));
  return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
}

/**
 * `curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST host/api/import/legacy \
 *    -d '{"path":"/srv/old/data/tasks.db","messagePrefix":"4243...0002"}'`
 *
 * Requires `AAS_IMPORT_ROOT` to be set to a directory the file lives under.
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

  const root = importRoot();
  if (!root) {
    return Response.json(
      { error: 'Legacy import is not enabled. Set AAS_IMPORT_ROOT to the directory holding the old database.' },
      { status: 403 },
    );
  }

  const requested = typeof body.path === 'string' ? body.path.trim() : '';
  if (!requested) return Response.json({ error: 'path is required' }, { status: 400 });

  // One message for outside the root, for a path that does not exist, and for a
  // root that is itself missing. Three answers here would be the same oracle
  // the root was added to close, asked one level up.
  let path: string;
  try {
    const inRoot = resolveInRoot(root, requested);
    if (!inRoot) throw new Error('outside root');
    path = inRoot;
  } catch {
    return Response.json({ error: 'path is not a readable file inside AAS_IMPORT_ROOT' }, { status: 400 });
  }

  const limit = Number(body.limit);
  const messagePrefix = typeof body.messagePrefix === 'string' ? body.messagePrefix.trim() : '';

  try {
    // After the path check, not before. A snapshot copies the whole database to
    // disk, and taking one per request made an unauthenticated probe — which is
    // what an install with neither password nor token answers — into a way to
    // fill the volume by asking for a file that was never there.
    //
    // Still before the import itself: it writes a few thousand rows into a live
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
    // The detail goes to the log, where the operator running the import can
    // read it, and not to the response, where it told a caller which of "not a
    // file", "not a database" and "no such table: tasks" a guessed path was.
    console.error('[import/legacy] failed', error);
    return Response.json({ error: 'Import failed. See the server log.' }, { status: 400 });
  }
}
