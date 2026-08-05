import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { loadGmailConfig } from '../../config';
import { MailError } from '../../types';
import { GoogleAuth, normalizePrivateKey } from './auth';
import { GmailProvider } from './gmail';

// --- a real HTTP server standing in for Google -----------------------------

interface Recorded {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

interface Fake {
  origin: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

function startFake(handler: Handler): Promise<Fake> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });
      handler(req, res, body);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>(done => {
            server.close(() => done());
          }),
      });
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

let fake: Fake | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

// --- token acquisition -----------------------------------------------------

describe('GoogleAuth', () => {
  it('exchanges a refresh token and caches the result', async () => {
    let issued = 0;
    fake = await startFake((_req, res) => {
      issued += 1;
      json(res, 200, { access_token: `token-${issued}`, expires_in: 3600 });
    });

    const auth = new GoogleAuth({
      kind: 'refresh-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      tokenEndpoint: `${fake.origin}/token`,
    });

    expect(await auth.accessToken()).toBe('token-1');
    expect(await auth.accessToken()).toBe('token-1');
    expect(issued).toBe(1);

    const sent = new URLSearchParams(fake.requests[0]!.body);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('refresh-token');
    expect(sent.get('client_secret')).toBe('client-secret');
  });

  it('re-fetches after invalidate()', async () => {
    let issued = 0;
    fake = await startFake((_req, res) => {
      issued += 1;
      json(res, 200, { access_token: `token-${issued}`, expires_in: 3600 });
    });

    const auth = new GoogleAuth({
      kind: 'refresh-token',
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'c',
      tokenEndpoint: `${fake.origin}/token`,
    });

    expect(await auth.accessToken()).toBe('token-1');
    auth.invalidate();
    expect(await auth.accessToken()).toBe('token-2');
  });

  it('shares one refresh between concurrent callers', async () => {
    let issued = 0;
    fake = await startFake((_req, res) => {
      issued += 1;
      setTimeout(() => json(res, 200, { access_token: 'shared', expires_in: 3600 }), 20);
    });

    const auth = new GoogleAuth({
      kind: 'refresh-token',
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'c',
      tokenEndpoint: `${fake.origin}/token`,
    });

    const tokens = await Promise.all([
      auth.accessToken(),
      auth.accessToken(),
      auth.accessToken(),
    ]);
    expect(tokens).toEqual(['shared', 'shared', 'shared']);
    expect(issued).toBe(1);
  });

  it('re-fetches once the cached token is nearly expired', async () => {
    let issued = 0;
    fake = await startFake((_req, res) => {
      issued += 1;
      // Shorter than the 60s of slack, so it is stale the moment it arrives.
      json(res, 200, { access_token: `token-${issued}`, expires_in: 30 });
    });

    const auth = new GoogleAuth({
      kind: 'refresh-token',
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'c',
      tokenEndpoint: `${fake.origin}/token`,
    });

    expect(await auth.accessToken()).toBe('token-1');
    expect(await auth.accessToken()).toBe('token-2');
  });

  it('signs a verifiable RS256 assertion for a service account', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    fake = await startFake((_req, res) => {
      json(res, 200, { access_token: 'delegated', expires_in: 3600 });
    });
    const endpoint = `${fake.origin}/token`;

    const auth = new GoogleAuth({
      kind: 'service-account',
      clientEmail: 'bot@project.iam.gserviceaccount.com',
      privateKey,
      impersonate: 'support@company.com',
      tokenEndpoint: endpoint,
    });

    expect(await auth.accessToken()).toBe('delegated');

    const sent = new URLSearchParams(fake.requests[0]!.body);
    expect(sent.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const assertion = sent.get('assertion') ?? '';
    const [header, claims, signature] = assertion.split('.');
    expect(signature).toBeTruthy();

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    const ok = verifier.verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(ok).toBe(true);

    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8'));
    expect(payload.iss).toBe('bot@project.iam.gserviceaccount.com');
    // Domain-wide delegation lives or dies on `sub`.
    expect(payload.sub).toBe('support@company.com');
    expect(payload.aud).toBe(endpoint);
    expect(payload.scope).toContain('gmail.send');
    // Google rejects anything longer than an hour.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(3600);
  });

  it('treats a 400 as permanent — a revoked refresh token will not heal', async () => {
    let calls = 0;
    fake = await startFake((_req, res) => {
      calls += 1;
      json(res, 400, { error: 'invalid_grant' });
    });

    const auth = new GoogleAuth({
      kind: 'refresh-token',
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'revoked',
      tokenEndpoint: `${fake.origin}/token`,
    });

    await expect(auth.accessToken()).rejects.toMatchObject({
      name: 'MailError',
      transient: false,
    });
    expect(calls).toBe(1);
  });

  it('treats 429 and 5xx as transient', async () => {
    for (const status of [429, 503]) {
      const server = await startFake((_req, res) => json(res, status, { error: 'busy' }));
      const auth = new GoogleAuth({
        kind: 'refresh-token',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
        tokenEndpoint: `${server.origin}/token`,
      });
      await expect(auth.accessToken()).rejects.toMatchObject({ transient: true });
      await server.close();
    }
  });

  it('rejects a 200 that carries no access_token', async () => {
    fake = await startFake((_req, res) => json(res, 200, { expires_in: 3600 }));
    const auth = new GoogleAuth({
      kind: 'refresh-token',
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'c',
      tokenEndpoint: `${fake.origin}/token`,
    });
    await expect(auth.accessToken()).rejects.toThrow(/no access_token/i);
  });

  it('reports an unreachable endpoint as transient', async () => {
    const auth = new GoogleAuth({
      kind: 'refresh-token',
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'c',
      // Nothing listening.
      tokenEndpoint: 'http://127.0.0.1:1/token',
    });
    await expect(auth.accessToken()).rejects.toMatchObject({ transient: true });
  });

  it('turns escaped newlines in a PEM key back into real ones', () => {
    const escaped = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n';
    expect(normalizePrivateKey(escaped)).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    );
    const real = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    expect(normalizePrivateKey(real)).toBe(real);
  });

  it('explains an unusable service-account key instead of leaking a crypto error', async () => {
    const auth = new GoogleAuth({
      kind: 'service-account',
      clientEmail: 'bot@project.iam.gserviceaccount.com',
      privateKey: 'not a key',
      impersonate: 'support@company.com',
      tokenEndpoint: 'http://127.0.0.1:1/token',
    });
    await expect(auth.accessToken()).rejects.toThrow(/service account key/i);
  });
});

// --- the provider ----------------------------------------------------------

function rawMessage(fields: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  body?: string;
}): string {
  const lines = [
    `From: ${fields.from}`,
    `To: ${fields.to}`,
    `Subject: ${fields.subject}`,
    `Message-ID: ${fields.messageId}`,
    `Date: Tue, 05 Aug 2026 10:00:00 +0000`,
    ...(fields.inReplyTo ? [`In-Reply-To: ${fields.inReplyTo}`] : []),
    ...(fields.references ? [`References: ${fields.references}`] : []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    fields.body ?? 'Hello there.',
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function headerList(fields: Record<string, string>) {
  return Object.entries(fields).map(([name, value]) => ({ name, value }));
}

/** A fake that serves the token endpoint and the Gmail API from one origin. */
async function startGmailFake(handler: Handler): Promise<Fake> {
  return startFake((req, res, body) => {
    if ((req.url ?? '').startsWith('/token')) {
      json(res, 200, { access_token: 'access-token', expires_in: 3600 });
      return;
    }
    handler(req, res, body);
  });
}

function providerFor(fake: Fake, concurrency = 8): GmailProvider {
  return new GmailProvider({
    auth: {
      kind: 'refresh-token',
      clientId: 'a',
      clientSecret: 'b',
      refreshToken: 'c',
      tokenEndpoint: `${fake.origin}/token`,
    },
    from: { name: 'Acme Support', address: 'support@acme.com' },
    apiBaseUrl: fake.origin,
    concurrency,
  });
}

describe('GmailProvider', () => {
  it('lists the inbox newest first and carries the threading headers', async () => {
    fake = await startGmailFake((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/gmail/v1/users/me/messages?')) {
        json(res, 200, {
          messages: [
            { id: 'm1', threadId: 't1' },
            { id: 'm2', threadId: 't2' },
          ],
        });
        return;
      }
      if (url.includes('/messages/m1')) {
        json(res, 200, {
          id: 'm1',
          threadId: 't1',
          labelIds: ['INBOX', 'UNREAD'],
          internalDate: '1000000000000',
          payload: {
            headers: headerList({
              Subject: 'Older',
              From: 'Ann <ann@customer.com>',
              To: 'support@acme.com',
              'Message-ID': '<older@customer>',
            }),
          },
        });
        return;
      }
      json(res, 200, {
        id: 'm2',
        threadId: 't2',
        labelIds: ['INBOX'],
        internalDate: '2000000000000',
        payload: {
          headers: headerList({
            Subject: 'Re: Newer',
            From: 'Bob <bob@customer.com>',
            To: 'support@acme.com',
            'Message-ID': '<newer@customer>',
            'In-Reply-To': '<root@customer>',
            References: '<root@customer> <mid@customer>',
          }),
        },
      });
    });

    const messages = await providerFor(fake).listInbox({ limit: 10 });

    expect(messages.map(m => m.id)).toEqual(['m2', 'm1']);
    expect(messages[0]).toMatchObject({
      threadId: 't2',
      messageIdHeader: 'newer@customer',
      inReplyTo: 'root@customer',
      isRead: true,
    });
    expect(messages[0]!.references).toEqual(['root@customer', 'mid@customer']);
    // UNREAD label absent means read; present means not.
    expect(messages[1]!.isRead).toBe(false);
    expect(messages[1]!.from).toEqual({ name: 'Ann', address: 'ann@customer.com' });

    const list = fake.requests.find(r => r.url.startsWith('/gmail/v1/users/me/messages?'))!;
    expect(list.url).toContain('labelIds=INBOX');
    expect(list.authorization).toBe('Bearer access-token');
  });

  it('translates `since` into Gmail\'s date-granularity query', async () => {
    fake = await startGmailFake((_req, res) => json(res, 200, { messages: [] }));
    await providerFor(fake).listInbox({ since: '2026-08-05T10:11:12.000Z' });
    expect(decodeURIComponent(fake.requests.at(-1)!.url)).toContain('q=after:2026/08/05');
  });

  it('asks for the SENT label when listing sent mail', async () => {
    fake = await startGmailFake((_req, res) => json(res, 200, { messages: [] }));
    await providerFor(fake).listSent();
    expect(fake.requests.at(-1)!.url).toContain('labelIds=SENT');
  });

  it('parses a raw message, including attachments', async () => {
    const raw = Buffer.from(
      [
        'From: Ann <ann@customer.com>',
        'To: support@acme.com',
        'Subject: Broken invoice',
        'Message-ID: <inv@customer>',
        'Content-Type: multipart/mixed; boundary="B"',
        '',
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'See attached.',
        '--B',
        'Content-Type: text/plain; name="note.txt"',
        'Content-Disposition: attachment; filename="note.txt"',
        '',
        'contents',
        '--B--',
        '',
      ].join('\r\n'),
      'utf8',
    ).toString('base64url');

    fake = await startGmailFake((_req, res) =>
      json(res, 200, { id: 'm1', threadId: 't1', labelIds: ['INBOX'], raw }),
    );

    const detail = await providerFor(fake).getMessage('m1');
    expect(detail.subject).toBe('Broken invoice');
    expect(detail.messageIdHeader).toBe('inv@customer');
    expect(detail.text).toContain('See attached.');
    expect(detail.hasAttachments).toBe(true);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({ id: '0', filename: 'note.txt' });
  });

  it('prefers internalDate over the sender-supplied Date header', async () => {
    const raw = Buffer.from(
      [
        'From: ann@customer.com',
        'To: support@acme.com',
        'Subject: Skewed clock',
        'Message-ID: <skew@customer>',
        'Date: Fri, 01 Jan 1999 00:00:00 +0000',
        '',
        'body',
        '',
      ].join('\r\n'),
      'utf8',
    ).toString('base64url');

    fake = await startGmailFake((_req, res) =>
      json(res, 200, { id: 'm1', threadId: 't1', internalDate: '1754388000000', raw }),
    );

    const detail = await providerFor(fake).getMessage('m1');
    expect(detail.receivedAt).toBe(new Date(1754388000000).toISOString());
  });

  it('fetches a whole thread in one request, oldest first', async () => {
    fake = await startGmailFake((req, res) => {
      expect(req.url).toContain('/threads/t1');
      json(res, 200, {
        messages: [
          {
            id: 'm2',
            threadId: 't1',
            internalDate: '2000',
            raw: rawMessage({
              from: 'support@acme.com',
              to: 'ann@customer.com',
              subject: 'Re: Hi',
              messageId: '<reply@acme>',
              inReplyTo: '<hi@customer>',
            }),
          },
          {
            id: 'm1',
            threadId: 't1',
            internalDate: '1000',
            raw: rawMessage({
              from: 'ann@customer.com',
              to: 'support@acme.com',
              subject: 'Hi',
              messageId: '<hi@customer>',
            }),
          },
        ],
      });
    });

    const thread = await providerFor(fake).getThread({
      id: 'm2',
      threadId: 't1',
      subject: 'Re: Hi',
      from: { address: 'support@acme.com' },
      to: [{ address: 'ann@customer.com' }],
      receivedAt: new Date(2000).toISOString(),
      isRead: true,
      hasAttachments: false,
    });

    expect(thread.map(m => m.id)).toEqual(['m1', 'm2']);
    // One API call for the thread, no per-message round trips.
    const threadCalls = fake.requests.filter(r => r.url.includes('/threads/'));
    expect(threadCalls).toHaveLength(1);
  });

  it('sends base64url RFC822 with the threadId, and reads back the id Gmail assigned', async () => {
    fake = await startGmailFake((req, res) => {
      if ((req.url ?? '').includes('/messages/send')) {
        json(res, 200, { id: 'sent-1', threadId: 't1' });
        return;
      }
      json(res, 200, {
        id: 'sent-1',
        threadId: 't1',
        payload: { headers: headerList({ 'Message-ID': '<rewritten-by-gmail@mail.gmail.com>' }) },
      });
    });

    const result = await providerFor(fake).send({
      to: [{ name: 'Ann', address: 'ann@customer.com' }],
      subject: 'Re: Broken invoice',
      text: 'Fixed, sorry about that.',
      inReplyTo: 'inv@customer',
      references: ['root@customer'],
      threadId: 't1',
    });

    // Gmail rewrites Message-ID; trusting what we composed breaks the next reply.
    expect(result.messageId).toBe('rewritten-by-gmail@mail.gmail.com');
    expect(result.threadId).toBe('t1');

    const sendCall = fake.requests.find(r => r.url.includes('/messages/send'))!;
    const payload = JSON.parse(sendCall.body);
    expect(payload.threadId).toBe('t1');

    const wire = Buffer.from(payload.raw, 'base64url').toString('utf8');
    expect(wire).toContain('To: Ann <ann@customer.com>');
    expect(wire).toContain('In-Reply-To: <inv@customer>');
    expect(wire).toContain('<root@customer>');
    expect(wire).toContain('<inv@customer>');
    expect(wire).toContain('Fixed, sorry about that.');
  });

  it('refuses to send with no recipients or no body', async () => {
    fake = await startGmailFake((_req, res) => json(res, 200, {}));
    const provider = providerFor(fake);

    await expect(provider.send({ to: [], subject: 'x', text: 'y' })).rejects.toThrow(
      /no recipients/i,
    );
    await expect(
      provider.send({ to: [{ address: 'a@b.com' }], subject: 'x' }),
    ).rejects.toThrow(/empty body/i);
    // Neither reached the network.
    expect(fake.requests.filter(r => r.url.includes('/messages/send'))).toHaveLength(0);
  });

  it('marks as read by removing the UNREAD label', async () => {
    fake = await startGmailFake((_req, res) => json(res, 200, {}));
    await providerFor(fake).markAsRead('m1');

    const call = fake.requests.at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/messages/m1/modify');
    expect(JSON.parse(call.body)).toEqual({ removeLabelIds: ['UNREAD'] });
  });

  it('refreshes the token once on a 401 rather than failing the call', async () => {
    let seen = 0;
    fake = await startFake((req, res) => {
      if ((req.url ?? '').startsWith('/token')) {
        json(res, 200, { access_token: `token-${++seen}`, expires_in: 3600 });
        return;
      }
      if (seen === 1) {
        json(res, 401, { error: 'invalid credentials' });
        return;
      }
      json(res, 200, { messages: [] });
    });

    await expect(providerFor(fake).listInbox()).resolves.toEqual([]);
    // Two token fetches, meaning the cache really was dropped and re-filled.
    expect(fake.requests.filter(r => r.url.startsWith('/token'))).toHaveLength(2);
  });

  it('gives up after one 401 retry instead of looping', async () => {
    fake = await startFake((req, res) => {
      if ((req.url ?? '').startsWith('/token')) {
        json(res, 200, { access_token: 'always-stale', expires_in: 3600 });
        return;
      }
      json(res, 401, { error: 'invalid credentials' });
    });

    await expect(providerFor(fake).listInbox()).rejects.toThrow(/401/);
    expect(fake.requests.filter(r => r.url.includes('/messages'))).toHaveLength(2);
  });

  it('classifies API failures the way a retry loop needs', async () => {
    fake = await startGmailFake((_req, res) => json(res, 503, { error: 'backend error' }));
    await expect(providerFor(fake).listInbox()).rejects.toMatchObject({ transient: true });

    const permanent = await startGmailFake((_req, res) => json(res, 403, { error: 'no scope' }));
    await expect(providerFor(permanent).listInbox()).rejects.toMatchObject({ transient: false });
    await permanent.close();
  });

  it('reports an unreachable API as transient', async () => {
    fake = await startGmailFake((_req, res) => json(res, 200, {}));
    const provider = new GmailProvider({
      auth: {
        kind: 'refresh-token',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
        tokenEndpoint: `${fake.origin}/token`,
      },
      from: { address: 'support@acme.com' },
      apiBaseUrl: 'http://127.0.0.1:1',
    });
    await expect(provider.listInbox()).rejects.toMatchObject({ transient: true });
  });
});

// --- configuration ---------------------------------------------------------

describe('loadGmailConfig', () => {
  const KEYS = [
    'MAIL_USER',
    'MAIL_FROM',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_CLIENT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'GOOGLE_IMPERSONATE_USER',
  ];

  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('builds refresh-token auth and defaults MAIL_FROM to the mailbox', () => {
    process.env.MAIL_USER = 'support@acme.com';
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh';

    const config = loadGmailConfig();
    expect(config.auth).toMatchObject({ kind: 'refresh-token', clientId: 'id' });
    expect(config.from).toEqual({ address: 'support@acme.com' });
  });

  it('builds service-account auth and un-escapes the key', () => {
    process.env.GOOGLE_CLIENT_EMAIL = 'bot@project.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----';
    process.env.GOOGLE_IMPERSONATE_USER = 'support@acme.com';
    process.env.MAIL_FROM = 'Acme Support <support@acme.com>';

    const config = loadGmailConfig();
    expect(config.auth).toMatchObject({
      kind: 'service-account',
      impersonate: 'support@acme.com',
    });
    expect((config.auth as { privateKey: string }).privateKey).toContain('\nabc\n');
    expect(config.from).toEqual({ name: 'Acme Support', address: 'support@acme.com' });
  });

  it('refuses both credential kinds at once rather than silently picking one', () => {
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
    process.env.GOOGLE_PRIVATE_KEY = 'key';
    expect(() => loadGmailConfig()).toThrow(/not both/i);
  });

  it('says what is missing when neither is set', () => {
    expect(() => loadGmailConfig()).toThrow(/GOOGLE_REFRESH_TOKEN|GOOGLE_PRIVATE_KEY/);
  });

  it('names the specific variable that is missing', () => {
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
    expect(() => loadGmailConfig()).toThrow(/MAIL_USER is required/);
    process.env.MAIL_USER = 'support@acme.com';
    expect(() => loadGmailConfig()).toThrow(/GOOGLE_CLIENT_ID is required/);
    process.env.GOOGLE_CLIENT_ID = 'id';
    expect(() => loadGmailConfig()).toThrow(/GOOGLE_CLIENT_SECRET is required/);
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    expect(() => loadGmailConfig()).not.toThrow();
  });

  it('requires an impersonation target for a service account', () => {
    process.env.GOOGLE_PRIVATE_KEY = 'key';
    expect(() => loadGmailConfig()).toThrow(/GOOGLE_IMPERSONATE_USER is required/);
  });

  it('is a MailError shape when the provider itself rejects', () => {
    expect(MailError).toBeTypeOf('function');
  });
});
