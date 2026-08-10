import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `redirect` is how every one of these actions ends, and it ends them by
 * throwing. Catching it is not a way around that: the address it was handed is
 * the whole result — saved, or refused and why — so it is what gets asserted.
 */
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`redirect: ${url}`), { url });
  },
}));

/** There is no session in a test, and who may save is not what is under test. */
vi.mock('@/lib/auth/guard', () => ({ requireAdminApi: async () => {} }));

import { parseEnvText } from '@/lib/setup/env-file';

import { saveMailbox } from './actions';

/**
 * The mailbox form posts two sets of boxes and means one of them.
 *
 * Both are always in the markup — the stylesheet hides the half you did not
 * pick, it does not remove it — so which half was meant is decided here, by the
 * service menu, and the cost of getting that wrong is silent: a desk that filled
 * in an OAuth client and had `IMAP_HOST=` written for it would fail at the next
 * fetch with a connection error naming a host nobody typed.
 *
 * Written against the real `.env` writer rather than a mock of it. What these
 * are actually about is which keys reach the file, and a mock that records calls
 * would agree with a bug that writes the right names into the wrong file.
 */

let dir: string;
const KEYS = [
  'AAS_ENV_FILE',
  'MAIL_PROVIDER',
  'MAIL_USER',
  'MAIL_PASSWORD',
  'IMAP_HOST',
  'IMAP_PORT',
  'SMTP_HOST',
  'SMTP_PORT',
  'ZOHO_REGION',
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aas-mailbox-'));
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AAS_ENV_FILE = join(dir, '.env');
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  rmSync(dir, { recursive: true, force: true });
});

const ZOHO = {
  service: 'zoho-api',
  address: 'support@acme.com',
  zohoRegion: 'eu',
  zohoClientId: '1000.CLIENT',
  zohoClientSecret: 'shh',
  zohoRefreshToken: '1000.REFRESH',
};

/** Posts the form and hands back the address the action redirected to. */
async function post(fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);

  try {
    await saveMailbox(form);
  } catch (error) {
    const url = (error as { url?: unknown }).url;
    if (typeof url === 'string') return url;
    throw error;
  }
  throw new Error('saveMailbox returned without redirecting');
}

function envFile(): Record<string, string> {
  return parseEnvText(readFileSync(join(dir, '.env'), 'utf8'));
}

describe('connecting a mailbox through Zoho’s API', () => {
  it('writes the provider switch along with the credentials', async () => {
    expect(await post(ZOHO)).toContain('saved=1');
    expect(envFile()).toMatchObject({
      // Without this line the other five are read by nobody: the default
      // provider is IMAP, and it does not know what a refresh token is.
      MAIL_PROVIDER: 'zoho',
      MAIL_USER: 'support@acme.com',
      ZOHO_REGION: 'eu',
      ZOHO_CLIENT_ID: '1000.CLIENT',
      ZOHO_CLIENT_SECRET: 'shh',
      ZOHO_REFRESH_TOKEN: '1000.REFRESH',
    });
  });

  it('does not write a single IMAP setting on the way past', async () => {
    await post(ZOHO);
    const written = envFile();
    for (const key of ['IMAP_HOST', 'IMAP_PORT', 'SMTP_HOST', 'SMTP_PORT', 'MAIL_PASSWORD']) {
      expect(written, key).not.toHaveProperty(key);
    }
  });

  it('leaves hosts already in the file where they are, so switching back is free', async () => {
    writeFileSync(join(dir, '.env'), 'IMAP_HOST=imap.zoho.com\nSMTP_HOST=smtp.zoho.com\n');
    await post(ZOHO);
    expect(envFile()).toMatchObject({
      MAIL_PROVIDER: 'zoho',
      IMAP_HOST: 'imap.zoho.com',
      SMTP_HOST: 'smtp.zoho.com',
    });
  });

  /**
   * The rule the password beside them has always followed. Neither secret is
   * ever sent back to the browser, so every visit to this form posts them
   * blank — and a blank box read as "clear it" would lock the desk out of its
   * own mailbox for the crime of correcting a typo in the client id.
   */
  it('keeps the stored secrets when the boxes come back empty', async () => {
    await post(ZOHO);
    await post({ ...ZOHO, zohoClientId: '1000.FIXED', zohoClientSecret: '', zohoRefreshToken: '' });

    expect(envFile()).toMatchObject({
      ZOHO_CLIENT_ID: '1000.FIXED',
      ZOHO_CLIENT_SECRET: 'shh',
      ZOHO_REFRESH_TOKEN: '1000.REFRESH',
    });
  });

  it('refuses a save with no refresh token stored or typed', async () => {
    const url = await post({ ...ZOHO, zohoRefreshToken: '' });
    expect(url).toContain('error=');
    expect(url).not.toContain('saved=1');
  });

  /**
   * The menu cannot produce this; a hand-posted form can. It is worth its own
   * refusal because it is the one mistake here that does not fail as itself —
   * Zoho's data centres share no credentials, so a token pointed at the wrong
   * one comes back as `invalid_code`, which is exactly what a wrong secret
   * comes back as.
   */
  it('refuses a data centre Zoho does not have', async () => {
    const url = await post({ ...ZOHO, zohoRegion: 'us' });
    expect(url).toContain('error=');
    expect(decodeURIComponent(url)).toContain('ZOHO_REGION');
  });
});

describe('connecting a mailbox over IMAP', () => {
  /**
   * The half of the branch that already worked, kept honest. The Zoho fields
   * are posted on this path too — hidden, not removed — and picking them up
   * here would write an OAuth client into a desk that asked for a password.
   */
  it('is still what an IMAP line of the menu saves, whatever else was posted', async () => {
    await post({
      service: 'fastmail',
      address: 'support@acme.com',
      password: 'app-password',
      imapHost: '',
      smtpHost: '',
      zohoClientId: '1000.CLIENT',
      zohoRefreshToken: '1000.REFRESH',
    });

    const written = envFile();
    expect(written).toMatchObject({
      MAIL_PROVIDER: 'imap-smtp',
      MAIL_USER: 'support@acme.com',
      MAIL_PASSWORD: 'app-password',
      // Empty boxes under a chosen service mean "wherever that service answers".
      IMAP_HOST: 'imap.fastmail.com',
      SMTP_HOST: 'smtp.fastmail.com',
    });
    expect(written).not.toHaveProperty('ZOHO_CLIENT_ID');
    expect(written).not.toHaveProperty('ZOHO_REFRESH_TOKEN');
  });
});
