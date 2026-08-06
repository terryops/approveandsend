import type { ReactNode } from 'react';

import { requirePage } from '@/lib/auth/guard';
import { setupState } from '@/lib/setup/state';

/**
 * The rail down the side of every step.
 *
 * Note what guards this: `requirePage`, the same call as every other page. On
 * a fresh install there is no password, so `isProtected()` is false and the
 * wizard is reachable — which is the only way it could be, since setting the
 * password is step one. The moment that step completes the wizard is behind
 * the login wall along with everything else. No special case, no bypass to
 * forget about later.
 */
export default async function SetupLayout({ children }: { children: ReactNode }) {
  await requirePage();
  const state = setupState();

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 28 }}>
      <nav className="stack" style={{ width: 190, flexShrink: 0, gap: 2 }}>
        {state.steps.map((step, index) => (
          <a
            key={step.step}
            href={step.href}
            className="meta"
            style={{ padding: '6px 0', textDecoration: 'none' }}
          >
            <span style={{ opacity: step.done ? 1 : 0.5 }}>{step.done ? '●' : '○'}</span>{' '}
            {index + 1}. {step.title}
          </a>
        ))}
      </nav>
      <div className="grow stack">{children}</div>
    </div>
  );
}
