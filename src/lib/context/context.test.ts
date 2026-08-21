import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetWorkspaceConfig } from '../config/workspace';
import { openDb, type Db } from '../db';
import { listJobs } from '../queue/store';
import {
  COMPOSE_MESSAGE,
  DRAFT_REPLY,
  ENRICH_CONTEXT,
  enqueueContextThenCompose,
  enqueueContextThenDraft,
  enqueueForDrafting,
  TRIAGE,
  enrichContextHandler,
} from '../queue/handlers';
import { createTask } from '../tasks/store';
import type { Task } from '../tasks/types';
import { describeContext, gatherContext } from './gather';
import { listContextSources, resetContextSources, setContextSources } from './registry';
import { stripeSource } from './sources/stripe';
import { clearContext, listContext, saveContext } from './store';
import { coerceBlock, type ContextBlock, type ContextSource } from './types';

let db: Db;
let dir: string;

function source(id: string, block: ContextBlock | null, fail?: string): ContextSource {
  return {
    id,
    label: `Source ${id}`,
    async lookup() {
      if (fail) throw new Error(fail);
      return block;
    },
  };
}

function task(overrides: Partial<Task> = {}): Task {
  const { task: created } = createTask(
    { subject: 'Refund please', fromAddress: 'alex@example.com', fromName: 'Alex', body: 'hi' },
    db,
  );
  return { ...created, ...overrides };
}

const BLOCK: ContextBlock = {
  title: 'Billing',
  fields: [{ label: 'Plan', value: 'Pro' }],
  prompt: 'Pro subscriber since March 2024.',
};

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'aas-context-'));
  process.env.AAS_CONFIG = join(dir, 'absent.json');
  delete process.env.AAS_CONTEXT_SOURCES;
  delete process.env.STRIPE_API_KEY;
  resetContextSources();
  // The workspace config is memoised, so without this every test after the
  // first reads the first one's AAS_CONFIG however often it is re-pointed.
  resetWorkspaceConfig();
});

afterEach(() => {
  db.close();
  resetWorkspaceConfig();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.AAS_CONFIG;
  delete process.env.AAS_CONTEXT_SOURCES;
  delete process.env.STRIPE_API_KEY;
  resetContextSources();
});

describe('what a source is allowed to return', () => {
  it('keeps a well-formed block', () => {
    expect(coerceBlock(BLOCK)).toEqual(BLOCK);
  });

  it('survives a source written against a different version of the interface', () => {
    // The whole point of coercing: this is code the repository has never seen.
    const block = coerceBlock({
      title: '  Billing  ',
      fields: [
        { label: 'Plan', value: 2 },
        { label: 'Broken' },
        'not a field',
        null,
        { value: 'no label' },
      ],
      prompt: 'ok',
      href: '   ',
    });

    expect(block).toEqual({
      title: 'Billing',
      fields: [
        { label: 'Plan', value: '2' },
        { label: 'Broken', value: '' },
      ],
      prompt: 'ok',
    });
  });

  it('rejects a block with nothing in it', () => {
    expect(coerceBlock(null)).toBeNull();
    expect(coerceBlock({ title: 'Billing', fields: [], prompt: '' })).toBeNull();
    expect(coerceBlock({ fields: [{ label: 'a', value: 'b' }] })).toBeNull();
  });

  it('drops a link the review screen would run as script', () => {
    // React escapes text and does nothing at all to an href, so this string
    // reaching `<a href>` executes with the reviewer's session on one click.
    // The block still stands — the reviewer loses a link, not the card.
    const block = coerceBlock({
      title: 'Billing',
      fields: [
        { label: 'Account', value: 'cus_1', href: 'javascript:fetch("/api/x",{method:"POST"})' },
        { label: 'Invoice', value: 'in_1', href: 'data:text/html,<script>alert(1)</script>' },
        { label: 'Portal', value: 'open', href: '//evil.example/looks-like-a-path' },
      ],
      prompt: 'ok',
      href: 'JavaScript:alert(1)',
    });

    expect(block?.href).toBeUndefined();
    expect(block?.fields.every(f => f.href === undefined)).toBe(true);
  });

  it('keeps the links a system of record is actually written in', () => {
    const block = coerceBlock({
      title: 'Billing',
      fields: [
        { label: 'Customer', value: 'Alex', href: 'https://dashboard.stripe.com/customers/cus_1' },
        { label: 'Email', value: 'alex@example.com', href: 'mailto:alex@example.com' },
        // The built-in sources link into this app by path.
        { label: 'Payments', value: '3', href: '/billing/alex%40example.com' },
      ],
      prompt: 'ok',
      href: 'http://crm.internal/alex',
    });

    expect(block?.fields.map(f => f.href)).toEqual([
      'https://dashboard.stripe.com/customers/cus_1',
      'mailto:alex@example.com',
      '/billing/alex%40example.com',
    ]);
    expect(block?.href).toBe('http://crm.internal/alex');
  });

  it('allows a display-only block that costs no tokens', () => {
    const block = coerceBlock({ title: 'Ticket', fields: [{ label: 'ID', value: 'T-1' }], prompt: '' });
    expect(block?.prompt).toBe('');
  });
});

describe('gathering', () => {
  it('runs every source and keeps what each returned', async () => {
    const t = task();
    const result = await gatherContext(t, {
      db,
      sources: [source('a', BLOCK), source('b', { ...BLOCK, title: 'CRM' })],
    });

    expect(result.found.sort()).toEqual(['a', 'b']);
    expect(listContext(t.id, db).map(b => b.title)).toEqual(['Billing', 'CRM']);
  });

  it('lets one source fail without taking the others with it', async () => {
    const t = task();
    const result = await gatherContext(t, {
      db,
      sources: [source('crm', null, 'CRM is down'), source('billing', BLOCK)],
    });

    expect(result.failed).toEqual([{ id: 'crm', error: 'CRM is down' }]);
    expect(result.found).toEqual(['billing']);
    // The reply still gets written, with less to go on.
    expect(listContext(t.id, db)).toHaveLength(1);
  });

  it('treats "nothing to say" as neither a result nor a failure', async () => {
    const t = task();
    const result = await gatherContext(t, { db, sources: [source('a', null)] });

    expect(result).toMatchObject({ found: [], empty: ['a'], failed: [] });
    expect(listContext(t.id, db)).toHaveLength(0);
  });

  it('discards a malformed block rather than storing it', async () => {
    const t = task();
    const rogue: ContextSource = {
      id: 'rogue',
      label: 'Rogue',
      async lookup() {
        return { title: 'X' } as unknown as ContextBlock;
      },
    };

    await gatherContext(t, { db, sources: [rogue] });
    expect(listContext(t.id, db)).toHaveLength(0);
  });

  it('re-running replaces a source\'s row instead of duplicating it', async () => {
    const t = task();
    await gatherContext(t, { db, sources: [source('a', BLOCK)] });
    await gatherContext(t, { db, sources: [source('a', { ...BLOCK, prompt: 'Now on Unlimited.' })] });

    const stored = listContext(t.id, db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.prompt).toBe('Now on Unlimited.');
  });

  it('does nothing for a task with no sender', async () => {
    const t = { ...task(), fromAddress: '' };
    const result = await gatherContext(t, { db, sources: [source('a', BLOCK)] });
    expect(result.found).toEqual([]);
  });
});

describe('the prompt block', () => {
  it('reads as sentences, not as a data dump', () => {
    const text = describeContext([
      { ...BLOCK, taskId: 't', sourceId: 'a', label: 'Billing', createdAt: '' },
    ]);

    expect(text).toContain('### Billing');
    expect(text).toContain('Pro subscriber since March 2024.');
    expect(text).not.toContain('{');
  });

  it('spends tokens on the card values too, not only on the prose', () => {
    const text = describeContext([
      {
        title: 'Account',
        fields: [
          { label: 'Plan', value: 'Free' },
          { label: 'User', value: 'ChSey' },
          // Nothing to say, and nothing to pay for saying it.
          { label: 'Company', value: '' },
        ],
        prompt: 'They registered on July 14, 2026.',
        taskId: 't',
        sourceId: 'a',
        label: 'Account',
        createdAt: '',
      },
    ]);

    expect(text).toContain('Plan: Free · User: ChSey\nThey registered on July 14, 2026.');
    expect(text).not.toContain('Company');
  });

  it('reads a block that is all values and no prose', () => {
    const text = describeContext([
      { title: 'Ticket', fields: [{ label: 'ID', value: 'T-1' }], prompt: '', taskId: 't', sourceId: 'a', label: 'T', createdAt: '' },
    ]);
    expect(text).toContain('### Ticket\nID: T-1');
  });

  it('leaves out a block with nothing in it either way', () => {
    const text = describeContext([
      { title: 'Ticket', fields: [], prompt: '', taskId: 't', sourceId: 'a', label: 'T', createdAt: '' },
    ]);
    expect(text).toBe('');
  });

  it('is empty when there is no context, so the prompt is unchanged', () => {
    expect(describeContext([])).toBe('');
  });
});

describe('the registry', () => {
  it('leaves an unconfigured built-in out', async () => {
    // No STRIPE_API_KEY: Stripe must not appear, and must not be asked to run.
    // History does, always — it needs no credentials and no configuration.
    expect((await listContextSources()).map(s => s.id)).toEqual(['history']);
  });

  it('includes a built-in once it has credentials', async () => {
    process.env.STRIPE_API_KEY = 'rk_test_x';
    resetContextSources();
    expect((await listContextSources()).map(s => s.id)).toEqual(['history', 'stripe']);
  });

  it('loads an external source from a path', async () => {
    const path = join(dir, 'crm.mjs');
    writeFileSync(
      path,
      `export default {
         id: 'crm', label: 'CRM',
         async lookup() { return { title: 'CRM', fields: [], prompt: 'Enterprise account.' }; },
       };`,
    );
    process.env.AAS_CONTEXT_SOURCES = path;
    resetContextSources();

    const sources = await listContextSources();
    expect(sources.map(s => s.id)).toEqual(['history', 'crm']);
    expect(await sources[1]!.lookup({ taskId: 't', email: 'a@b.c', name: null, subject: '' })).toMatchObject(
      { prompt: 'Enterprise account.' },
    );
  });

  it('ignores a source that will not load rather than stopping the mail', async () => {
    const path = join(dir, 'broken.mjs');
    writeFileSync(path, 'this is not javascript {{{');
    process.env.AAS_CONTEXT_SOURCES = `${path},${join(dir, 'absent.mjs')}`;
    resetContextSources();

    expect((await listContextSources()).map(s => s.id)).toEqual(['history']);
  });

  it('ignores a module that exports the wrong shape', async () => {
    const path = join(dir, 'wrong.mjs');
    writeFileSync(path, 'export default { hello: "world" };');
    process.env.AAS_CONTEXT_SOURCES = path;
    resetContextSources();

    expect((await listContextSources()).map(s => s.id)).toEqual(['history']);
  });

  it('keeps the first of two sources claiming the same id', async () => {
    const a = join(dir, 'a.mjs');
    const b = join(dir, 'b.mjs');
    writeFileSync(a, `export default { id: 'dup', label: 'A', async lookup() { return null; } };`);
    writeFileSync(b, `export default { id: 'dup', label: 'B', async lookup() { return null; } };`);
    process.env.AAS_CONTEXT_SOURCES = `${a},${b}`;
    resetContextSources();

    const sources = (await listContextSources()).filter(s => s.id === 'dup');
    expect(sources).toHaveLength(1);
    expect(sources[0]!.label).toBe('A');
  });

  it('has no way to make a source act', () => {
    // Not a type test for its own sake. If a `send`/`refund`/`cancel` ever
    // appears on this interface, the product's one promise is broken, and this
    // is where that gets noticed.
    const keys = Object.keys(stripeSource);
    expect(keys.sort()).toEqual(['configured', 'id', 'label', 'lookup']);
  });
});

describe('the enrichment job', () => {
  it('triages before anything is looked up or written', async () => {
    // The step that can make both of the others unnecessary, so it goes
    // first — see `handlers/triage`.
    setContextSources([source('a', BLOCK)]);
    const t = task();
    await enqueueForDrafting(t.id, { db });

    expect(listJobs({ type: TRIAGE }, db)).toHaveLength(1);
    expect(listJobs({ type: ENRICH_CONTEXT }, db)).toHaveLength(0);
    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(0);
  });

  it('drafts directly when no sources are configured', async () => {
    setContextSources([]);
    const t = task();
    await enqueueContextThenDraft(t.id, { db });

    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(1);
    // No no-op job cluttering the queue of an install that has no sources.
    expect(listJobs({ type: ENRICH_CONTEXT }, db)).toHaveLength(0);
  });

  it('looks the sender up first when there are sources', async () => {
    setContextSources([source('a', BLOCK)]);
    const t = task();
    await enqueueContextThenDraft(t.id, { db });

    const [job] = listJobs({ type: ENRICH_CONTEXT }, db);
    expect(job).toBeDefined();
    // Ahead of drafting, or a drain would write the reply before looking.
    expect(job!.priority).toBeLessThan(5);
    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(0);
  });

  it('hands over to drafting when it is done', async () => {
    setContextSources([source('a', BLOCK)]);
    const t = task();

    const result = (await enrichContextHandler(
      { taskId: t.id },
      { db, job: { id: 'j', type: ENRICH_CONTEXT } as never },
    )) as { found: string[] };

    expect(result.found).toEqual(['a']);
    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(1);
  });

  it('carries a redraft’s "no critic" the whole way to the drafter', async () => {
    // Two hops between the button and the job that acts on it, and the flag
    // was lost at either of them without this: the reviewer waits the extra
    // ninety seconds for a second opinion they did not ask for.
    setContextSources([source('a', BLOCK)]);
    const t = task();
    await enqueueContextThenDraft(t.id, { db, critic: false });

    const [enrich] = listJobs({ type: ENRICH_CONTEXT }, db);
    expect((enrich!.payload as { critic?: boolean }).critic).toBe(false);

    await enrichContextHandler(
      { taskId: t.id, critic: false },
      { db, job: { id: 'j', type: ENRICH_CONTEXT } as never },
    );

    const [draft] = listJobs({ type: DRAFT_REPLY }, db);
    expect((draft!.payload as { critic?: boolean }).critic).toBe(false);
  });

  it('carries which of the two buttons was pressed the same distance', async () => {
    // Same two hops, same failure: the choice is made on the review screen and
    // acted on in the drafter, and a mode dropped in between silently hands
    // back the other behaviour — a rewrite where an amendment was asked for
    // throws away edits somebody typed by hand.
    setContextSources([source('a', BLOCK)]);
    const t = task();
    await enqueueContextThenDraft(t.id, { db, critic: false, mode: 'rewrite' });

    const [enrich] = listJobs({ type: ENRICH_CONTEXT }, db);
    expect((enrich!.payload as { mode?: string }).mode).toBe('rewrite');

    await enrichContextHandler(
      { taskId: t.id, critic: false, mode: 'rewrite' },
      { db, job: { id: 'j', type: ENRICH_CONTEXT } as never },
    );

    const [draft] = listJobs({ type: DRAFT_REPLY }, db);
    expect((draft!.payload as { mode?: string }).mode).toBe('rewrite');
  });

  it('leaves the mode off a draft nobody redrafted', async () => {
    // Absent rather than defaulted, because absent is what the drafter's own
    // fallback is written for: a first draft has nothing to amend, and a
    // payload that claimed a mode would be asserting a choice nobody made.
    setContextSources([]);
    const t = task();
    await enqueueContextThenDraft(t.id, { db });

    const [draft] = listJobs({ type: DRAFT_REPLY }, db);
    expect((draft!.payload as { mode?: string }).mode).toBeUndefined();
  });

  it('leaves the critic on for everybody who did not ask', async () => {
    setContextSources([]);
    const t = task();
    await enqueueContextThenDraft(t.id, { db });

    const [draft] = listJobs({ type: DRAFT_REPLY }, db);
    expect((draft!.payload as { critic?: boolean }).critic).toBe(true);
  });

  it('still drafts when every lookup failed', async () => {
    setContextSources([source('a', null, 'boom')]);
    const t = task();

    const result = (await enrichContextHandler(
      { taskId: t.id },
      { db, job: { id: 'j', type: ENRICH_CONTEXT } as never },
    )) as { failed?: { id: string }[] };

    expect(result.failed).toEqual([{ id: 'a', error: 'boom' }]);
    // A CRM being down slows the reply down. It must not stop it.
    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(1);
  });

  it('does not look up someone whose reply has already gone', async () => {
    setContextSources([source('a', BLOCK)]);
    const t = task();
    db.prepare("UPDATE tasks SET status = 'sent' WHERE id = ?").run(t.id);

    const result = await enrichContextHandler(
      { taskId: t.id },
      { db, job: { id: 'j', type: ENRICH_CONTEXT } as never },
    );

    expect(result).toEqual({ skipped: 'sent' });
    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(0);
  });

  it('looks the sender up before mail the desk is starting too', async () => {
    // The composed path used to skip this entirely: the same address arriving
    // as a review handed in over the API got a blank screen, and arriving as
    // an email got a card.
    setContextSources([source('a', BLOCK)]);
    const t = task();
    await enqueueContextThenCompose(t.id, { db });

    expect(listJobs({ type: ENRICH_CONTEXT }, db)).toHaveLength(1);
    expect(listJobs({ type: COMPOSE_MESSAGE }, db)).toHaveLength(0);
  });

  it('hands a composed task back to composing, not to replying', async () => {
    setContextSources([source('a', BLOCK)]);
    const t = task();

    await enrichContextHandler(
      { taskId: t.id, then: 'compose' },
      { db, job: { id: 'j', type: ENRICH_CONTEXT } as never },
    );

    // Down the reply path it would answer a letter nobody sent.
    expect(listJobs({ type: COMPOSE_MESSAGE }, db)).toHaveLength(1);
    expect(listJobs({ type: DRAFT_REPLY }, db)).toHaveLength(0);
  });

  it('composes anyway when every lookup failed', async () => {
    setContextSources([source('a', null, 'boom')]);
    const t = task();

    await enrichContextHandler(
      { taskId: t.id, then: 'compose' },
      { db, job: { id: 'j', type: ENRICH_CONTEXT } as never },
    );

    expect(listJobs({ type: COMPOSE_MESSAGE }, db)).toHaveLength(1);
  });

  it('composes directly when no sources are configured', async () => {
    setContextSources([]);
    const t = task();
    await enqueueContextThenCompose(t.id, { db });

    expect(listJobs({ type: COMPOSE_MESSAGE }, db)).toHaveLength(1);
    expect(listJobs({ type: ENRICH_CONTEXT }, db)).toHaveLength(0);
  });

  it('rejects a payload with no task id, permanently', async () => {
    await expect(
      enrichContextHandler({}, { db, job: { id: 'j', type: ENRICH_CONTEXT } as never }),
    ).rejects.toThrow(/taskId/);
  });
});

describe('storage', () => {
  it('reads back a row whose fields column got mangled', () => {
    const t = task();
    saveContext(t.id, 'a', 'A', BLOCK, db);
    db.prepare('UPDATE task_context SET fields = ? WHERE task_id = ?').run('{not json', t.id);

    // Reading a row must not throw. The reviewer loses the fields, not the page.
    const [stored] = listContext(t.id, db);
    expect(stored!.fields).toEqual([]);
    expect(stored!.prompt).toBe(BLOCK.prompt);
  });

  it('goes when the task goes', () => {
    const t = task();
    saveContext(t.id, 'a', 'A', BLOCK, db);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    expect(listContext(t.id, db)).toHaveLength(0);
  });

  it('can be cleared for one task', () => {
    const t = task();
    saveContext(t.id, 'a', 'A', BLOCK, db);
    expect(clearContext(t.id, db)).toBe(1);
    expect(listContext(t.id, db)).toHaveLength(0);
  });
});

// --- Stripe, against a real server that speaks Stripe's shapes -------------

describe('the Stripe source', () => {
  let server: Server;
  let requests: string[];
  let responses: Map<string, unknown>;
  /** Set by the one test about a key Stripe will not accept. */
  let rejectKey: boolean;

  beforeEach(async () => {
    requests = [];
    responses = new Map();
    rejectKey = false;

    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const path = (req.url ?? '').split('?')[0]!;
      const body = responses.get(path);

      if (rejectKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'Invalid API Key provided: rk_test_***',
            },
          }),
        );
        return;
      }

      if (body === undefined) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no stub for ${path}` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    process.env.STRIPE_API_KEY = 'rk_test_x';
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function stub(customer: unknown, subscriptions: unknown[] = [], charges: unknown[] = []) {
    responses.set('/v1/customers', { data: customer ? [customer] : [] });
    responses.set('/v1/subscriptions', { data: subscriptions });
    responses.set('/v1/charges', { data: charges });
  }

  async function lookup(email = 'alex@example.com') {
    const { port } = server.address() as AddressInfo;
    // The source reads its base URL from nowhere, so point fetch at the stub by
    // overriding the module's constant through the environment it does read.
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      original(String(input).replace('https://api.stripe.com', `http://127.0.0.1:${port}`), init)) as typeof fetch;

    try {
      return await stripeSource.lookup({
        taskId: 't',
        email,
        name: 'Alex',
        subject: 'Refund',
      });
    } finally {
      globalThis.fetch = original;
    }
  }

  const NOW = Math.floor(Date.parse('2026-03-01T00:00:00Z') / 1000);

  it('says so plainly when the address has never paid', async () => {
    stub(null);
    const block = await lookup();

    expect(block!.prompt).toMatch(/does not exist in the billing system/);
    // And warns the model off the two wrong conclusions.
    expect(block!.prompt).toMatch(/do not assert either/i);
  });

  it('describes an active subscriber in sentences', async () => {
    stub(
      { id: 'cus_1', created: NOW, name: 'Alex' },
      [
        {
          id: 'sub_1',
          status: 'active',
          current_period_end: NOW + 86_400 * 30,
          cancel_at_period_end: false,
          items: { data: [{ price: { nickname: 'Pro', unit_amount: 1900, currency: 'usd', recurring: { interval: 'month' } } }] },
        },
      ],
      [{ amount: 1900, currency: 'usd', paid: true, refunded: false, created: NOW, status: 'succeeded' }],
    );

    const block = await lookup();

    expect(block!.prompt).toContain('active subscription (Pro — 19 USD/month)');
    expect(block!.prompt).toContain('renews 2026-03-31');
    expect(block!.prompt).toContain('Every charge on the account, newest first: 2026-03-01 19 USD paid.');
    expect(block!.fields.map(f => f.label)).toEqual([
      'Customer',
      'Since',
      'Subscription',
      'Renews',
      'Paid',
      'Payments',
    ]);
  });

  it('offers a way through to the charge-by-charge screen', async () => {
    // The card is a summary, and the question after a billing summary is
    // always "which payment, and how much of it came back" — which a total
    // cannot answer. The link has to survive an address with a + in it.
    stub(
      { id: 'cus_1', created: NOW, email: 'lin+billing@example.com' },
      [],
      [],
    );

    const block = await lookup('lin+billing@example.com');

    expect(block!.fields.find(f => f.label === 'Payments')?.href).toBe(
      '/billing/lin%2Bbilling%40example.com',
    );
  });

  it('warns the model off treating a lapsed customer as current', async () => {
    stub({ id: 'cus_1', created: NOW }, [
      { id: 'sub_1', status: 'canceled', current_period_end: NOW, cancel_at_period_end: false, items: { data: [] } },
    ]);

    const block = await lookup();
    expect(block!.prompt).toMatch(/No active subscription/);
    expect(block!.prompt).toMatch(/Do not talk to them as a current subscriber/);
  });

  it('flags an already-refunded charge, which is the thing to not get wrong', async () => {
    stub({ id: 'cus_1', created: NOW }, [], [
      { amount: 5000, currency: 'usd', paid: true, refunded: true, created: NOW, status: 'succeeded' },
    ]);

    const block = await lookup();
    expect(block!.prompt).toContain('2026-03-01 50 USD refunded in full');
    // And the total says nothing came of it, rather than counting it as paid.
    expect(block!.prompt).toContain('kept paying 0 USD');
  });

  it('gives the model the whole ledger rather than a summary of it', async () => {
    // Every charge on the account behind the ticket that found this: a monthly
    // subscription created in July, an August cycle that bounced on the 18th,
    // the retry that went through on the 20th, and a full refund of that retry
    // twelve minutes before the reviewer pressed Redraft.
    //
    // The paragraph used to be three summaries, and this is the shape that
    // broke them. The refund took the August charge out of the paid bucket, so
    // "the most recent" named July — a month before money last moved — and the
    // failed charge, in no bucket at all, was never mentioned. The model told
    // the customer their last payment was in July, on a thread about a refund
    // that had already been paid out.
    const JUL = Math.floor(Date.parse('2026-07-18T00:00:00Z') / 1000);
    const AUG_18 = Math.floor(Date.parse('2026-08-18T00:00:00Z') / 1000);
    const AUG_20 = Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000);
    stub({ id: 'cus_1', created: JUL }, [], [
      { amount: 31_800, currency: 'twd', paid: true, refunded: true, amount_refunded: 31_800, created: AUG_20, status: 'succeeded' },
      { amount: 31_800, currency: 'twd', paid: false, refunded: false, created: AUG_18, status: 'failed' },
      { amount: 25_440, currency: 'twd', paid: true, refunded: false, created: JUL, status: 'succeeded' },
    ]);

    const { prompt } = (await lookup())!;

    expect(prompt).toContain(
      'Every charge on the account, newest first: 2026-08-20 318 TWD refunded in full; ' +
        '2026-08-18 318 TWD attempted and failed; 2026-07-18 254.4 TWD paid.',
    );
    expect(prompt).toContain('kept paying 254.4 TWD');
    // No sentence of that shape survives, because no summary of a ledger can
    // know which charge the letter is going to ask about.
    expect(prompt).not.toContain('the most recent');
    expect(prompt).not.toMatch(/across \d+ charge/);
  });

  it('says in as many words when a refund was only partial', async () => {
    stub({ id: 'cus_1', created: NOW }, [], [
      { amount: 5000, currency: 'usd', paid: true, refunded: false, amount_refunded: 2000, created: NOW, status: 'succeeded' },
    ]);

    const { prompt } = (await lookup())!;
    expect(prompt).toContain('2026-03-01 50 USD partially refunded (20 USD returned)');
    expect(prompt).toContain('do not describe a partial refund as a refund');
  });

  it('does not divide zero-decimal currencies by a hundred', async () => {
    stub({ id: 'cus_1', created: NOW }, [], [
      { amount: 5000, currency: 'jpy', paid: true, refunded: false, created: NOW, status: 'succeeded' },
    ]);

    // ¥5,000 read as ¥50 is a sentence the model would repeat to the customer.
    const block = await lookup();
    expect(block!.prompt).toContain('5,000 JPY');
  });

  it('never asks Stripe to change anything', async () => {
    stub({ id: 'cus_1', created: NOW });
    await lookup();

    expect(requests.every(r => r.startsWith('GET '))).toBe(true);
    expect(requests.some(r => r.includes('/v1/customers?email='))).toBe(true);
  });

  it('surfaces a rejected key as an error the job can report', async () => {
    // A 401 turned into `null` would read as "not a customer", and the model
    // would tell a paying subscriber they have never bought anything. The
    // failure has to reach the job, which is the only thing that can say so.
    stub({ id: 'cus_1', created: NOW });
    rejectKey = true;

    await expect(lookup()).rejects.toThrow(/Invalid API Key/);
  });
});
