import { redirect } from 'next/navigation';

import { hasSession } from '@/lib/auth/guard';
import { APP_NAME } from '@/lib/brand';

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
      <h2>Sign in to {APP_NAME}</h2>
      <input type="password" name="password" placeholder="Password" autoFocus />
      {typeof query.error === 'string' && <p className="error">That is not the password.</p>}
      <button className="primary" type="submit">
        Sign in
      </button>
      <p className="meta">
        One password, set as <code>ADMIN_PASSWORD</code>. There are no accounts.
      </p>
    </form>
  );
}
