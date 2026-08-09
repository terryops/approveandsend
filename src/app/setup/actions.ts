'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';

import { endpoint, suggestedModel } from '@/lib/ai/endpoints';
import { CLI_MODEL_DEFAULT, isCliKind, type CliKind } from '@/lib/ai/providers/cli';
import { requireAdminApi } from '@/lib/auth/guard';
import { setSessionCookie } from '@/lib/auth/cookie';
import { stripeKey } from '@/lib/billing/stripe';
import { resetContextSources } from '@/lib/context/registry';
import { setMeta } from '@/lib/db/meta';
import { isLocale, t } from '@/lib/i18n';
import { mailHost } from '@/lib/mail/hosts';
import { createOperator } from '@/lib/operators/store';
import { checkAi, checkMailbox, checkStripe, type Checkable, type CheckResult } from '@/lib/setup/checks';
import { resetCliDetection } from '@/lib/setup/cli-detect';
import { saveEnv } from '@/lib/setup/env-file';
import {
  markSetupDone,
  paneHref,
  sectionHref,
  settingsMode,
  stepHref,
  type SettingsSection,
  type SetupStep,
} from '@/lib/setup/state';
import { saveWorkspaceConfig } from '@/lib/setup/workspace-file';

/**
 * Every step is a plain form post that saves, then redirects to itself with a
 * result in the query string — the same pattern as the rest of the app, and
 * the reason the wizard survives a reload, works with JavaScript off, and can
 * be re-run to change one field without starting again.
 *
 * "Itself" is two addresses, because the same form is a page of the wizard and
 * a section of the settings screen. `stepHref` knows which is current; nothing
 * in here hardcodes a path.
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** `saved=1`, or the write error, so the page can offer the paste-it fallback. */
function outcome(result: { saved: boolean; error?: string }): string {
  return result.saved ? 'saved=1' : `unwritable=${encodeURIComponent(result.error ?? 'unknown')}`;
}

/** Back to the form that was just posted, carrying the reason it was refused. */
function rejected(step: SetupStep | SettingsSection, message: string): string {
  const query = `error=${encodeURIComponent(message)}`;
  return step === 'billing' ? sectionHref(step, query) : stepHref(step, query);
}

export async function saveAccess(form: FormData): Promise<void> {
  await requireAdminApi();

  const password = text(form, 'password');
  if (password.length < 8) {
    redirect(rejected('access', t('setup.actions.passwordTooShort')));
  }

  const result = saveEnv({
    ADMIN_PASSWORD: password,
    // A cron token now, or the operator writes one later under time pressure
    // and picks something memorable. This one is neither memorable nor theirs.
    ...(process.env.CRON_TOKEN?.trim() ? {} : { CRON_TOKEN: randomBytes(24).toString('base64url') }),
  });

  // Setting a password turns the login wall on, and the person who just set it
  // has no cookie — without this they are bounced to /login mid-wizard and
  // have to type the password they typed ten seconds ago.
  await setSessionCookie();

  redirect(stepHref('access', outcome(result)));
}

/**
 * The other way to lock the door: put a name on it.
 *
 * Same step as the shared password rather than a fifth one, because they
 * answer the same question. This one answers it better — a reply that went out
 * under a name can be traced back to a person — so it is offered here rather
 * than hidden on a page nobody visits until something has already gone wrong.
 */
export async function saveFirstOperator(form: FormData): Promise<void> {
  await requireAdminApi();

  const name = text(form, 'name');
  const password = text(form, 'password');

  if (!name) redirect(rejected('access', t('setup.actions.operatorNeedsName')));
  if (password.length < 8) {
    redirect(rejected('access', t('setup.actions.passwordTooShort')));
  }

  let operator;
  try {
    operator = createOperator(name, password);
  } catch {
    redirect(rejected('access', t('setup.actions.operatorNameTaken')));
  }

  // Same reason the password step does it: adding the first operator turns the
  // login wall on, and the person who just typed their password should not be
  // asked for it again ten seconds later.
  await setSessionCookie(operator.id);

  redirect(stepHref('access', 'saved=1'));
}

/**
 * One menu of services, taken apart into the three things `.env` keeps.
 *
 * The menu says DeepSeek; the file says `openai-compatible` and an address, and
 * `AI_PROVIDER=cli` needs a second answer — which CLI — that would be a control
 * meaning nothing for every other line if it were its own select. So the menu
 * carries an id and this looks it up, which also means an unrecognised post
 * falls back to the same safe default the field has always had rather than
 * writing a provider `buildProvider` will refuse on the next request.
 */
function chosenProvider(raw: string): {
  provider: string;
  cli: CliKind | null;
  baseUrl: string;
} {
  const entry = endpoint(raw);
  if (!entry) return { provider: 'openai-compatible', cli: null, baseUrl: '' };
  return {
    provider: entry.wire,
    cli: entry.cli ?? null,
    baseUrl: entry.baseUrl,
  };
}

export async function saveModel(form: FormData): Promise<void> {
  await requireAdminApi();

  const chosen = text(form, 'provider');
  const { provider, cli, baseUrl: known } = chosenProvider(chosen);
  // The menu, then the box under it for a name that was not on the menu. A
  // model name has no default anywhere else in this app, because guessing one
  // is worse than refusing; a CLI is the exception, since it has already been
  // pointed at a model by whoever logged it in, so nothing chosen there means
  // "keep using that" rather than the omission it would be above an endpoint.
  const model = text(form, 'model') || text(form, 'modelCustom') || (cli ? CLI_MODEL_DEFAULT : '');
  // An empty address is the service's own, not an omission: the menu knows
  // where DeepSeek answers, and a browser with no scripts has not filled the
  // box in. Somebody who wants the built-in default for their dialect picks the
  // custom line, which is the one that knows no address.
  const baseUrl = text(form, 'baseUrl') || known;
  const apiKey = text(form, 'apiKey');

  if (!model) redirect(rejected('model', t('setup.actions.modelRequired')));

  const result = saveEnv({
    AI_PROVIDER: provider,
    // Null clears the line. Leaving a stale AI_CLI behind an OpenAI endpoint is
    // harmless until the day somebody switches back and gets the other CLI.
    AI_CLI: cli,
    AI_MODEL: model,
    AI_BASE_URL: baseUrl || null,
    // Blank means "keep what is there": the field is rendered empty on every
    // visit because a stored key is never sent back to the browser, and
    // revisiting this page to change the model must not wipe the key.
    ...(apiKey ? { AI_API_KEY: apiKey } : {}),
  });

  resetCliDetection();
  redirect(stepHref('model', outcome(result)));
}

/**
 * The one-click version of the three lines above.
 *
 * Somebody who has no API key and does have a Claude or ChatGPT subscription
 * should not have to learn what `AI_PROVIDER` is to use it. The screen has
 * already found the login and named it; the whole row saying so is this button,
 * and it writes the same `.env` the menu would.
 *
 * `AI_MODEL` gets the same name the form's own box would have offered — see
 * `SUGGESTED_MODELS` — and falls back to the sentinel for a CLI we have no
 * suggestion for. This used to write the sentinel outright, on the argument that
 * the CLI has already been pointed at a model by whoever logged it in and a name
 * written here would overrule that with one that goes stale. What it also did
 * was leave the model box reading `default` next to a heading that says which
 * model is drafting, which answers the question with a word rather than a model.
 * A name that can be read, edited and tested beats a sentinel that cannot; the
 * sentinel is still honoured on the way in, so an `.env` that has one keeps
 * working.
 */
export async function useSubscription(form: FormData): Promise<void> {
  await requireAdminApi();

  const kind = text(form, 'cli');
  if (!isCliKind(kind)) redirect(rejected('model', t('setup.actions.modelRequired')));

  const result = saveEnv({
    AI_PROVIDER: 'cli',
    AI_CLI: kind,
    AI_MODEL: suggestedModel(`cli:${kind}`) || CLI_MODEL_DEFAULT,
  });

  resetCliDetection();
  redirect(stepHref('model', outcome(result)));
}

/**
 * One menu of services, taken apart into the four things `.env` keeps.
 *
 * `chosenProvider`'s counterpart a step later, and it exists for the same
 * reason: an empty host box under a chosen service is not an omission but
 * "wherever that service answers", which is how the menu keeps working in a
 * browser that never ran its script. An unrecognised post — or the "other"
 * line, which knows no hosts — contributes nothing and leaves the boxes to
 * speak for themselves.
 */
function chosenService(raw: string): {
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
} {
  const entry = mailHost(raw);
  return {
    imapHost: entry?.imapHost ?? '',
    imapPort: entry?.imapPort ? String(entry.imapPort) : '',
    smtpHost: entry?.smtpHost ?? '',
    smtpPort: entry?.smtpPort ? String(entry.smtpPort) : '',
  };
}

export async function saveMailbox(form: FormData): Promise<void> {
  await requireAdminApi();

  const address = text(form, 'address');
  const password = text(form, 'password');
  const known = chosenService(text(form, 'service'));
  const imapHost = text(form, 'imapHost') || known.imapHost;
  const smtpHost = text(form, 'smtpHost') || known.smtpHost;

  if (!address || !imapHost || !smtpHost) {
    redirect(rejected('mailbox', t('setup.actions.mailboxFieldsRequired')));
  }

  // A port only follows the menu when its own host did. Filling in Gmail's 993
  // beside a hostname somebody typed themselves would be this form inventing
  // half a configuration out of a line of the menu it did not use.
  const imapPort = text(form, 'imapPort') || (imapHost === known.imapHost ? known.imapPort : '');
  const smtpPort = text(form, 'smtpPort') || (smtpHost === known.smtpHost ? known.smtpPort : '');

  const result = saveEnv({
    MAIL_PROVIDER: 'imap-smtp',
    MAIL_USER: address,
    IMAP_HOST: imapHost,
    IMAP_PORT: imapPort || null,
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort || null,
    ...(password ? { MAIL_PASSWORD: password } : {}),
  });

  redirect(stepHref('mailbox', outcome(result)));
}

export async function saveVoice(form: FormData): Promise<void> {
  await requireAdminApi();

  const organization = text(form, 'organization');
  if (!organization) {
    redirect(rejected('voice', t('setup.actions.organizationRequired')));
  }

  const facts = text(form, 'facts')
    .split('\n')
    .map(line => line.replace(/^[-*\s]+/, '').trim())
    .filter(line => line !== '');

  const result = saveWorkspaceConfig({
    organization,
    // The label on the tool, not a fact about the business — the only field on
    // this form the drafter never sees. Blank restores the product's own name,
    // which is why it is not defaulted to the organisation: a desk that clears
    // the box is asking for the default back, not for its own name again.
    appName: text(form, 'appName'),
    product: text(form, 'product'),
    voice: text(form, 'voice'),
    signature: text(form, 'signature'),
    replyLanguage: text(form, 'replyLanguage') || 'match',
    // Empty is meaningful here — it is how the feature stays off — so unlike
    // replyLanguage there is no default to fall back to.
    reviewLanguage: text(form, 'reviewLanguage'),
    // A tag the dictionaries do not answer would render the whole UI in
    // English anyway; refusing it here keeps the config file honest about
    // what is actually on screen.
    language: isLocale(text(form, 'language')) ? text(form, 'language') : 'en',
    facts,
  });

  redirect(stepHref('voice', outcome(result)));
}

/**
 * Telling the desk it may look at the money.
 *
 * The checkbox is the whole reason this is not just a key field. Somebody who
 * wants their drafts to stop knowing what a customer pays — for an afternoon,
 * for a demo, for a screen-share with someone outside the company — should not
 * have to delete a credential to do it, because the way that ends is with the
 * key never going back.
 */
export async function saveStripe(form: FormData): Promise<void> {
  await requireAdminApi();

  const apiKey = text(form, 'apiKey');
  const enabled = form.get('enabled') !== null;

  // Nothing typed and nothing stored is somebody pressing Save on an empty
  // form; turning the switch on for a key that does not exist would put the
  // desk in a state that reports itself as connected and answers nothing.
  if (!apiKey && !stripeKey()) {
    redirect(rejected('billing', t('setup.actions.stripeKeyRequired')));
  }

  const result = saveEnv({
    // Same rule as the model's key and the mailbox password: blank means keep.
    // The field is rendered empty on every visit because a stored secret is
    // never sent back to the browser, so tickng the checkbox must not be a way
    // to wipe the key.
    ...(apiKey ? { STRIPE_API_KEY: apiKey } : {}),
    STRIPE_ENABLED: enabled ? '1' : '0',
  });

  // A source is loaded once and cached, and the cache was built when there was
  // no key. Without this the operator saves a key, sees the section say it is
  // connected, and gets billing on no task until the server is restarted.
  resetContextSources();

  redirect(sectionHref('billing', outcome(result)));
}

/**
 * The test buttons.
 *
 * The verdict is stored rather than passed back in the query string, so that
 * "the model answered at 14:02" is still on the page tomorrow. Someone
 * debugging a mailbox at midnight should be able to see whether it ever
 * worked, not just whether it works during the four seconds after they click.
 */
async function record(step: Checkable, run: () => Promise<CheckResult>): Promise<void> {
  const result = await run();
  setMeta(`setup.check.${step}`, JSON.stringify({ ...result, at: new Date().toISOString() }));
  // Straight to the verdict it just wrote. In the wizard that is a fragment on
  // the step's own page; on the settings screen the pane has to be asked for as
  // well, because which subject is on screen is now a question the server
  // answers and a fragment is the half of a URL it never receives. Billing has
  // no wizard page, so its verdict is always on the settings screen — and the
  // pane it lives in is called billing while the check is called stripe.
  if (step === 'stripe') redirect(paneHref('billing', '', 'billing-check'));
  if (settingsMode()) redirect(paneHref(step, '', `${step}-check`));
  redirect(`/setup/${step}#${step}-check`);
}

export async function testModel(): Promise<void> {
  await requireAdminApi();
  await record('model', checkAi);
}

export async function testMailbox(): Promise<void> {
  await requireAdminApi();
  await record('mailbox', checkMailbox);
}

export async function testStripe(): Promise<void> {
  await requireAdminApi();
  await record('stripe', checkStripe);
}

/** Leaves the wizard for good — the redirect on an empty inbox stops after this. */
export async function finishSetup(): Promise<void> {
  await requireAdminApi();
  markSetupDone();
  redirect('/');
}
