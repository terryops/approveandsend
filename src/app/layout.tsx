import type { Metadata } from 'next';
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
              <a href="/">{t('nav.inbox')}</a>
              <a href="/rules">{t('nav.rules')}</a>
              <a href="/backfill">{t('nav.archive')}</a>
              <a href="/queue">{t('nav.queue')}</a>
              <a href="/operators">{t('nav.operators')}</a>
              <a href="/setup">{t('nav.setup')}</a>
            </nav>
          </header>
          {!isProtected() && (
            <p className="banner">
              <strong>{t('brand.unprotectedLabel')}</strong> {t('brand.unprotectedLead')}{' '}
              <code>ADMIN_PASSWORD</code> {t('brand.unprotectedRest')}{' '}
              <a href="/setup">{t('brand.unprotectedSetOne')}</a>.
            </p>
          )}
          {children}
        </div>
      </body>
    </html>
  );
}
