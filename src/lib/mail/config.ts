import { parseAddress } from './address';
import { normalizePrivateKey, type GoogleAuthConfig } from './providers/google/auth';
import { GmailProvider, type GmailConfig } from './providers/google/gmail';
import { ImapSmtpProvider, type ImapSmtpConfig } from './providers/imap-smtp';
import { isZohoRegion, ZOHO_REGIONS } from './providers/zoho/auth';
import { ZohoProvider, type ZohoConfig } from './providers/zoho/zoho';
import type { MailProvider } from './types';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} is required (see .env.example)`);
  return v;
}

function port(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a valid port, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Defaults to true. Implicit TLS is the safe choice, and someone who needs
 * STARTTLS on 587 or a plaintext dev server has to say so explicitly rather
 * than accidentally shipping credentials in the clear.
 */
function secure(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

/**
 * Whether replies carry an HTML part alongside the text one.
 *
 * On unless someone turns it off. A desk with a house style of plain text —
 * they exist, and they are usually right — sets `MAIL_REPLY_HTML=false` and
 * gets exactly what the reviewer approved and nothing else.
 */
export function sendsHtmlReplies(): boolean {
  return secure('MAIL_REPLY_HTML', true);
}

export function loadImapSmtpConfig(): ImapSmtpConfig {
  const user = required('MAIL_USER');
  // SMTP credentials default to the IMAP ones; most providers use one login,
  // and the ones that don't (relays like SES, Postmark) can override.
  const pass = required('MAIL_PASSWORD');

  const fromRaw = env('MAIL_FROM') ?? user;
  const from = parseAddress(fromRaw);
  if (!from) {
    throw new Error(`MAIL_FROM is not a usable address: ${JSON.stringify(fromRaw)}`);
  }

  const smtpPort = port('SMTP_PORT', 465);

  return {
    imap: {
      host: required('IMAP_HOST'),
      port: port('IMAP_PORT', 993),
      secure: secure('IMAP_SECURE', true),
      user: env('IMAP_USER') ?? user,
      pass: env('IMAP_PASSWORD') ?? pass,
      inbox: env('IMAP_INBOX'),
      sentMailbox: env('IMAP_SENT_MAILBOX'),
    },
    smtp: {
      host: required('SMTP_HOST'),
      port: smtpPort,
      // Port 587 means STARTTLS, which nodemailer expects as secure:false.
      // Defaulting on the port avoids the single most common misconfiguration.
      secure: secure('SMTP_SECURE', smtpPort === 465),
      user: env('SMTP_USER') ?? user,
      pass: env('SMTP_PASSWORD') ?? pass,
    },
    from,
  };
}

/**
 * Gmail / Google Workspace.
 *
 * Which auth mode you get is decided by which variables are present, not by a
 * mode switch: a service-account key and a refresh token look nothing alike,
 * so asking the user to also declare which one they pasted is a needless step
 * that can disagree with reality.
 */
export function loadGmailConfig(): GmailConfig {
  const serviceAccountKey = env('GOOGLE_PRIVATE_KEY');
  const refreshToken = env('GOOGLE_REFRESH_TOKEN');

  if (serviceAccountKey && refreshToken) {
    throw new Error(
      'Set either GOOGLE_REFRESH_TOKEN or GOOGLE_PRIVATE_KEY, not both — ' +
        'they are two different ways in and only one can be used.',
    );
  }

  let auth: GoogleAuthConfig;
  let mailbox: string;

  if (serviceAccountKey) {
    // Domain-wide delegation. The service account has no mailbox of its own,
    // so it must be told whose mail to act on.
    mailbox = required('GOOGLE_IMPERSONATE_USER');
    auth = {
      kind: 'service-account',
      clientEmail: required('GOOGLE_CLIENT_EMAIL'),
      privateKey: normalizePrivateKey(serviceAccountKey),
      impersonate: mailbox,
    };
  } else if (refreshToken) {
    mailbox = required('MAIL_USER');
    auth = {
      kind: 'refresh-token',
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      refreshToken,
    };
  } else {
    throw new Error(
      'MAIL_PROVIDER=gmail needs either GOOGLE_REFRESH_TOKEN (one mailbox) ' +
        'or GOOGLE_PRIVATE_KEY (Workspace domain-wide delegation). See .env.example.',
    );
  }

  const fromRaw = env('MAIL_FROM') ?? mailbox;
  const from = parseAddress(fromRaw);
  if (!from) {
    throw new Error(`MAIL_FROM is not a usable address: ${JSON.stringify(fromRaw)}`);
  }

  return { auth, from };
}

/**
 * Zoho Mail.
 *
 * The region is asked for rather than probed. Zoho's data centres are separate
 * installations that do not share credentials, so a token from the wrong one
 * fails as "invalid" — indistinguishable from a bad secret, and people spend
 * an afternoon on it. One required variable is cheaper than that afternoon.
 */
export function loadZohoConfig(): ZohoConfig {
  const region = (env('ZOHO_REGION') ?? 'com').toLowerCase();
  if (!isZohoRegion(region)) {
    throw new Error(
      `ZOHO_REGION must be one of ${Object.keys(ZOHO_REGIONS).join(', ')}, got ${JSON.stringify(region)}`,
    );
  }

  const mailbox = required('MAIL_USER');
  const fromRaw = env('MAIL_FROM') ?? mailbox;
  const from = parseAddress(fromRaw);
  if (!from) {
    throw new Error(`MAIL_FROM is not a usable address: ${JSON.stringify(fromRaw)}`);
  }

  return {
    auth: {
      clientId: required('ZOHO_CLIENT_ID'),
      clientSecret: required('ZOHO_CLIENT_SECRET'),
      refreshToken: required('ZOHO_REFRESH_TOKEN'),
      region,
    },
    from,
    ...(env('ZOHO_ACCOUNT_ID') ? { accountId: env('ZOHO_ACCOUNT_ID')! } : {}),
    ...(env('ZOHO_INBOX_FOLDER') ? { inboxFolder: env('ZOHO_INBOX_FOLDER')! } : {}),
    ...(env('ZOHO_SENT_FOLDER') ? { sentFolder: env('ZOHO_SENT_FOLDER')! } : {}),
  };
}

/**
 * The address this desk sends from, lowercased, or undefined when nothing is
 * configured yet.
 *
 * Deliberately lenient where the loaders above are strict: the only caller is
 * thread reconstruction deciding which messages are ours, and a desk with a
 * half-written `.env` should still ingest mail rather than throw. Getting this
 * wrong labels a message "Customer" instead of "Support", which is a worse
 * prompt, not a failure.
 */
export function mailboxAddress(): string | undefined {
  const fromRaw = env('MAIL_FROM');
  const parsed = fromRaw ? parseAddress(fromRaw) : null;
  const address = parsed?.address ?? env('MAIL_USER') ?? env('GOOGLE_IMPERSONATE_USER');
  return address?.toLowerCase();
}

export function buildMailProvider(): MailProvider {
  const kind = (env('MAIL_PROVIDER') ?? 'imap-smtp').toLowerCase();

  if (kind === 'imap-smtp' || kind === 'imap') {
    return new ImapSmtpProvider(loadImapSmtpConfig());
  }

  // "google-workspace" is the same API; the difference is only how you
  // authenticate, and that is inferred from the credentials.
  if (kind === 'gmail' || kind === 'google' || kind === 'google-workspace') {
    return new GmailProvider(loadGmailConfig());
  }

  if (kind === 'zoho') {
    return new ZohoProvider(loadZohoConfig());
  }

  throw new Error(
    `Unknown MAIL_PROVIDER ${JSON.stringify(kind)}. Supported: imap-smtp, gmail, zoho.`,
  );
}

let cached: MailProvider | null = null;

/** The process-wide provider. IMAP connections are expensive; share one. */
export function mailProvider(): MailProvider {
  if (!cached) cached = buildMailProvider();
  return cached;
}

export async function resetMailProvider(): Promise<void> {
  const current = cached;
  cached = null;
  if (current) await current.close().catch(() => {});
}
