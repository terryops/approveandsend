import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { resetWorkspaceConfig } from '../config/workspace';
import { openDb, type Db } from '../db';
import { SUGGEST_ALTERNATIVES, suggestAlternativesHandler } from '../queue/handlers';
import { createRule } from '../rules/store';
import { listAlternatives, replaceAlternatives } from '../tasks/alternatives';
import { createTask, updateTask } from '../tasks/store';
import { MAX_OPTIONS, suggestAlternatives } from './alternatives';

let server: Server | undefined;
const queued: string[] = [];
const prompts: string[] = [];
let db: Db;
let configDir: string;

async function startAi(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      prompts.push(body.messages.map((m: { content: string }) => m.content).join('\n'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: queued.shift() ?? '{}' } }] }));
    });
  });

  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server!.address() as AddressInfo;

  process.env.AI_PROVIDER = 'openai-compatible';
  process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.AI_MODEL = 'test-model';
  process.env.AI_API_KEY = '';
  process.env.AI_MAX_RETRIES = '0';
  resetAiConfig();
}

const OPTIONS = JSON.stringify({
  current: 'send them the workaround',
  options: [
    { strategy: 'refund now', body: 'Refunded — sorry about that.' },
    { strategy: 'ask first', body: 'Could you send me the export id?' },
    { strategy: 'explain the policy', body: 'Refunds run to thirty days.' },
  ],
});

beforeEach(async () => {
  db = openDb(':memory:');
  queued.length = 0;
  prompts.length = 0;
  configDir = mkdtempSync(join(tmpdir(), 'aas-'));
  // A stray config file in the repo root must not change what these assert.
  process.env.AAS_CONFIG = join(configDir, 'absent.json');
  resetWorkspaceConfig();
  await startAi();
});

afterEach(async () => {
  db.close();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  resetAiConfig();
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.AAS_CONFIG;
  resetWorkspaceConfig();
});

function writeConfig(value: unknown): void {
  const path = join(configDir, 'aas.config.json');
  writeFileSync(path, JSON.stringify(value));
  process.env.AAS_CONFIG = path;
  resetWorkspaceConfig();
}

function task() {
  return createTask(
    {
      subject: 'Where is my refund?',
      fromAddress: 'customer@example.com',
      body: '<p>I was told three days ago that a refund was on its way.</p>',
    },
    db,
  ).task;
}

describe('suggestAlternatives', () => {
  it('puts the draft first, labelled, then the other approaches', async () => {
    queued.push(OPTIONS);

    const options = await suggestAlternatives(task(), 'The draft we already have.', { db });

    // The reply already on the table is one of the choices, not a fourth text
    // sitting outside the set. Without it the strip has no tab lit when the
    // reviewer arrives and no way back once they click away from the draft.
    expect(options).toMatchObject([
      { strategy: 'send them the workaround', body: 'The draft we already have.' },
      { strategy: 'refund now', body: 'Refunded — sorry about that.' },
      { strategy: 'ask first' },
    ]);
    // Three choices on screen, so two are invented. The model offered a third
    // and it is dropped rather than shown as a fourth tab.
    expect(options).toHaveLength(MAX_OPTIONS);
  });

  it('shows the model the draft it is offering an alternative to', async () => {
    // Without it the model has no way to avoid returning the same reply back.
    queued.push(OPTIONS);

    await suggestAlternatives(task(), 'The draft we already have.', { db });

    expect(prompts[0]).toContain('The draft we already have.');
  });

  it('signs each option once, and says so in the prompt', async () => {
    // The strip appends the signature to every option it returns, so the same
    // instruction the drafter gets has to reach this prompt too — otherwise
    // picking tab B sends a reply with two sign-offs on it.
    writeConfig({ signature: '— The Acme team' });
    queued.push(OPTIONS);

    const options = await suggestAlternatives(task(), 'The draft we already have.', { db });

    expect(prompts[0]).toContain('Do not write a sign-off');
    expect(options[1]?.body.endsWith('— The Acme team')).toBe(true);
    // Not the draft, which was signed when it was written. Signing it here is
    // how tab A grows a second one.
    expect(options[0]?.body).toBe('The draft we already have.');
  });

  it('writes the options against the same rules the draft was', async () => {
    createRule({ category: 'policy', content: 'Never promise a delivery date.' }, db);
    queued.push(OPTIONS);

    await suggestAlternatives(task(), 'A draft.', { db });

    expect(prompts[0]).toContain('Never promise a delivery date.');
  });

  it('asks for the labels in the language the desk is read in', async () => {
    // The strategy is the name of a tab, not part of the reply — a reviewer
    // running the desk in Japanese should not be picking between three English
    // labels. `draft.ts` has said this about `intent` and `keyPoints` all along
    // and this prompt never did, so the tab strip came back in English on every
    // desk. The reply itself is unaffected: it still goes out in the customer's
    // language, which is the next assertion down.
    process.env.AAS_LANGUAGE = 'ja';
    resetWorkspaceConfig();
    queued.push(OPTIONS);

    try {
      await suggestAlternatives(task(), 'A draft.', { db });
    } finally {
      delete process.env.AAS_LANGUAGE;
      resetWorkspaceConfig();
    }

    expect(prompts[0]).toContain('Japanese');
    // Named in English rather than as `ja` or 日本語 — see LOCALE_NAMES.
    expect(prompts[0]).not.toContain('日本語');
  });

  it('still sends the reply itself in the customer\'s language', async () => {
    // The half of the split that is easy to break: telling the model to label
    // in the operator's language and having it answer the customer in it too.
    queued.push(OPTIONS);

    await suggestAlternatives(task(), 'A draft.', { db });

    expect(prompts[0]).toContain('Every `body` goes to the customer');
  });

  it('leaves the reviewer note out of it', async () => {
    // A note is an instruction for a redraft. Applied here it would collapse
    // three approaches into three shades of the same correction.
    const created = task();
    updateTask(created.id, { reviewerNotes: 'too formal, warm it up' }, db);
    queued.push(OPTIONS);

    await suggestAlternatives({ ...created, reviewerNotes: 'too formal, warm it up' }, 'A.', { db });

    expect(prompts[0]).not.toContain('warm it up');
  });

  it('keeps at most three', async () => {
    queued.push(
      JSON.stringify({
        options: [1, 2, 3, 4, 5].map(n => ({ strategy: `s${n}`, body: `Reply ${n}` })),
      }),
    );

    expect(await suggestAlternatives(task(), 'A.', { db })).toHaveLength(3);
  });

  it('drops an option with no reply in it', async () => {
    queued.push(JSON.stringify({ options: [{ strategy: 'nothing' }, { body: 'Something.' }] }));

    expect(await suggestAlternatives(task(), 'A.', { db })).toMatchObject([
      { strategy: '', body: 'A.' },
      { strategy: '', body: 'Something.' },
    ]);
  });

  it('offers nothing at all when the model invented no new approach', async () => {
    // The draft on its own is not a choice, and one tab is not a strip. Showing
    // it would say the model looked and found nothing, which from here is
    // indistinguishable from the call having failed.
    queued.push(JSON.stringify({ current: 'what we already said', options: [] }));

    expect(await suggestAlternatives(task(), 'A.', { db })).toEqual([]);
  });

  it('returns nothing rather than throwing when the model returns rubbish', async () => {
    // The reviewer still has the draft they had. A button that did nothing is
    // a smaller failure than a screen that will not load.
    queued.push('not json at all');

    expect(await suggestAlternatives(task(), 'A.', { db })).toEqual([]);
  });
});

describe('suggest-alternatives job', () => {
  const context = () => ({ db, job: { id: 'j1', type: SUGGEST_ALTERNATIVES } as never });

  it('stores what came back', async () => {
    const created = task();
    updateTask(created.id, { status: 'awaiting_review', draft: 'A draft.' }, db);
    queued.push(OPTIONS);

    await suggestAlternativesHandler({ taskId: created.id }, context());

    expect(listAlternatives(created.id, db).map(a => a.label)).toEqual(['A', 'B', 'C']);
  });

  it('does not offer options on a reply that already went out', async () => {
    const created = task();
    updateTask(created.id, { status: 'sent' }, db);

    expect(await suggestAlternativesHandler({ taskId: created.id }, context())).toEqual({
      skipped: 'sent',
    });
  });

  it('leaves the set it has when the model returns nothing usable', async () => {
    // A second failed ask must not take away options the reviewer is reading.
    const created = task();
    updateTask(created.id, { status: 'awaiting_review', draft: 'A draft.' }, db);
    replaceAlternatives(created.id, [{ strategy: 'kept', body: 'Still here.' }], db);
    queued.push('{}');

    await suggestAlternativesHandler({ taskId: created.id }, context());

    expect(listAlternatives(created.id, db)).toMatchObject([{ strategy: 'kept' }]);
  });
});
