import { redirect } from 'next/navigation';

import { hasSession } from '@/lib/auth/guard';
import { APP_NAME } from '@/lib/brand';
import { t } from '@/lib/i18n';

import { login } from '../actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await hasSession()) redirect('/');
  const query = await searchParams;

  return (
    <form className="card stack" action={login} style={{ maxWidth: 380, margin: '10vh auto' }}>
      <h2>{t('login.title', { app: APP_NAME })}</h2>
      <input type="password" name="password" placeholder={t('login.passwordPlaceholder')} autoFocus />
      {typeof query.error === 'string' && <p className="error">{t('login.wrongPassword')}</p>}
      <button className="primary" type="submit">
        {t('login.submit')}
      </button>
      <p className="meta">
        {t('login.hintLead')} <code>ADMIN_PASSWORD</code>
        {t('login.hintRest')}
      </p>
    </form>
  );
}
