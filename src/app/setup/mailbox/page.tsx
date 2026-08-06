import { envFilePath } from '@/lib/setup/env-file';

import { saveMailbox, testMailbox } from '../actions';
import { LastCheck, Notice, type Query } from '../notice';

export const dynamic = 'force-dynamic';

/**
 * IMAP only, on purpose.
 *
 * Gmail's other route — a service account with domain-wide delegation — is
 * supported by the app and cannot honestly be walked through in a form: it
 * ends in a Google Workspace admin console, pasting a private key. Sending
 * someone there mid-wizard with no way back is worse than pointing at the
 * documentation, so this screen covers the case that fits (an app password on
 * any IMAP host, Gmail included) and says plainly where the other one lives.
 */
export default async function MailboxPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;

  const address = process.env.MAIL_USER?.trim() ?? '';
  const imapHost = process.env.IMAP_HOST?.trim() ?? '';
  const smtpHost = process.env.SMTP_HOST?.trim() ?? '';
  const hasPassword = (process.env.MAIL_PASSWORD?.trim() ?? '') !== '';

  return (
    <>
      <Notice query={query} path={envFilePath()} />

      <form className="card stack" action={saveMailbox}>
        <h2>3. Connect the mailbox</h2>
        <p className="meta">
          The account whose support mail you want drafted. Use an app-specific password rather than
          the real one — Gmail, Fastmail and Zoho all issue them, and it can be revoked without
          changing your login.
        </p>

        <input
          type="email"
          name="address"
          defaultValue={address}
          placeholder="support@yourcompany.com"
        />
        <input
          type="password"
          name="password"
          autoComplete="off"
          placeholder={hasPassword ? 'A password is saved — leave blank to keep it' : 'App password'}
        />

        <div className="row">
          <input
            className="grow"
            type="text"
            name="imapHost"
            defaultValue={imapHost}
            placeholder="IMAP host, e.g. imap.gmail.com"
          />
          <input
            type="text"
            name="imapPort"
            defaultValue={process.env.IMAP_PORT?.trim() ?? ''}
            placeholder="993"
            style={{ width: 90 }}
          />
        </div>

        <div className="row">
          <input
            className="grow"
            type="text"
            name="smtpHost"
            defaultValue={smtpHost}
            placeholder="SMTP host, e.g. smtp.gmail.com"
          />
          <input
            type="text"
            name="smtpPort"
            defaultValue={process.env.SMTP_PORT?.trim() ?? ''}
            placeholder="465"
            style={{ width: 90 }}
          />
        </div>

        <div className="row">
          <span className="grow meta">
            Port 465 is implicit TLS, 587 is STARTTLS — either is fine and the right mode is picked
            from the number. For Workspace domain-wide delegation, see <code>.env.example</code>.
          </span>
          <button type="submit">Save</button>
        </div>
      </form>

      <LastCheck step="mailbox" />

      <div className="row">
        <form action={testMailbox}>
          <button type="submit" disabled={!imapHost}>
            Test it
          </button>
        </form>
        <span className="grow meta">
          Logs in and reads the top of the inbox. Nothing is imported, marked read, or sent.
        </span>
        <a className="meta" href="/setup/voice">
          Next: who you are →
        </a>
      </div>
    </>
  );
}
