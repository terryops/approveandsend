import { APP_NAME } from '@/lib/brand';
import { isProtected } from '@/lib/auth/session';
import { t } from '@/lib/i18n';
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
        <h2>{t('setup.access.pageTitle', { app: APP_NAME })}</h2>
        <p className="meta">{t('setup.access.intro', { app: APP_NAME })}</p>
        <p className="meta">{t('setup.access.privacy')}</p>
      </div>

      <Notice query={query} path={envFilePath()} />

      <form className="card stack" action={saveAccess}>
        <h2>{t('setup.access.title')}</h2>
        <p className="meta">{locked ? t('setup.access.hasPassword') : t('setup.access.noPassword')}</p>
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          placeholder={t('setup.access.passwordPlaceholder')}
        />
        <div className="row">
          <span className="grow meta">
            {t('setup.access.cronTokenBefore')} <code>CRON_TOKEN</code>{' '}
            {t('setup.access.cronTokenAfter')}
          </span>
          <button type="submit">
            {locked ? t('setup.access.replaceButton') : t('setup.access.setButton')}
          </button>
        </div>
      </form>

      <div className="row">
        <span className="grow" />
        <a className="meta" href="/setup/model">
          {t('setup.access.next')}
        </a>
      </div>
    </>
  );
}
