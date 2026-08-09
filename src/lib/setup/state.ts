import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDb, type Db } from '../db';
import { getMeta, setMeta } from '../db/meta';
import { deskUntouched } from '../desk/untouched';
import { countActiveOperators } from '../operators/store';

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
      // Not optional, whatever the sample data suggests. A desk with no mailbox
      // has nothing to draft from and nowhere to send what it drafts: every
      // button on the inbox either fetches or sends. Loading the demo is a way
      // to look at the thing, not a way to run it.
      optional: false,
    },
    { step: 'voice', title: 'Say who you are', href: '/setup/voice', done: hasVoice(), optional: true },
  ];

  // "Has anybody used this yet?" — the same question the inbox asks before it
  // offers to invent an inbox, and now literally the same function. See
  // `deskUntouched`.
  return {
    steps,
    next: steps.find(s => !s.done)?.step ?? null,
    completedAt: getMeta(SETUP_DONE, db),
    untouched: deskUntouched(db) && steps.every(s => !s.done),
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

/**
 * Which of its two shapes `/setup` is wearing: the settings screen, or the
 * wizard.
 *
 * They are the same four subjects and they are not the same screen. A wizard is
 * a sequence — numbered, one thing per page, a forward move at the bottom —
 * because the person reading it does not yet know what the four things are. A
 * month later that same person knows exactly what they came for, and walking
 * them past "Step 1 of 4: lock the door" to change a reply language is the
 * interface asking them to re-do an introduction.
 *
 * Not `!shouldOnboard()`, which stops being true the moment the password is
 * set — that would flip the shape underneath somebody in the middle of the
 * wizard, at step two. The wizard holds until it is finished, and a desk that
 * has mail or a rulebook has plainly been running without it: `shouldOnboard`
 * only ever redirects an install that is both unconfigured and unused, so a
 * hand-configured deployment reaches this screen with `completedAt` still null
 * and would otherwise be offered the tour for ever.
 */
export function settingsMode(db: Db = getDb()): boolean {
  if (getMeta(SETUP_DONE, db) !== null) return true;
  return !deskUntouched(db);
}

/**
 * Where a step's own screen is, in whichever shape is current.
 *
 * One function because three callers have to agree on it: the redirect after a
 * form saves, the redirect after a Test button, and the step pages themselves.
 * In the wizard a step is a page; on the settings screen it is a section of one
 * page, so the same destination is a fragment and the notice needs `where` to
 * know which section to appear in.
 */
/**
 * Sections that exist on the settings screen and nowhere else.
 *
 * Not steps, and deliberately not made into steps. A step is something an
 * install is incomplete without, and the wizard's honesty depends on that
 * meaning something — a fifth numbered page for a payment processor most desks
 * do not use would make "1 of 5" a worse promise than "1 of 4". Billing is
 * connected by somebody who already has a working desk and has decided they
 * want their drafts to know who is paying.
 */
export type SettingsSection = 'billing';

/**
 * One entry in the settings screen's left-hand directory, and one thing that
 * can be showing on its right.
 *
 * The four steps in the order the wizard asks them, then the two subjects that
 * were never steps. One list rather than three, because the menu is this array
 * read top to bottom and the pane is whichever of these names is in `where` —
 * so a subject that is in the menu and not renderable, or renderable and not in
 * the menu, is not a state this screen can get into.
 */
export type SettingsPane = SetupStep | SettingsSection | 'running';

export const SETTINGS_PANES: readonly SettingsPane[] = [...SETUP_STEPS, 'billing', 'running'];

/** Whether a hand-typed `?where=` names a pane this screen actually has. */
export function isSettingsPane(value: string | null): value is SettingsPane {
  return value !== null && (SETTINGS_PANES as readonly string[]).includes(value);
}

/**
 * Where a pane of the settings screen is.
 *
 * A query parameter rather than a fragment, and that is the whole of the change
 * this screen's shape asked for: the server decides which subject is rendered,
 * and a fragment is the one part of a URL a server never sees. `#model` on a
 * screen showing one section at a time is a link that lands on the access
 * settings and scrolls to nothing.
 *
 * `where` keeps its name and its second job. It still says which form a save
 * notice belongs to — there is simply only ever one form on the screen to hand
 * it to now.
 *
 * The fragment is still worth having for what a fragment is actually for:
 * `anchor` is a place *within* a pane, which is how a Test button lands on the
 * verdict it just wrote rather than on the top of the form that produced it.
 */
export function paneHref(pane: SettingsPane, query = '', anchor = ''): string {
  return `/setup?${query ? `${query}&` : ''}where=${pane}${anchor ? `#${anchor}` : ''}`;
}

/** Where a settings-only section is. The same shape `stepHref` returns. */
export function sectionHref(section: SettingsSection, query = ''): string {
  return paneHref(section, query);
}

export function stepHref(step: SetupStep, query = '', db: Db = getDb()): string {
  if (settingsMode(db)) return paneHref(step, query);
  const path = step === 'access' ? '/setup' : `/setup/${step}`;
  return query ? `${path}?${query}` : path;
}
