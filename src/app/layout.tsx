import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { APP_NAME } from '@/lib/brand';
import { isProtected } from '@/lib/auth/session';
import { locale, t } from '@/lib/i18n';

import './globals.css';

export const metadata: Metadata = {
  title: APP_NAME,
  description: t('brand.tagline'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={locale()}>
      <body>
        <div className="shell">
          <header className="top">
            <span className="brand">{APP_NAME}</span>
            <span className="tagline">{t('brand.tagline')}</span>
            <nav>
              <Link href="/">{t('nav.inbox')}</Link>
              <Link href="/compose">{t('nav.compose')}</Link>
              <Link href="/rules">{t('nav.rules')}</Link>
              <Link href="/backfill">{t('nav.archive')}</Link>
              <Link href="/queue">{t('nav.queue')}</Link>
              <Link href="/operators">{t('nav.operators')}</Link>
              <Link href="/setup">{t('nav.setup')}</Link>
            </nav>
          </header>
          {!isProtected() && (
            <p className="banner">
              <strong>{t('brand.unprotectedLabel')}</strong> {t('brand.unprotectedLead')}{' '}
              <code>ADMIN_PASSWORD</code> {t('brand.unprotectedRest')}{' '}
              <Link href="/setup">{t('brand.unprotectedSetOne')}</Link>.
            </p>
          )}
          {children}
        </div>
      </body>
    </html>
  );
}
