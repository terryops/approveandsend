import { t } from '@/lib/i18n';
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
        <h2>{t('setup.mailbox.title')}</h2>
        <p className="meta">{t('setup.mailbox.intro')}</p>

        <input
          type="email"
          name="address"
          defaultValue={address}
          placeholder={t('setup.mailbox.addressPlaceholder')}
        />
        <input
          type="password"
          name="password"
          autoComplete="off"
          placeholder={
            hasPassword
              ? t('setup.mailbox.passwordSavedPlaceholder')
              : t('setup.mailbox.passwordPlaceholder')
          }
        />

        <div className="row">
          <input
            className="grow"
            type="text"
            name="imapHost"
            defaultValue={imapHost}
            placeholder={t('setup.mailbox.imapHostPlaceholder')}
          />
          <input
            type="text"
            name="imapPort"
            defaultValue={process.env.IMAP_PORT?.trim() ?? ''}
            placeholder={t('setup.mailbox.imapPortPlaceholder')}
            style={{ width: 90 }}
          />
        </div>

        <div className="row">
          <input
            className="grow"
            type="text"
            name="smtpHost"
            defaultValue={smtpHost}
            placeholder={t('setup.mailbox.smtpHostPlaceholder')}
          />
          <input
            type="text"
            name="smtpPort"
            defaultValue={process.env.SMTP_PORT?.trim() ?? ''}
            placeholder={t('setup.mailbox.smtpPortPlaceholder')}
            style={{ width: 90 }}
          />
        </div>

        <div className="row">
          <span className="grow meta">
            {t('setup.mailbox.portsNoteBefore')} <code>.env.example</code>
            {t('setup.mailbox.portsNoteAfter')}
          </span>
          <button type="submit">{t('setup.mailbox.save')}</button>
        </div>
      </form>

      <LastCheck step="mailbox" />

      <div className="row">
        <form action={testMailbox}>
          <button type="submit" disabled={!imapHost}>
            {t('setup.mailbox.test')}
          </button>
        </form>
        <span className="grow meta">{t('setup.mailbox.testNote')}</span>
        <a className="meta" href="/setup/voice">
          {t('setup.mailbox.next')}
        </a>
      </div>
    </>
  );
}
