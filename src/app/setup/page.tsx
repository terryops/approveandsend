import { APP_NAME } from '@/lib/brand';
import { isProtected } from '@/lib/auth/session';
import { envFilePath } from '@/lib/setup/env-file';

import { saveAccess } from './actions';
import { Notice, type Query } from './notice';

export const dynamic = 'force-dynamic';

/**
 * Step one, and deliberately the password rather than a welcome screen.
 *
 * The window between "the server is up" and "the server has a password" is the
 * only genuinely dangerous state this app has: it is a machine that can read
 * and send someone's mail, on an open port. So the first screen closes that
 * window, and the welcome text is a paragraph on the same page rather than a
 * click in front of it.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const locked = isProtected();

  return (
    <>
      <div className="card stack">
        <h2>Set up {APP_NAME}</h2>
        <p className="meta">
          Four steps, and you can leave after any of them. {APP_NAME} reads your support mailbox,
          drafts a reply to each message, and holds it until you approve it — and when you edit a
          draft before sending, it works out what the edit was for and remembers.
        </p>
        <p className="meta">
          Everything you type here is written to the same files you would have edited by hand, on
          this machine. Nothing is sent anywhere.
        </p>
      </div>

      <Notice query={query} path={envFilePath()} />

      <form className="card stack" action={saveAccess}>
        <h2>1. Lock the door</h2>
        <p className="meta">
          {locked ? (
            <>
              A password is set. Typing a new one replaces it and signs out every other browser —
              the session key is derived from the password, so that comes free.
            </>
          ) : (
            <>
              There is no password yet, so anyone who can reach this port can read and send your
              mail. One password, no accounts.
            </>
          )}
        </p>
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
        <div className="row">
          <span className="grow meta">
            A <code>CRON_TOKEN</code> is generated at the same time, so the scheduler never needs
            this password.
          </span>
          <button type="submit">{locked ? 'Replace password' : 'Set password'}</button>
        </div>
      </form>

      <div className="row">
        <span className="grow" />
        <a className="meta" href="/setup/model">
          Next: pick a model →
        </a>
      </div>
    </>
  );
}
