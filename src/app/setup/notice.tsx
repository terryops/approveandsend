import { getMeta } from '@/lib/db/meta';

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
        <strong>Not saved.</strong> {error}
      </p>
    );
  }

  if (unwritable !== null) {
    return (
      <p className="banner">
        <strong>In effect, but not written down.</strong> This is live for the running server, but{' '}
        <code>{path}</code> could not be written ({unwritable}), so it will be gone after a restart.
        Put these lines wherever this deployment keeps its configuration.
      </p>
    );
  }

  if (one(query, 'saved')) {
    return (
      <p className="banner" style={{ borderColor: 'var(--line)' }}>
        Saved to <code>{path}</code>, and in effect now — no restart needed.
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
      <strong>{parsed.ok ? 'Works.' : 'Did not work.'}</strong> {parsed.detail}
      {stamp && <span className="meta"> · checked {stamp}</span>}
    </p>
  );
}
