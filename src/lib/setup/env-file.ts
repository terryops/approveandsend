import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resetAiConfig } from '../ai';
import { resetWorkspaceConfig } from '../config/workspace';
import { resetMailProvider } from '../mail/config';

/**
 * The setup wizard is a typist, not a storage layer.
 *
 * Everything it collects goes into the two files an operator would have edited
 * by hand — `.env` and `aas.config.json` — in the format documented in
 * `.env.example`. Nothing lands in a table only the wizard can read. That is
 * the property worth protecting: you can finish the wizard, delete it, and
 * still have a working, inspectable, `git diff`-able installation.
 *
 * Which means this file has one job and has to do it carefully: change the
 * keys it was asked to change, and leave every comment, blank line, ordering
 * choice and unrelated variable exactly as it found them. A settings screen
 * that reformats your config file is one you stop trusting with it.
 */

export function envFilePath(): string {
  return process.env.AAS_ENV_FILE?.trim() || resolve(process.cwd(), '.env');
}

/** Values needing quotes: anything a naive `KEY=value` line would mangle. */
function encode(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function decode(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

const ASSIGNMENT = /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = ASSIGNMENT.exec(line);
    if (match) out[match[2]!] = decode(match[3]!);
  }
  return out;
}

/**
 * Rewrites assignments in place; appends the rest.
 *
 * A key that exists as a commented-out template line (`# AI_MODEL=`, which is
 * most of `.env.example`) is uncommented where it stands, so the value ends up
 * next to the paragraph explaining it rather than orphaned at the bottom.
 */
export function mergeEnvText(existing: string, updates: Record<string, string | null>): string {
  const pending = new Map(Object.entries(updates));
  const lines = existing === '' ? [] : existing.split('\n');

  const rewritten = lines.map(line => {
    const bare = line.replace(/^\s*#\s?/, '');
    const commented = bare !== line;
    const match = ASSIGNMENT.exec(bare);
    if (!match) return line;

    const key = match[2]!;
    if (!pending.has(key)) return line;

    const value = pending.get(key)!;
    pending.delete(key);

    // Removing a key that was only ever a commented template leaves the
    // template alone — there is nothing to remove and the comment is useful.
    if (value === null) return commented ? line : `# ${key}=`;
    return `${match[1] ?? ''}${key}=${encode(value)}`;
  });

  const added = [...pending].filter((entry): entry is [string, string] => entry[1] !== null);
  if (added.length > 0) {
    if (rewritten.length > 0 && rewritten[rewritten.length - 1]!.trim() !== '') rewritten.push('');
    rewritten.push('# Added by the setup wizard.');
    for (const [key, value] of added) rewritten.push(`${key}=${encode(value)}`);
    rewritten.push('');
  }

  return rewritten.join('\n');
}

/**
 * Makes the change visible to the process that is running right now.
 *
 * Next reads `.env` once at boot, so a file write alone would leave the
 * operator staring at a wizard that saved their API key and still says it is
 * not configured. Every cached reader is dropped at the same time.
 */
export function applyEnv(updates: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }

  resetAiConfig();
  resetWorkspaceConfig();
  void resetMailProvider();
}

export interface SaveResult {
  path: string;
  /** False when the file could not be written — see `manual`. */
  saved: boolean;
  /** Why not, in words an operator can act on. */
  error?: string;
  /** The lines to paste, for a deployment whose config is not a writable file. */
  manual: string;
}

/**
 * Writes `.env`, then applies the values in-process regardless.
 *
 * Read-only containers and env-var-only platforms are normal deployments, not
 * mistakes, so a failed write is not an error state: the values still take
 * effect for this process, and the caller is handed the exact lines to put
 * wherever that deployment keeps its configuration.
 */
export function saveEnv(updates: Record<string, string | null>): SaveResult {
  const path = envFilePath();
  const manual = Object.entries(updates)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}=${encode(value)}`)
    .join('\n');

  let saved = true;
  let error: string | undefined;

  try {
    let existing = '';
    try {
      existing = readFileSync(/* turbopackIgnore: true */ path, 'utf8');
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
    }

    // Write-then-rename: an interrupted save must not be able to leave a
    // half-written `.env`, which is the one file that would stop the app from
    // starting again.
    const temp = `${path}.tmp`;
    writeFileSync(temp, mergeEnvText(existing, updates), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (writeError) {
    saved = false;
    error = (writeError as Error).message;
  }

  applyEnv(updates);

  return { path, saved, manual, ...(error ? { error } : {}) };
}
