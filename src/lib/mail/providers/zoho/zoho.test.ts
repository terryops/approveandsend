import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { loadZohoConfig } from '../../config';
import { MailError } from '../../types';
import { ZohoAuth } from './auth';
import { ZohoProvider } from './zoho';

// --- a real HTTP server standing in for Zoho -------------------------------

interface Recorded {
  method: string;
  url: string;
  authorization?: string;
  contentType?: string;
  body: string;
  /** The bytes as received, for the upload path where they are not text. */
  bytes: Buffer;
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
      const bytes = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: bytes.toString('utf8'),
        bytes,
      });
      handler(req, res, bytes.toString('utf8'));
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

/** Zoho wraps every response in {status, data}. */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: { code: status, description: 'ok' }, data }));
}

function raw(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

let fake: Fake | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const ACCOUNT = '4087071000000008002';
const INBOX = '4087071000000008014';
const SENT = '4087071000000008022';

const FOLDERS = [
  { folderId: INBOX, folderName: 'Inbox' },
  { folderId: SENT, folderName: 'Sent' },
  { folderId: '999', folderName: 'Spam' },
];

/** The shape /messages/view really returns: everything is a string. */
function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: '1786003364656153000',
    folderId: INBOX,
    threadId: '1786003364656153000',
    subject: 'Issue with credits',
    sender: 'A Customer',
    fromAddress: 'customer@example.com',
    toAddress: 'support@example.com',
    receivedTime: '1786003364622',
    summary: 'I hope this finds you well',
    hasAttachment: '0',
    status2: '0',
    ...over,
  };
}

/**
 * A Zoho good enough to drive the provider: token endpoint, account
 * discovery, folders, listings, the three per-message endpoints, and the two
 * write endpoints. `over` replaces individual routes per test.
 */
function zohoRoutes(over: Record<string, (req: IncomingMessage, res: ServerResponse, body: string) => boolean> = {}) {
  return (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = req.url ?? '';

    for (const [fragment, handler] of Object.entries(over)) {
      if (url.includes(fragment) && handler(req, res, body)) return;
    }

    if (url.startsWith('/oauth/v2/token')) {
      return raw(res, 200, { access_token: 'access-1', expires_in: 3600 });
    }
    if (url === '/api/accounts') {
      return json(res, 200, [{ accountId: ACCOUNT, primaryEmailAddress: 'support@example.com' }]);
    }
    if (url.endsWith('/folders')) return json(res, 200, FOLDERS);

    if (url.includes('/messages/view')) {
      const folder = new URL(url, 'http://x').searchParams.get('folderId');
      if (folder === SENT) {
        return json(res, 200, [
          summary({
            messageId: 'sent-1',
            folderId: SENT,
            fromAddress: 'support@example.com',
            sender: 'Support',
            toAddress: 'customer@example.com',
            receivedTime: '1786003400000',
          }),
        ]);
      }
      return json(res, 200, [
        summary(),
        summary({
          messageId: 'other-1',
          threadId: 'another-thread',
          subject: 'Unrelated',
          receivedTime: '1786003300000',
          status2: '1',
        }),
      ]);
    }

    if (url.endsWith('/details')) return json(res, 200, summary());
    if (url.endsWith('/content')) {
      return json(res, 200, { messageId: '1786003364656153000', content: '<p style="margin:0 0 12px">Hello <b>there</b></p>' });
    }
    if (url.endsWith('/header')) {
      return json(res, 200, {
        headerContent:
          'Delivered-To: support@example.com\r\n' +
          'Message-ID: <abc@mail.example.com>\r\n' +
          'In-Reply-To: <parent@mail.example.com>\r\n' +
          'References: <one@mail.example.com>\r\n\t<two@mail.example.com>\r\n' +
          'Subject: Issue with credits\r\n',
      });
    }
    if (url.endsWith('/attachmentinfo')) return json(res, 200, { attachments: [] });

    if (url.endsWith('/updatemessage')) return json(res, 200, {});
    if (req.method === 'POST' && url.includes('/messages/attachments')) {
      const name = new URL(url, 'http://x').searchParams.get('fileName') ?? '';
      return json(res, 200, {
        storeName: `store-${name}`,
        attachmentPath: `/path/${name}`,
        attachmentName: name,
      });
    }
    if (req.method === 'POST' && url.includes('/messages')) {
      return json(res, 200, { messageId: 'new-1', threadId: 'thread-1' });
    }

    return json(res, 404, {});
  };
}

function provider(origin: string, over: Partial<ConstructorParameters<typeof ZohoProvider>[0]> = {}) {
  return new ZohoProvider({
    auth: {
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      region: 'com',
      accountsBaseUrl: origin,
    },
    from: { address: 'support@example.com', name: 'Support' },
    accountId: ACCOUNT,
    apiBaseUrl: origin,
    ...over,
  });
}

// --- auth ------------------------------------------------------------------

describe('ZohoAuth', () => {
  it('exchanges the refresh token once and caches it', async () => {
    let issued = 0;
    fake = await startFake((_req, res) => {
      issued += 1;
      raw(res, 200, { access_token: `token-${issued}`, expires_in: 3600 });
    });

    const auth = new ZohoAuth({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      region: 'com',
      accountsBaseUrl: fake.origin,
    });

    expect(await auth.accessToken()).toBe('token-1');
    expect(await auth.accessToken()).toBe('token-1');
    expect(issued).toBe(1);

    auth.invalidate();
    expect(await auth.accessToken()).toBe('token-2');
  });

  it('names the region when Zoho refuses the token', async () => {
    // Zoho answers 200 with an error body for a token from another data
    // centre, so the status code alone would read as success.
    fake = await startFake((_req, res) => raw(res, 200, { error: 'invalid_code' }));

    const auth = new ZohoAuth({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      region: 'com',
      accountsBaseUrl: fake.origin,
    });

    await expect(auth.accessToken()).rejects.toThrow(/ZOHO_REGION/);
  });
});

// --- reading ---------------------------------------------------------------

describe('ZohoProvider reading', () => {
  it('lists the inbox with folder-scoped ids', async () => {
    fake = await startFake(zohoRoutes());
    const messages = await provider(fake.origin).listInbox();

    expect(messages).toHaveLength(2);
    // Folder and message together: every read endpoint needs the folder, and a
    // bare message id cannot address anything.
    expect(messages[0]!.id).toBe(`${INBOX}:1786003364656153000`);
    expect(messages[0]!.from).toEqual({ name: 'A Customer', address: 'customer@example.com' });
    expect(messages[0]!.threadId).toBe('1786003364656153000');
    expect(messages[0]!.receivedAt).toBe(new Date(1786003364622).toISOString());
  });

  it('drops the display name when Zoho has filled it with the address', async () => {
    fake = await startFake(
      zohoRoutes({
        '/messages/view': (_req, res) => {
          json(res, 200, [summary({ sender: 'Ethan@Example.com', fromAddress: 'ethan@example.com' })]);
          return true;
        },
      }),
    );

    const [message] = await provider(fake.origin).listInbox();
    expect(message!.from).toEqual({ address: 'ethan@example.com' });
  });

  it('reads status2 as unread, which is the polarity Zoho does not document', async () => {
    fake = await startFake(zohoRoutes());
    const messages = await provider(fake.origin).listInbox();

    expect(messages.find(m => m.id.endsWith('1786003364656153000'))!.isRead).toBe(true);
    expect(messages.find(m => m.id.endsWith('other-1'))!.isRead).toBe(false);
  });

  it('discovers the account id from the mailbox address', async () => {
    fake = await startFake(zohoRoutes());
    const p = new ZohoProvider({
      auth: {
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
        region: 'com',
        accountsBaseUrl: fake.origin,
      },
      from: { address: 'support@example.com' },
      apiBaseUrl: fake.origin,
    });

    await p.listInbox();
    expect(fake.requests.some(r => r.url === '/api/accounts')).toBe(true);
    expect(fake.requests.some(r => r.url.includes(`/accounts/${ACCOUNT}/folders`))).toBe(true);
  });

  it('says which folders exist when the named one does not', async () => {
    fake = await startFake(zohoRoutes());
    await expect(provider(fake.origin, { inboxFolder: 'Posteingang' }).listInbox()).rejects.toThrow(
      /inbox, sent, spam/,
    );
  });

  it('asks for the folder list once, however many listings follow', async () => {
    fake = await startFake(zohoRoutes());
    const p = provider(fake.origin);

    await p.listInbox();
    await p.listSent();
    await p.listInbox();

    expect(fake.requests.filter(r => r.url.endsWith('/folders'))).toHaveLength(1);
  });

  it('assembles a message from the three endpoints Zoho splits it across', async () => {
    fake = await startFake(zohoRoutes());
    const detail = await provider(fake.origin).getMessage(`${INBOX}:1786003364656153000`);

    expect(detail.html).toBe('<p style="margin:0 0 12px">Hello <b>there</b></p>');
    expect(detail.text).toBe('Hello there');
    // Only /header carries this, and without it the reply we send cannot be
    // threaded by the customer's mail client.
    expect(detail.messageIdHeader).toBe('abc@mail.example.com');
    expect(detail.inReplyTo).toBe('parent@mail.example.com');
    // Folded across two lines in the fixture, as it always is on a long thread.
    expect(detail.references).toEqual(['one@mail.example.com', 'two@mail.example.com']);
  });

  it('refuses an id that is not folder-scoped rather than reading the wrong message', async () => {
    fake = await startFake(zohoRoutes());
    await expect(provider(fake.origin).getMessage('1786003364656153000')).rejects.toThrow(MailError);
  });

  it('builds the thread from the threadId field, never from thread search', async () => {
    fake = await startFake(zohoRoutes());
    const p = provider(fake.origin);
    const [first] = await p.listInbox();

    const thread = await p.getThread(first!);

    // Two members: the customer's mail and our reply. The unrelated message in
    // the same folder carries a different threadId and stays out.
    expect(thread).toHaveLength(2);
    // The regression this guards: /messages/search?searchKey=threadId: returns
    // other conversations too, which here would put one customer's mail into
    // another customer's prompt.
    expect(fake.requests.some(r => r.url.includes('/messages/search'))).toBe(false);
  });
});

// --- writing ---------------------------------------------------------------

describe('ZohoProvider writing', () => {
  it('replies by Zoho id so the server threads it', async () => {
    fake = await startFake(zohoRoutes());

    const result = await provider(fake.origin).send({
      to: [{ address: 'customer@example.com', name: 'A Customer' }],
      subject: 'Re: Issue with credits',
      text: 'Sorted, and here is how.',
      inReplyTo: 'abc@mail.example.com',
      inReplyToProviderId: `${INBOX}:1786003364656153000`,
    });

    const post = fake.requests.find(r => r.method === 'POST' && r.url.includes('/messages/'))!;
    // The bare message id, not our folder-scoped one — Zoho has never heard of
    // that encoding.
    expect(post.url).toContain('/messages/1786003364656153000');
    const sent = JSON.parse(post.body);
    expect(sent.action).toBe('reply');
    expect(sent.toAddress).toBe('customer@example.com');
    expect(sent.content).toContain('Sorted');
    expect(result.messageId).toBe('new-1');
  });

  it('sends a fresh message when there is nothing to reply to', async () => {
    fake = await startFake(zohoRoutes());

    await provider(fake.origin).send({
      to: [{ address: 'customer@example.com' }],
      subject: 'Hello',
      text: 'First contact',
    });

    const post = fake.requests.find(r => r.method === 'POST' && r.url.includes('/messages'))!;
    expect(post.url).toMatch(/\/messages$/);
    expect(JSON.parse(post.body).action).toBeUndefined();
  });

  it('escapes a plain-text reply instead of letting it become markup', async () => {
    fake = await startFake(zohoRoutes());

    await provider(fake.origin).send({
      to: [{ address: 'customer@example.com' }],
      subject: 'Hello',
      text: 'Use <b> tags & such\nsecond line',
    });

    const post = fake.requests.find(r => r.method === 'POST' && r.url.includes('/messages'))!;
    const { content } = JSON.parse(post.body);
    // Through the shared renderer, so a caller that passes only text gets the
    // same markup as one that asked for HTML — there is no second, subtly
    // different converter living in this provider any more.
    expect(content).toBe('<p style="margin:0 0 12px">Use &lt;b&gt; tags &amp; such<br>second line</p>');
  });

  it('refuses an empty body or no recipients', async () => {
    fake = await startFake(zohoRoutes());
    const p = provider(fake.origin);

    await expect(p.send({ to: [], subject: 'x', text: 'y' })).rejects.toThrow(/recipients/);
    await expect(
      p.send({ to: [{ address: 'a@example.com' }], subject: 'x' }),
    ).rejects.toThrow(/empty body/);
  });

  it('stages attachments in Zoho\'s store and sends the handles, not the bytes', async () => {
    fake = await startFake(zohoRoutes());

    // Bytes that are not valid UTF-8, because JSON-encoding them would be the
    // silent way this breaks: a PDF that arrives corrupt rather than not at all.
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x80, 0xff, 0x00, 0x01]);

    await provider(fake.origin).send({
      to: [{ address: 'customer@example.com' }],
      subject: 'Your invoice',
      text: 'Attached.',
      attachments: [
        { filename: 'invoice.pdf', content: pdf, contentType: 'application/pdf' },
        { filename: 'notes.txt', content: Buffer.from('hello'), contentType: 'text/plain' },
      ],
    });

    const uploads = fake.requests.filter(r => r.url.includes('/messages/attachments'));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.url).toContain('fileName=invoice.pdf');
    // Octet-stream, never the file's own type: Zoho answers that with 415.
    expect(uploads[0]!.contentType).toBe('application/octet-stream');
    expect(uploads[0]!.bytes.equals(pdf)).toBe(true);

    const post = fake.requests.find(r => r.method === 'POST' && /\/messages$/.test(r.url))!;
    expect(JSON.parse(post.body).attachments).toEqual([
      { storeName: 'store-invoice.pdf', attachmentPath: '/path/invoice.pdf', attachmentName: 'invoice.pdf' },
      { storeName: 'store-notes.txt', attachmentPath: '/path/notes.txt', attachmentName: 'notes.txt' },
    ]);
  });

  it('attaches to a reply too, not only to a fresh message', async () => {
    fake = await startFake(zohoRoutes());

    await provider(fake.origin).send({
      to: [{ address: 'customer@example.com' }],
      subject: 'Re: Your invoice',
      text: 'Attached.',
      inReplyToProviderId: `${INBOX}:1786003364656153000`,
      attachments: [{ filename: 'a.pdf', content: Buffer.from('pdf') }],
    });

    const post = fake.requests.find(r => r.method === 'POST' && r.url.includes('/messages/1786'))!;
    const sent = JSON.parse(post.body);
    expect(sent.action).toBe('reply');
    expect(sent.attachments).toHaveLength(1);
  });

  it('does not upload anything when there is nothing to attach', async () => {
    fake = await startFake(zohoRoutes());

    await provider(fake.origin).send({
      to: [{ address: 'customer@example.com' }],
      subject: 'Hello',
      text: 'No files here.',
    });

    expect(fake.requests.some(r => r.url.includes('/messages/attachments'))).toBe(false);
    expect(JSON.parse(fake.requests.find(r => r.method === 'POST' && r.url.includes('/messages'))!.body).attachments).toBeUndefined();
  });

  it('refuses an inline image rather than delivering a broken one', async () => {
    fake = await startFake(zohoRoutes());

    await expect(
      provider(fake.origin).send({
        to: [{ address: 'a@example.com' }],
        subject: 'x',
        html: '<p style="margin:0 0 12px"><img src="cid:logo"></p>',
        attachments: [
          { filename: 'logo.png', content: Buffer.from('png'), contentId: 'logo' },
        ],
      }),
    ).rejects.toThrow(/inline/);

    expect(fake.requests.some(r => r.url.includes('/messages/attachments'))).toBe(false);
  });

  it('says what is too big before uploading 25 MB Zoho will reject anyway', async () => {
    fake = await startFake(zohoRoutes());

    await expect(
      provider(fake.origin).send({
        to: [{ address: 'a@example.com' }],
        subject: 'x',
        text: 'y',
        attachments: [{ filename: 'huge.mov', content: Buffer.alloc(25 * 1024 * 1024) }],
      }),
    ).rejects.toThrow(/over Zoho's 20 MB limit/);

    expect(fake.requests.some(r => r.url.includes('/messages/attachments'))).toBe(false);
  });

  it('fails the send when an upload comes back without a store handle', async () => {
    fake = await startFake((req, res, body) => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url.includes('/messages/attachments')) {
        return json(res, 200, {});
      }
      return zohoRoutes()(req, res, body);
    });

    await expect(
      provider(fake.origin).send({
        to: [{ address: 'a@example.com' }],
        subject: 'x',
        text: 'y',
        attachments: [{ filename: 'a.pdf', content: Buffer.from('pdf') }],
      }),
    ).rejects.toThrow(/no store handle/);

    // And crucially: the mail itself never went out half-formed.
    expect(fake.requests.some(r => r.method === 'POST' && /\/messages$/.test(r.url))).toBe(false);
  });

  it('marks read through the batch endpoint, because the per-message one 404s', async () => {
    fake = await startFake(zohoRoutes());
    await provider(fake.origin).markAsRead(`${INBOX}:1786003364656153000`);

    const put = fake.requests.find(r => r.method === 'PUT')!;
    expect(put.url).toContain('/updatemessage');
    expect(JSON.parse(put.body)).toEqual({
      mode: 'markAsRead',
      messageId: ['1786003364656153000'],
    });
  });

  it('retries once with a fresh token when Zoho 500s on an expired one', async () => {
    let listings = 0;
    fake = await startFake(
      zohoRoutes({
        '/messages/view': (_req, res) => {
          listings += 1;
          // Zoho returns 500, not 401, for an expired token on this endpoint.
          if (listings === 1) {
            raw(res, 500, { data: { errorCode: 'INVALID_OAUTHTOKEN' } });
            return true;
          }
          return false;
        },
      }),
    );

    const messages = await provider(fake.origin).listInbox();

    expect(messages).toHaveLength(2);
    expect(fake.requests.filter(r => r.url.startsWith('/oauth/v2/token'))).toHaveLength(2);
  });
});

// --- config ----------------------------------------------------------------

describe('loadZohoConfig', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads the credentials and defaults the region to .com', () => {
    Object.assign(process.env, {
      MAIL_USER: 'support@example.com',
      ZOHO_CLIENT_ID: 'id',
      ZOHO_CLIENT_SECRET: 'secret',
      ZOHO_REFRESH_TOKEN: 'refresh',
    });
    delete process.env.ZOHO_REGION;
    delete process.env.MAIL_FROM;

    const config = loadZohoConfig();
    expect(config.auth.region).toBe('com');
    expect(config.from.address).toBe('support@example.com');
    expect(config.accountId).toBeUndefined();
  });

  it('rejects a region that is not a Zoho data centre', () => {
    Object.assign(process.env, {
      MAIL_USER: 'support@example.com',
      ZOHO_CLIENT_ID: 'id',
      ZOHO_CLIENT_SECRET: 'secret',
      ZOHO_REFRESH_TOKEN: 'refresh',
      ZOHO_REGION: 'uk',
    });

    expect(() => loadZohoConfig()).toThrow(/ZOHO_REGION/);
  });
});
