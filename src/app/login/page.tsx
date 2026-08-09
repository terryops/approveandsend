import { redirect } from 'next/navigation';

import { hasSession } from '@/lib/auth/guard';
import { appName } from '@/lib/brand';
import { resolveRequestLocale, t } from '@/lib/i18n';
import { countActiveOperators } from '@/lib/operators/store';

import { login } from '../actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The one page that cannot call `requirePage` — it is what `requirePage`
  // sends people to — so it settles its own language.
  await resolveRequestLocale();
  if (await hasSession()) redirect('/');
  const query = await searchParams;
  // The name field appears only once there is someone to name. An install
  // running on ADMIN_PASSWORD alone should not be asked who it is.
  const named = countActiveOperators() > 0;

  return (
    <form className="card stack" action={login} style={{ maxWidth: 380, margin: '10vh auto' }}>
      {/* An `h1` rather than the `h2` it was: this card is the whole page, so
          the heading on it is the page's name. Styled identically — see
          `.card h1` in globals.css. */}
      <h1>{t('login.title', { app: appName() })}</h1>
      {named && (
        <input type="text" name="name" placeholder={t('login.namePlaceholder')} autoFocus />
      )}
      <input
        type="password"
        name="password"
        placeholder={t('login.passwordPlaceholder')}
        autoFocus={!named}
      />
      {typeof query.error === 'string' && <p className="error">{t('login.wrongPassword')}</p>}
      <button className="primary" type="submit">
        {t('login.submit')}
      </button>
      <p className="meta">
        {named ? (
          t('login.hintOperators')
        ) : (
          <>
            {t('login.hintLead')} <code>ADMIN_PASSWORD</code>
            {t('login.hintRest')}
          </>
        )}
      </p>
    </form>
  );
}
