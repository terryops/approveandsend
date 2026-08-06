import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resetWorkspaceConfig, type WorkspaceConfig } from '../config/workspace';

/**
 * Writes `aas.config.json`, keeping any keys this app does not know about.
 *
 * Same contract as the `.env` writer: the file stays the operator's, readable
 * and hand-editable, and the wizard only touches the fields it asked about.
 */

export function workspaceFilePath(): string {
  return process.env.AAS_CONFIG?.trim() || resolve(process.cwd(), 'aas.config.json');
}

export interface WorkspaceSaveResult {
  path: string;
  saved: boolean;
  error?: string;
  /** The file as it would have been written, for a read-only deployment. */
  manual: string;
}

export function saveWorkspaceConfig(update: Partial<WorkspaceConfig>): WorkspaceSaveResult {
  const path = workspaceFilePath();

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(/* turbopackIgnore: true */ path, 'utf8')) as Record<string, unknown>;
  } catch {
    // Missing or unparseable. Neither is worth failing over: the wizard is
    // how someone recovers from the second one.
  }

  // `undefined` means "not asked about"; an empty string means "cleared", and
  // the difference matters for `signature` and `product`.
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') delete merged[key];
    else merged[key] = value;
  }

  const manual = `${JSON.stringify(merged, null, 2)}\n`;

  try {
    const temp = `${path}.tmp`;
    writeFileSync(temp, manual, 'utf8');
    renameSync(temp, path);
    resetWorkspaceConfig();
    return { path, saved: true, manual };
  } catch (error) {
    resetWorkspaceConfig();
    return { path, saved: false, error: (error as Error).message, manual };
  }
}
