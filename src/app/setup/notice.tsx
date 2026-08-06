import { getMeta } from '@/lib/db/meta';
import { t } from '@/lib/i18n';

export type Query = Record<string, string | string[] | undefined>;

export function one(query: Query, key: string): string | null {
  const value = query[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Saved / could-not-save / rejected, in that order of interest.
 *
 * The could-not-save case is the one worth care. A read-only container is a
 * normal deployment, so it gets the exact lines to paste rather than a red
 * apology — and it still says the setting is live for this process, because
 * it is.
 */
export function Notice({ query, path }: { query: Query; path: string }) {
  const error = one(query, 'error');
  const unwritable = one(query, 'unwritable');

  if (error) {
    return (
      <p className="banner">
        <strong>{t('setup.notice.notSaved')}</strong> {error}
      </p>
    );
  }

  if (unwritable !== null) {
    return (
      <p className="banner">
        <strong>{t('setup.notice.unwritableTitle')}</strong> {t('setup.notice.unwritableBefore')}{' '}
        <code>{path}</code> {t('setup.notice.unwritableAfter', { reason: unwritable })}
      </p>
    );
  }

  if (one(query, 'saved')) {
    return (
      <p className="banner" style={{ borderColor: 'var(--line)' }}>
        {t('setup.notice.savedBefore')} <code>{path}</code>
        {t('setup.notice.savedAfter')}
      </p>
    );
  }

  return null;
}

/** The stored verdict from the last time a Test button was pressed. */
export function LastCheck({ step }: { step: 'model' | 'mailbox' }) {
  const raw = getMeta(`setup.check.${step}`);
  if (!raw) return null;

  let parsed: { ok?: boolean; detail?: string; at?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }

  const when = parsed.at ? new Date(parsed.at) : null;
  const stamp = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 16).replace('T', ' ') : '';

  return (
    <p id="result" className="banner" style={parsed.ok ? { borderColor: 'var(--line)' } : undefined}>
      <strong>{parsed.ok ? t('setup.notice.checkOk') : t('setup.notice.checkFailed')}</strong>{' '}
      {parsed.detail}
      {stamp && <span className="meta"> {t('setup.notice.checkedAt', { stamp })}</span>}
    </p>
  );
}
