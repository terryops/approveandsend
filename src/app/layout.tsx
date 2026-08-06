import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { APP_NAME, APP_TAGLINE } from '@/lib/brand';
import { isProtected } from '@/lib/auth/session';

import './globals.css';

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_TAGLINE,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="top">
            <span className="brand">{APP_NAME}</span>
            <span className="tagline">{APP_TAGLINE}</span>
            <nav>
              <a href="/">Inbox</a>
              <a href="/rules">Rules</a>
              <a href="/queue">Queue</a>
            </nav>
          </header>
          {!isProtected() && (
            <p className="banner">
              <strong>Unprotected.</strong> No <code>ADMIN_PASSWORD</code> is set, so anyone who can
              reach this port can read and send your mail.
            </p>
          )}
          {children}
        </div>
      </body>
    </html>
  );
}
