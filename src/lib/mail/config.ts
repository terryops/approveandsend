import { parseAddress } from './address';
import { ImapSmtpProvider, type ImapSmtpConfig } from './providers/imap-smtp';
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

export function buildMailProvider(): MailProvider {
  const kind = (env('MAIL_PROVIDER') ?? 'imap-smtp').toLowerCase();

  if (kind === 'imap-smtp' || kind === 'imap') {
    return new ImapSmtpProvider(loadImapSmtpConfig());
  }

  throw new Error(`Unknown MAIL_PROVIDER ${JSON.stringify(kind)}. Supported: imap-smtp.`);
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
