'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';

import { requireApi } from '@/lib/auth/guard';
import { setSessionCookie } from '@/lib/auth/cookie';
import { setMeta } from '@/lib/db/meta';
import { isLocale, t } from '@/lib/i18n';
import { createOperator } from '@/lib/operators/store';
import { checkAi, checkMailbox, type CheckResult } from '@/lib/setup/checks';
import { saveEnv } from '@/lib/setup/env-file';
import { markSetupDone } from '@/lib/setup/state';
import { saveWorkspaceConfig } from '@/lib/setup/workspace-file';

/**
 * Every step is a plain form post that saves, then redirects to itself with a
 * result in the query string — the same pattern as the rest of the app, and
 * the reason the wizard survives a reload, works with JavaScript off, and can
 * be re-run to change one field without starting again.
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** `saved=1`, or the write error, so the page can offer the paste-it fallback. */
function outcome(result: { saved: boolean; error?: string }): string {
  return result.saved ? 'saved=1' : `unwritable=${encodeURIComponent(result.error ?? 'unknown')}`;
}

export async function saveAccess(form: FormData): Promise<void> {
  await requireApi();

  const password = text(form, 'password');
  if (password.length < 8) {
    redirect('/setup?error=' + encodeURIComponent(t('setup.actions.passwordTooShort')));
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

  redirect(`/setup?${outcome(result)}`);
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
  await requireApi();

  const name = text(form, 'name');
  const password = text(form, 'password');

  if (!name) redirect('/setup?error=' + encodeURIComponent(t('setup.actions.operatorNeedsName')));
  if (password.length < 8) {
    redirect('/setup?error=' + encodeURIComponent(t('setup.actions.passwordTooShort')));
  }

  let operator;
  try {
    operator = createOperator(name, password);
  } catch {
    redirect('/setup?error=' + encodeURIComponent(t('setup.actions.operatorNameTaken')));
  }

  // Same reason the password step does it: adding the first operator turns the
  // login wall on, and the person who just typed their password should not be
  // asked for it again ten seconds later.
  await setSessionCookie(operator.id);

  redirect('/setup?saved=1');
}

export async function saveModel(form: FormData): Promise<void> {
  await requireApi();

  const provider = text(form, 'provider') === 'anthropic' ? 'anthropic' : 'openai-compatible';
  const model = text(form, 'model');
  const baseUrl = text(form, 'baseUrl');
  const apiKey = text(form, 'apiKey');

  if (!model) redirect('/setup/model?error=' + encodeURIComponent(t('setup.actions.modelRequired')));

  const result = saveEnv({
    AI_PROVIDER: provider,
    AI_MODEL: model,
    AI_BASE_URL: baseUrl || null,
    // Blank means "keep what is there": the field is rendered empty on every
    // visit because a stored key is never sent back to the browser, and
    // revisiting this page to change the model must not wipe the key.
    ...(apiKey ? { AI_API_KEY: apiKey } : {}),
  });

  redirect(`/setup/model?${outcome(result)}`);
}

export async function saveMailbox(form: FormData): Promise<void> {
  await requireApi();

  const address = text(form, 'address');
  const password = text(form, 'password');
  const imapHost = text(form, 'imapHost');
  const smtpHost = text(form, 'smtpHost');

  if (!address || !imapHost || !smtpHost) {
    redirect(
      '/setup/mailbox?error=' + encodeURIComponent(t('setup.actions.mailboxFieldsRequired')),
    );
  }

  const result = saveEnv({
    MAIL_PROVIDER: 'imap-smtp',
    MAIL_USER: address,
    IMAP_HOST: imapHost,
    IMAP_PORT: text(form, 'imapPort') || null,
    SMTP_HOST: smtpHost,
    SMTP_PORT: text(form, 'smtpPort') || null,
    ...(password ? { MAIL_PASSWORD: password } : {}),
  });

  redirect(`/setup/mailbox?${outcome(result)}`);
}

export async function saveVoice(form: FormData): Promise<void> {
  await requireApi();

  const organization = text(form, 'organization');
  if (!organization) {
    redirect('/setup/voice?error=' + encodeURIComponent(t('setup.actions.organizationRequired')));
  }

  const facts = text(form, 'facts')
    .split('\n')
    .map(line => line.replace(/^[-*\s]+/, '').trim())
    .filter(line => line !== '');

  const result = saveWorkspaceConfig({
    organization,
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

  redirect(`/setup/voice?${outcome(result)}`);
}

/**
 * The test buttons.
 *
 * The verdict is stored rather than passed back in the query string, so that
 * "the model answered at 14:02" is still on the page tomorrow. Someone
 * debugging a mailbox at midnight should be able to see whether it ever
 * worked, not just whether it works during the four seconds after they click.
 */
async function record(step: 'model' | 'mailbox', run: () => Promise<CheckResult>): Promise<void> {
  const result = await run();
  setMeta(`setup.check.${step}`, JSON.stringify({ ...result, at: new Date().toISOString() }));
  redirect(`/setup/${step}#result`);
}

export async function testModel(): Promise<void> {
  await requireApi();
  await record('model', checkAi);
}

export async function testMailbox(): Promise<void> {
  await requireApi();
  await record('mailbox', checkMailbox);
}

/** Leaves the wizard for good — the redirect on an empty inbox stops after this. */
export async function finishSetup(): Promise<void> {
  await requireApi();
  markSetupDone();
  redirect('/');
}
