import type { AddressInfo } from 'node:net';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMailProvider, loadImapSmtpConfig, resetMailProvider } from './config';
import { ImapSmtpProvider, decodeId, encodeId } from './providers/imap-smtp';
import { MailError } from './types';

describe('message ids', () => {
  it('round-trips', () => {
    const id = encodeId('INBOX', 12345, 42);
    expect(decodeId(id)).toEqual({ mailbox: 'INBOX', uidValidity: '12345', uid: 42 });
  });

  it('survives a mailbox name containing a colon or a space', () => {
    const id = encodeId('[Gmail]/Sent Mail', 1n, 7);
    expect(decodeId(id).mailbox).toBe('[Gmail]/Sent Mail');
  });

  it('handles a bigint UIDVALIDITY without losing precision', () => {
    const id = encodeId('INBOX', 4294967295n, 1);
    expect(decodeId(id).uidValidity).toBe('4294967295');
  });

  it('rejects malformed ids loudly rather than fetching the wrong message', () => {
    for (const bad of ['', 'INBOX', 'INBOX:1', 'INBOX:1:0', 'INBOX:1:abc', 'a:b:c:d']) {
      expect(() => decodeId(bad)).toThrow(MailError);
    }
  });
});

// --- send path against a real SMTP server ---------------------------------

interface Captured {
  raw: string;
  envelopeTo: string[];
  envelopeFrom: string;
}

function startSmtp(): Promise<{ port: number; received: Captured[]; close: () => Promise<void> }> {
  const received: Captured[] = [];
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', c => chunks.push(c as Buffer));
      stream.on('end', () => {
        received.push({
          raw: Buffer.concat(chunks).toString('utf8'),
          envelopeTo: session.envelope.rcptTo.map(r => r.address),
          envelopeFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
        });
        callback();
      });
    },
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      // SMTPServer wraps a net.Server rather than extending it.
      const { port } = server.server.address() as AddressInfo;
      resolve({
        port,
        received,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

function provider(smtpPort: number): ImapSmtpProvider {
  return new ImapSmtpProvider({
    // Port 1 so the Sent-append attempt fails fast; sending must not depend
    // on IMAP being reachable.
    imap: { host: '127.0.0.1', port: 1, secure: false, user: 'u', pass: 'p' },
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: 'u', pass: 'p' },
    from: { name: 'Support', address: 'support@us.com' },
  });
}

describe('send', () => {
  it('puts the right headers on the wire and threads the reply', async () => {
    const server = await startSmtp();
    const mail = provider(server.port);

    const result = await mail.send({
      to: [{ name: 'Vincent', address: 'v@example.com' }],
      cc: [{ address: 'boss@example.com' }],
      subject: 'Re: Refund',
      html: '<p>Refunded.</p>',
      inReplyTo: 'parent@customer',
      references: ['root@customer'],
    });

    expect(result.messageId).toBeTruthy();
    expect(result.messageId).not.toContain('<');

    expect(server.received).toHaveLength(1);
    const sent = server.received[0]!;
    // Both To and Cc must reach the envelope or the cc'd person never gets it.
    expect(sent.envelopeTo.sort()).toEqual(['boss@example.com', 'v@example.com']);
    expect(sent.envelopeFrom).toBe('support@us.com');

    const parsed = await simpleParser(sent.raw);
    expect(parsed.subject).toBe('Re: Refund');
    // nodemailer quotes display names on the wire; compare the parts.
    expect(parsed.from?.value?.[0]).toMatchObject({
      name: 'Support',
      address: 'support@us.com',
    });
    expect(parsed.inReplyTo).toBe('<parent@customer>');
    // References must carry the root AND the parent, or clients break the thread.
    // Root first, then the immediate parent — the order clients rely on.
    expect(parsed.references).toEqual(['<root@customer>', '<parent@customer>']);
    expect(parsed.html).toContain('Refunded.');

    await mail.close();
    await server.close();
  }, 20_000);

  it('sends successfully even though appending to Sent fails', async () => {
    // IMAP is pointed at a closed port. The mail is already delivered by the
    // time the append runs, so failing here would invite a duplicate send.
    const server = await startSmtp();
    const mail = provider(server.port);

    await expect(mail.send({ to: [{ address: 'v@example.com' }], subject: 'Hi', text: 'yo' }))
      .resolves.toMatchObject({ messageId: expect.any(String) });
    expect(server.received).toHaveLength(1);

    await mail.close();
    await server.close();
  }, 20_000);

  it('refuses to send with no recipients', async () => {
    const mail = provider(1);
    await expect(mail.send({ to: [], subject: 'x', text: 'y' })).rejects.toThrow(/no recipients/i);
    await mail.close();
  });

  it('refuses to send an empty body', async () => {
    const mail = provider(1);
    await expect(mail.send({ to: [{ address: 'a@b.com' }], subject: 'x' })).rejects.toThrow(
      /empty body/i,
    );
    await mail.close();
  });

  it('reports an unreachable SMTP server as a transient MailError', async () => {
    const mail = provider(1);
    const err = await mail
      .send({ to: [{ address: 'a@b.com' }], subject: 'x', text: 'y' })
      .catch(e => e);

    expect(err).toBeInstanceOf(MailError);
    expect(err.transient).toBe(true);
    await mail.close();
  }, 20_000);
});

// --- configuration --------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(IMAP|SMTP|MAIL)_/.test(key)) delete process.env[key];
  }
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await resetMailProvider();
});

function minimalEnv() {
  process.env.IMAP_HOST = 'imap.example.com';
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.MAIL_USER = 'support@us.com';
  process.env.MAIL_PASSWORD = 'secret';
}

describe('config', () => {
  it('needs four variables for the common case and infers the rest', () => {
    minimalEnv();
    const cfg = loadImapSmtpConfig();

    expect(cfg.imap).toMatchObject({ port: 993, secure: true, user: 'support@us.com' });
    expect(cfg.smtp).toMatchObject({ port: 465, secure: true, user: 'support@us.com' });
    expect(cfg.from).toEqual({ address: 'support@us.com' });
  });

  it('turns off implicit TLS on port 587, the usual misconfiguration', () => {
    minimalEnv();
    process.env.SMTP_PORT = '587';
    expect(loadImapSmtpConfig().smtp).toMatchObject({ port: 587, secure: false });
  });

  it('still allows forcing TLS on a non-standard port', () => {
    minimalEnv();
    process.env.SMTP_PORT = '587';
    process.env.SMTP_SECURE = 'true';
    expect(loadImapSmtpConfig().smtp.secure).toBe(true);
  });

  it('lets SMTP use separate credentials, for relays like SES', () => {
    minimalEnv();
    process.env.SMTP_USER = 'AKIAEXAMPLE';
    process.env.SMTP_PASSWORD = 'relay-secret';

    const cfg = loadImapSmtpConfig();
    expect(cfg.smtp).toMatchObject({ user: 'AKIAEXAMPLE', pass: 'relay-secret' });
    expect(cfg.imap).toMatchObject({ user: 'support@us.com', pass: 'secret' });
  });

  it('keeps the display name from MAIL_FROM', () => {
    minimalEnv();
    process.env.MAIL_FROM = 'Acme Support <help@acme.com>';
    expect(loadImapSmtpConfig().from).toEqual({ name: 'Acme Support', address: 'help@acme.com' });
  });

  it('names each missing variable instead of failing obscurely later', () => {
    expect(() => loadImapSmtpConfig()).toThrow(/MAIL_USER is required/);
    process.env.MAIL_USER = 'support@us.com';
    expect(() => loadImapSmtpConfig()).toThrow(/MAIL_PASSWORD is required/);
    process.env.MAIL_PASSWORD = 'secret';
    expect(() => loadImapSmtpConfig()).toThrow(/IMAP_HOST is required/);
    process.env.IMAP_HOST = 'imap.example.com';
    expect(() => loadImapSmtpConfig()).toThrow(/SMTP_HOST is required/);
  });

  it('rejects a nonsense port rather than silently defaulting', () => {
    minimalEnv();
    process.env.IMAP_PORT = 'yes';
    expect(() => loadImapSmtpConfig()).toThrow(/IMAP_PORT must be a valid port/);
  });

  it('rejects a nonsense boolean', () => {
    minimalEnv();
    process.env.IMAP_SECURE = 'maybe';
    expect(() => loadImapSmtpConfig()).toThrow(/IMAP_SECURE must be true or false/);
  });

  it('rejects an unusable MAIL_FROM', () => {
    minimalEnv();
    process.env.MAIL_FROM = 'not an address';
    expect(() => loadImapSmtpConfig()).toThrow(/MAIL_FROM is not a usable address/);
  });

  it('rejects an unknown provider by name', () => {
    minimalEnv();
    process.env.MAIL_PROVIDER = 'carrier-pigeon';
    expect(() => buildMailProvider()).toThrow(/Unknown MAIL_PROVIDER/);
  });
});
