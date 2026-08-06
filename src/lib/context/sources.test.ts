import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getWorkspaceConfig, resetWorkspaceConfig } from '../config/workspace';
import { openDb, setDb, type Db } from '../db';
import { createTask, updateTask } from '../tasks/store';
import { listContextSources, resetContextSources } from './registry';
import { buildDeclarativeSource, fill, readPath, type DeclarativeSpec } from './sources/declarative';
import { describeHistory, historySource, priorReplies } from './sources/history';
import type { LookupSubject } from './types';

let db: Db;
let dir: string;

const SUBJECT: LookupSubject = {
  taskId: 'task-1',
  email: 'alex+billing@example.com',
  name: 'Alex',
  subject: 'Refund please',
};

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  dir = mkdtempSync(join(tmpdir(), 'aas-sources-'));
  process.env.AAS_CONFIG = join(dir, 'absent.json');
  delete process.env.AAS_CONTEXT_SOURCES;
  delete process.env.STRIPE_API_KEY;
  resetContextSources();
  resetWorkspaceConfig();
});

afterEach(() => {
  setDb(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.AAS_CONFIG;
  delete process.env.AAS_CONTEXT_SOURCES;
  delete process.env.LOOKUP_TOKEN;
  resetContextSources();
  resetWorkspaceConfig();
});

// ---------------------------------------------------------------------------

describe('reading values out of a response', () => {
  const data = { user: { plan: 'pro', level: 2, tags: ['a', 'b'], deleted: false }, empty: '' };

  it('walks a dotted path', () => {
    expect(readPath(data, 'user.plan')).toBe('pro');
  });

  it('indexes into arrays', () => {
    expect(readPath(data, 'user.tags.1')).toBe('b');
  });

  it('returns undefined for a path that is not there, rather than throwing', () => {
    // Every one of these is a config typo away, and none of them may take down
    // the lookup, let alone the draft.
    expect(readPath(data, 'user.nope.deeper')).toBeUndefined();
    expect(readPath(null, 'user.plan')).toBeUndefined();
    expect(readPath(data, 'user.tags.x')).toBeUndefined();
  });

  it('fills a template from the response, falling back to the sender', () => {
    expect(fill('{user.plan} for {email}', data, SUBJECT)).toEqual({
      text: 'pro for alex+billing@example.com',
      complete: true,
    });
  });

  it('reports a template as incomplete when a value is missing', () => {
    expect(fill('{user.nope} credits', data, SUBJECT).complete).toBe(false);
  });

  it('treats an empty string as missing', () => {
    // A field that came back blank is not a fact worth a sentence.
    expect(fill('{empty}!', data, SUBJECT).complete).toBe(false);
  });

  it('treats a false flag as missing, so a flag can gate a sentence', () => {
    // The only useful thing a boolean does here: "they hold a lifetime
    // licence, never quote them a renewal date" must vanish for everyone who
    // does not, and there is no `if` in this format.
    expect(fill('{user.deleted}', data, SUBJECT).complete).toBe(false);
    expect(fill('{user.plan}', data, SUBJECT).complete).toBe(true);
  });

  it('gates on a value without printing it', () => {
    // Otherwise the sentence reads "... a lifetime licence (yes)".
    expect(fill('{?user.plan}They are a customer.', data, SUBJECT)).toEqual({
      text: 'They are a customer.',
      complete: true,
    });
    expect(fill('{?user.deleted}Closed account.', data, SUBJECT).complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('a lookup declared against an HTTP endpoint', () => {
  let server: Server;
  let base: string;
  let seen: { url: string; auth: string | undefined; method: string; body: string }[] = [];
  let respond: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

  beforeEach(async () => {
    seen = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          auth: req.headers.authorization,
          method: req.method ?? '',
          body,
        });
        const result = respond(req.url ?? '');
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(done => server.close(() => done()));
  });

  function spec(overrides: Partial<DeclarativeSpec> = {}): DeclarativeSpec {
    return {
      id: 'billing',
      label: 'Billing',
      url: `${base}/lookup?email={email}`,
      title: 'Account',
      ...overrides,
    };
  }

  it('url-encodes the address into the query string', async () => {
    respond = () => ({ status: 200, body: { plan: 'pro' } });
    await buildDeclarativeSource(spec({ fields: [{ label: 'Plan', path: 'plan' }] })).lookup(SUBJECT);

    // A raw `+` in a query string is a space, and the lookup would miss.
    expect(seen[0]!.url).toBe('/lookup?email=alex%2Bbilling%40example.com');
  });

  it('reads a token from the environment rather than the config file', async () => {
    process.env.LOOKUP_TOKEN = 'secret-value';
    respond = () => ({ status: 200, body: { plan: 'pro' } });

    await buildDeclarativeSource(
      spec({ headers: { Authorization: 'Bearer ${LOOKUP_TOKEN}' }, fields: [{ label: 'Plan', path: 'plan' }] }),
    ).lookup(SUBJECT);

    expect(seen[0]!.auth).toBe('Bearer secret-value');
  });

  it('turns codes into words the model does not have to guess at', async () => {
    respond = () => ({ status: 200, body: { user: { level: 2, credits: 40 } } });

    const block = await buildDeclarativeSource(
      spec({
        root: 'user',
        fields: [
          { label: 'Plan', path: 'level', map: { '0': 'Free', '1': 'Pro', '2': 'Unlimited' } },
          { label: 'Credits', path: 'credits', suffix: 'left' },
        ],
        prompt: 'They are on the {level} plan.',
      }),
    ).lookup(SUBJECT);

    expect(block!.fields).toEqual([
      { label: 'Plan', value: 'Unlimited' },
      { label: 'Credits', value: '40 left' },
    ]);
    // The prompt gets the raw value; `map` is for the reviewer's card. A spec
    // that wants the word in the sentence writes the word in the sentence.
    expect(block!.prompt).toBe('They are on the 2 plan.');
  });

  it('joins a punctuation suffix tight, because nobody writes 95 %', async () => {
    respond = () => ({ status: 200, body: { rate: 95, days: 3 } });

    const block = await buildDeclarativeSource(
      spec({
        fields: [
          { label: 'Success rate', path: 'rate', suffix: '%' },
          { label: 'Trial', path: 'days', suffix: 'days left' },
        ],
      }),
    ).lookup(SUBJECT);

    expect(block!.fields).toEqual([
      { label: 'Success rate', value: '95%' },
      { label: 'Trial', value: '3 days left' },
    ]);
  });

  it('puts the unit in front where that is where the unit goes', async () => {
    // The alternative is a `map` enumerating every level the product will ever
    // have, which is not a mapping — it is the absence of a prefix.
    respond = () => ({ status: 200, body: { level: 2, balance: 40, plan: 'Pro' } });

    const block = await buildDeclarativeSource(
      spec({
        fields: [
          { label: 'Level', path: 'level', prefix: 'Lv.' },
          { label: 'Balance', path: 'balance', prefix: '$' },
          { label: 'On', path: 'plan', prefix: 'Plan' },
        ],
      }),
    ).lookup(SUBJECT);

    expect(block!.fields).toEqual([
      { label: 'Level', value: 'Lv.2' },
      { label: 'Balance', value: '$40' },
      { label: 'On', value: 'Plan Pro' },
    ]);
  });

  it('drops a sentence whose facts are missing instead of leaving a hole in it', async () => {
    respond = () => ({ status: 200, body: { plan: 'pro' } });

    const block = await buildDeclarativeSource(
      spec({
        fields: [{ label: 'Plan', path: 'plan' }],
        prompt: ['They are on the {plan} plan.', 'They have {credits} credits, expiring {expiry}.'],
      }),
    ).lookup(SUBJECT);

    expect(block!.prompt).toBe('They are on the pro plan.');
  });

  it('drops a field whose path is missing', async () => {
    respond = () => ({ status: 200, body: { plan: 'pro' } });

    const block = await buildDeclarativeSource(
      spec({ fields: [{ label: 'Plan', path: 'plan' }, { label: 'Seats', path: 'seats' }] }),
    ).lookup(SUBJECT);

    expect(block!.fields).toEqual([{ label: 'Plan', value: 'pro' }]);
  });

  it('says nothing when the record the spec requires is absent', async () => {
    // The common shape of "no such user": a 200 and an empty envelope.
    respond = () => ({ status: 200, body: { found: false, user: null } });

    const block = await buildDeclarativeSource(
      spec({ requires: 'user.id', root: 'user', fields: [{ label: 'Plan', path: 'plan' }] }),
    ).lookup(SUBJECT);

    expect(block).toBeNull();
  });

  it('treats a 404 as an answer, not a failure', async () => {
    respond = () => ({ status: 404, body: {} });
    await expect(buildDeclarativeSource(spec()).lookup(SUBJECT)).resolves.toBeNull();
  });

  it('throws on a server error so the queue reports which lookup is broken', async () => {
    respond = () => ({ status: 500, body: {} });
    await expect(buildDeclarativeSource(spec()).lookup(SUBJECT)).rejects.toThrow(/billing lookup returned 500/);
  });

  it('posts a body with the address substituted when asked to', async () => {
    respond = () => ({ status: 200, body: { plan: 'pro' } });

    await buildDeclarativeSource(
      spec({
        url: `${base}/search`,
        method: 'POST',
        body: { query: { email: '{email}' }, limit: 1 },
        fields: [{ label: 'Plan', path: 'plan' }],
      }),
    ).lookup(SUBJECT);

    expect(seen[0]!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.body)).toEqual({ query: { email: 'alex+billing@example.com' }, limit: 1 });
  });

  it('links the card out to the record', async () => {
    respond = () => ({ status: 200, body: { id: 42, plan: 'pro' } });

    const block = await buildDeclarativeSource(
      spec({ href: 'https://admin.example/users/{id}', fields: [{ label: 'Plan', path: 'plan' }] }),
    ).lookup(SUBJECT);

    expect(block!.href).toBe('https://admin.example/users/42');
  });

  it('cannot be given an action to perform', () => {
    // Same guard as the built-in sources: a declared lookup produces exactly
    // the read-only interface, and there is nowhere to hang a `refund` on it.
    const built = buildDeclarativeSource(spec());
    expect(Object.keys(built).sort()).toEqual(['id', 'label', 'lookup']);
  });
});

// ---------------------------------------------------------------------------

describe('a lookup declared against a command', () => {
  function script(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it('reads JSON from stdout and ignores progress on stderr', async () => {
    const path = script(
      'lookup.js',
      `process.stderr.write('fetching page 1...\\n');
       console.log(JSON.stringify({ found: true, plan: 'L2', credits: 40 }));`,
    );

    const block = await buildDeclarativeSource({
      id: 'admin',
      label: 'Admin',
      command: ['node', path, '{email}'],
      title: 'Admin',
      requires: 'found',
      fields: [{ label: 'Plan', path: 'plan' }],
      prompt: 'They have {credits} credits.',
    }).lookup(SUBJECT);

    expect(block).toMatchObject({
      title: 'Admin',
      fields: [{ label: 'Plan', value: 'L2' }],
      prompt: 'They have 40 credits.',
    });
  });

  it('passes the address as an argument, so a quote in it cannot run anything', async () => {
    // The system this replaced built the command by string concatenation:
    // execSync('node lookup.js "' + email + '"'). This is that bug's test.
    const marker = join(dir, 'pwned');
    const path = script('echo-argv.js', `console.log(JSON.stringify({ got: process.argv[2] }));`);

    const block = await buildDeclarativeSource({
      id: 'admin',
      label: 'Admin',
      command: ['node', path, '{email}'],
      title: 'Admin',
      fields: [{ label: 'Got', path: 'got' }],
    }).lookup({ ...SUBJECT, email: `a@b.c"; touch ${marker}; echo "` });

    expect(block!.fields[0]!.value).toBe(`a@b.c"; touch ${marker}; echo "`);
    expect(() => rmSync(marker)).toThrow();
  });

  it('reads pretty-printed JSON with objects nested inside it', async () => {
    // The scripts worth pointing at print `JSON.stringify(stats, null, 2)`.
    // The system this replaced scanned for the first line that was exactly
    // `}`, which is the close of the first nested object, so a stats blob with
    // a languages map in it was truncated into a parse error.
    const path = script(
      'stats.js',
      `console.log(JSON.stringify({ totalFiles: 12, languages: { en: 9, ja: 3 }, successRate: 95 }, null, 2));`,
    );

    const block = await buildDeclarativeSource({
      id: 'usage',
      label: 'Usage',
      command: ['node', path, '{email}', '--json'],
      title: 'Usage',
      requires: 'totalFiles',
      fields: [{ label: 'Success rate', path: 'successRate', suffix: '%' }],
      prompt: 'They have run {totalFiles} files, mostly in {languages.en}.',
    }).lookup(SUBJECT);

    expect(block).toMatchObject({
      fields: [{ label: 'Success rate', value: '95%' }],
      prompt: 'They have run 12 files, mostly in 9.',
    });
  });

  it('says nothing when the command prints no JSON', async () => {
    const path = script('quiet.js', `process.stderr.write('nothing found\\n');`);

    await expect(
      buildDeclarativeSource({ id: 'a', label: 'A', command: ['node', path], title: 'A' }).lookup(SUBJECT),
    ).resolves.toBeNull();
  });

  it('turns a timestamp into a date a person can read', async () => {
    // Every JSON API answers with one of these and nobody wants to read it —
    // least of all a model being asked to write "your credits expire on ...".
    // Left raw, that sentence ends in an ISO string the model either quotes
    // back at a customer or tries to do arithmetic on.
    const path = script(
      'expiry.js',
      `console.log(JSON.stringify({ expires: '2026-09-17T00:00:00.000Z' }));`,
    );

    const block = await buildDeclarativeSource({
      id: 'account',
      label: 'Account',
      command: ['node', path],
      title: 'Account',
      fields: [{ label: 'Expires', path: 'expires' }],
      prompt: 'Their credits start expiring {expires}.',
    }).lookup(SUBJECT);

    expect(block!.fields[0]!.value).toBe('17 September 2026');
    expect(block!.prompt).toBe('Their credits start expiring 17 September 2026.');
  });

  it('leaves a plain date, and anything date-shaped, alone', async () => {
    // A bare date already says what it means. The reason to rewrite is that a
    // timestamp is unreadable, not that dates should be prettier.
    const path = script(
      'joined.js',
      `console.log(JSON.stringify({ joined: '2026-02-04', code: 'PLAN-2026-09-17' }));`,
    );

    const block = await buildDeclarativeSource({
      id: 'account',
      label: 'Account',
      command: ['node', path],
      title: 'Account',
      fields: [
        { label: 'Joined', path: 'joined' },
        { label: 'Code', path: 'code' },
      ],
    }).lookup(SUBJECT);

    expect(block!.fields.map(field => field.value)).toEqual(['2026-02-04', 'PLAN-2026-09-17']);
  });

  it('fails loudly when the command does', async () => {
    const path = script('boom.js', `process.exit(3);`);

    await expect(
      buildDeclarativeSource({ id: 'a', label: 'A', command: ['node', path], title: 'A' }).lookup(SUBJECT),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('declaring a source in the config file', () => {
  it('builds one from a spec, alongside the ones loaded from a path', async () => {
    writeFileSync(
      join(dir, 'aas.config.json'),
      JSON.stringify({
        organization: 'Acme',
        contextSources: [
          { id: 'admin', label: 'Admin', url: 'https://x.example/{email}', title: 'Admin' },
          42,
        ],
      }),
    );
    process.env.AAS_CONFIG = join(dir, 'aas.config.json');
    resetWorkspaceConfig();
    resetContextSources();

    // The junk entry is dropped where it is read, not where it is used.
    expect(getWorkspaceConfig().contextSources).toHaveLength(1);
    expect((await listContextSources()).map(s => s.id)).toEqual(['history', 'admin']);
  });
});

// ---------------------------------------------------------------------------

describe('what we have already said to this person', () => {
  function sent(email: string, overrides: { subject?: string; draft?: string; final?: string; at?: string } = {}) {
    const { task } = createTask(
      { subject: overrides.subject ?? 'Earlier question', fromAddress: email, body: 'hi' },
      db,
    );
    updateTask(
      task.id,
      {
        status: 'sent',
        draft: overrides.draft ?? 'the draft as written',
        finalReply: overrides.final ?? 'the draft as written',
        sentAt: overrides.at ?? new Date().toISOString(),
      },
      db,
    );
    return task.id;
  }

  it('says nothing about a first-time sender', async () => {
    const { task } = createTask({ subject: 'Hi', fromAddress: 'new@example.com', body: 'x' }, db);
    // The absence of the card is the message, and it costs no tokens.
    expect(await historySource.lookup({ taskId: task.id, email: 'new@example.com', name: null, subject: 'Hi' })).toBeNull();
  });

  it('matches the address however it was capitalised', async () => {
    sent('Alex@Example.com');
    expect(priorReplies('alex@example.com', 'other', db)).toHaveLength(1);
  });

  it('does not count the email being answered right now', async () => {
    const id = sent('alex@example.com');
    expect(priorReplies('alex@example.com', id, db)).toHaveLength(0);
  });

  it('counts the replies and dates the most recent one', () => {
    const block = describeHistory([
      { id: 't1', subject: 'Refund status', sent_at: daysAgo(3), draft: 'a', final_reply: 'a' },
      { id: 't2', subject: 'Login trouble', sent_at: daysAgo(40), draft: 'a', final_reply: 'a' },
    ])!;

    expect(block.prompt).toContain('replied to them 2 times before, most recently 3 days ago');
    expect(block.prompt).toContain('"Refund status"');
    expect(block.fields).toContainEqual({ label: 'Replies sent', value: '2' });
  });

  it('warns when this person\'s drafts keep getting rewritten', () => {
    const block = describeHistory([
      { id: 't1', subject: 'a', sent_at: daysAgo(1), draft: 'the draft we generated', final_reply: 'totally unrelated wording entirely' },
      { id: 't2', subject: 'b', sent_at: daysAgo(2), draft: 'another generated draft', final_reply: 'something else altogether different' },
    ])!;

    expect(block.prompt).toContain('usually been rewritten before sending (2 of 2)');
  });

  it('stays quiet when the drafts were sent as written', () => {
    const block = describeHistory([
      { id: 't1', subject: 'a', sent_at: daysAgo(1), draft: 'the draft we generated', final_reply: 'the draft we generated' },
      { id: 't2', subject: 'b', sent_at: daysAgo(2), draft: 'the draft we generated', final_reply: 'the draft we generated!' },
    ])!;

    expect(block.prompt).not.toContain('rewritten');
  });

  it('needs no credentials, and so is always on', async () => {
    expect((await listContextSources()).map(s => s.id)).toContain('history');
  });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
