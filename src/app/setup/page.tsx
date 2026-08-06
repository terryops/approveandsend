import { APP_NAME } from '@/lib/brand';
import { isProtected } from '@/lib/auth/session';
import { t } from '@/lib/i18n';
import { countActiveOperators } from '@/lib/operators/store';
import { envFilePath } from '@/lib/setup/env-file';

import { saveAccess, saveFirstOperator } from './actions';
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
  const named = countActiveOperators();

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

      {/* The better half of this step. A shared password says the door is
          locked; a name says who walked through it, which is the only version
          of this answer that is still useful a month later when somebody asks
          who sent that reply. */}
      <form className="card stack" action={saveFirstOperator}>
        <h2>{t('setup.access.operatorTitle')}</h2>
        <p className="meta">
          {named > 0
            ? t('setup.access.operatorSome', { n: named })
            : t('setup.access.operatorNone')}
        </p>
        <input type="text" name="name" autoComplete="off" placeholder={t('setup.access.operatorNamePlaceholder')} />
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          placeholder={t('setup.access.operatorPasswordPlaceholder')}
        />
        <div className="row">
          <span className="grow meta">{t('setup.access.operatorNote')}</span>
          <button type="submit">{t('setup.access.operatorButton')}</button>
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
