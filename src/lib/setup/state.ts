import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDb, type Db } from '../db';
import { getMeta, setMeta } from '../db/meta';
import { countActiveOperators } from '../operators/store';
import { listRules } from '../rules/store';
import { listTasks } from '../tasks/store';

/**
 * Which of the four things this install still needs.
 *
 * Derived from the configuration itself, never from a "step" counter. A
 * counter drifts the moment someone edits `.env` by hand, deploys a
 * pre-configured container, or reruns the wizard to change one field — and a
 * wizard that insists you are on step 2 when step 2 is already done is worse
 * than no wizard. Every step is idempotent and independently revisitable
 * because of this.
 */

export const SETUP_DONE = 'setup.completedAt';

export const SETUP_STEPS = ['access', 'model', 'mailbox', 'voice'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface StepStatus {
  step: SetupStep;
  title: string;
  href: string;
  done: boolean;
  /** True when the step can be skipped without breaking the others. */
  optional: boolean;
}

export interface SetupState {
  steps: StepStatus[];
  /** The first unfinished step, or null when there is nothing left to do. */
  next: SetupStep | null;
  /** Set once the user has reached the end, even with steps skipped. */
  completedAt: string | null;
  /** True for an install with no password, no model, no mailbox and no data. */
  untouched: boolean;
}

function set(name: string): boolean {
  return (process.env[name]?.trim() ?? '') !== '';
}

function hasMailbox(): boolean {
  const provider = (process.env.MAIL_PROVIDER?.trim() ?? 'imap-smtp').toLowerCase();
  if (provider.startsWith('g')) {
    return set('GOOGLE_REFRESH_TOKEN') || set('GOOGLE_PRIVATE_KEY');
  }
  // Zoho is configured by hand — its OAuth consent is not in the wizard — but
  // a desk that has done it must not be told for ever that it has no mailbox.
  if (provider === 'zoho') {
    return set('ZOHO_REFRESH_TOKEN') && set('ZOHO_CLIENT_ID') && set('MAIL_USER');
  }
  return set('IMAP_HOST') && set('MAIL_USER') && set('MAIL_PASSWORD');
}

function hasVoice(): boolean {
  // The organisation name is the one field with no usable default: every
  // other workspace setting has a sane fallback, and this one becomes the
  // literal phrase "you work for our company" in the prompt.
  return set('AAS_ORGANIZATION') || hasConfigFile();
}

function hasConfigFile(): boolean {
  try {
    const path = process.env.AAS_CONFIG?.trim() || resolve(process.cwd(), 'aas.config.json');
    const parsed = JSON.parse(
      readFileSync(/* turbopackIgnore: true */ path, 'utf8'),
    ) as { organization?: unknown };
    return typeof parsed.organization === 'string' && parsed.organization.trim() !== '';
  } catch {
    return false;
  }
}

export function setupState(db: Db = getDb()): SetupState {
  const steps: StepStatus[] = [
    {
      step: 'access',
      title: 'Lock the door',
      href: '/setup',
      // Either way of locking it counts. An install where four people sign in
      // by name and no shared password exists is not half-configured, and a
      // wizard that keeps insisting otherwise is a wizard people stop reading.
      done: set('ADMIN_PASSWORD') || countActiveOperators(db) > 0,
      optional: true,
    },
    { step: 'model', title: 'Pick a model', href: '/setup/model', done: set('AI_MODEL'), optional: false },
    {
      step: 'mailbox',
      title: 'Connect the mailbox',
      href: '/setup/mailbox',
      done: hasMailbox(),
      optional: true,
    },
    { step: 'voice', title: 'Say who you are', href: '/setup/voice', done: hasVoice(), optional: true },
  ];

  const empty = listTasks({ limit: 1 }, db).length === 0 && listRules({}, db).length === 0;

  return {
    steps,
    next: steps.find(s => !s.done)?.step ?? null,
    completedAt: getMeta(SETUP_DONE, db),
    untouched: empty && steps.every(s => !s.done),
  };
}

export function markSetupDone(db: Db = getDb()): void {
  setMeta(SETUP_DONE, new Date().toISOString(), db);
}

/**
 * Whether to send someone to the wizard instead of an empty inbox.
 *
 * Only for an install that has never been configured or used, and only until
 * they finish or dismiss it once. Nobody should be redirected out of their own
 * inbox because they deleted their last rule.
 */
export function shouldOnboard(db: Db = getDb()): boolean {
  const state = setupState(db);
  return state.completedAt === null && state.untouched;
}
