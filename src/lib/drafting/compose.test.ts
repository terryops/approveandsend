import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { resetWorkspaceConfig } from '../config/workspace';
import { openDb, type Db } from '../db';
import { COMPOSE_MESSAGE, composeMessageHandler } from '../queue/handlers';
import { createRule } from '../rules/store';
import { createTask, getTask, updateTask } from '../tasks/store';
import { listVersions } from '../tasks/versions';
import { composeMessage } from './compose';

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

const COMPOSED = JSON.stringify({
  subject: 'Yesterday’s export outage is fixed',
  body: 'Your failed exports have been re-run. Nothing further is needed from you.',
});

beforeEach(async () => {
  db = openDb(':memory:');
  queued.length = 0;
  prompts.length = 0;
  configDir = mkdtempSync(join(tmpdir(), 'aas-'));
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

function brief(subject = '') {
  return createTask(
    {
      origin: 'composed',
      subject,
      fromAddress: 'customer@example.com',
      body: 'Tell them the export outage is fixed and their failed jobs were re-run.',
    },
    db,
  ).task;
}

describe('composeMessage', () => {
  it('writes the mail and suggests a subject for it', async () => {
    queued.push(COMPOSED);

    expect(await composeMessage(brief(), { db })).toMatchObject({
      subject: 'Yesterday’s export outage is fixed',
      body: 'Your failed exports have been re-run. Nothing further is needed from you.',
    });
  });

  it('is bound by the same rules a reply is', async () => {
    // Where it matters most: no customer question is holding this mail to a
    // subject, so the rulebook is the only thing that is.
    createRule({ category: 'policy', content: 'Never promise a delivery date.' }, db);
    queued.push(COMPOSED);

    await composeMessage(brief(), { db });

    expect(prompts[0]).toContain('Never promise a delivery date.');
  });

  it('tells the model nobody wrote to us', async () => {
    queued.push(COMPOSED);

    await composeMessage(brief(), { db });

    expect(prompts[0]).toContain('This is not a\nreply');
  });

  it('signs the mail once, and says so in the prompt', async () => {
    // Both halves, because either alone is the bug. The desk appends the
    // signature, so the model has to be told to stop writing its own — a
    // composed mail was the one prompt that appended without saying, and it
    // went out over "Best regards, SubEasy Support" every time.
    writeConfig({ signature: '— The Acme team' });
    queued.push(COMPOSED);

    const composed = await composeMessage(brief(), { db });

    expect(prompts[0]).toContain('Do not write a sign-off');
    expect(composed?.body.endsWith('— The Acme team')).toBe(true);
  });

  it('asks the model for the closing when the desk has no signature', async () => {
    // The empty setting is not "unsigned". Nobody is adding a line below the
    // reply, so forbidding one would end the mail mid-air — the model writes
    // the closing instead, in the language the mail is in.
    queued.push(COMPOSED);

    await composeMessage(brief(), { db });

    expect(prompts[0]).not.toContain('Do not write a sign-off');
    expect(prompts[0]).toContain('End the reply the way a letter ends');
  });

  it('carries the note and the mail as it currently stands into a redraft', async () => {
    // Redraft on a composed mail used to throw both away: the reviewer's edits
    // and their note went in the box, and the model was handed the original
    // brief again and wrote the same mail.
    queued.push(COMPOSED);
    const task = brief();
    updateTask(
      task.id,
      { draft: 'Sorry about the outage.', reviewerNotes: 'Say what we are doing about it.' },
      db,
    );

    await composeMessage(getTask(task.id, db)!, { db });

    expect(prompts[0]).toContain('Sorry about the outage.');
    expect(prompts[0]).toContain('Say what we are doing about it.');
  });

  it('returns null rather than throwing on an unusable response', async () => {
    queued.push('not json');

    expect(await composeMessage(brief(), { db })).toBeNull();
  });
});

describe('compose-message job', () => {
  const context = () => ({
    db,
    job: { id: 'j1', type: COMPOSE_MESSAGE, attempts: 1, maxAttempts: 3 } as never,
  });

  it('leaves the mail awaiting review, never sent', async () => {
    const task = brief();
    queued.push(COMPOSED);

    await composeMessageHandler({ taskId: task.id }, context());

    const after = getTask(task.id, db);
    expect(after?.status).toBe('awaiting_review');
    expect(after?.draft).toContain('re-run');
    expect(listVersions(task.id, db)).toHaveLength(1);
  });

  it('takes the suggested subject only when nobody typed one', async () => {
    const blank = brief();
    const typed = brief('Scheduled maintenance on Sunday');
    queued.push(COMPOSED, COMPOSED);

    await composeMessageHandler({ taskId: blank.id }, context());
    await composeMessageHandler({ taskId: typed.id }, context());

    expect(getTask(blank.id, db)?.subject).toBe('Yesterday’s export outage is fixed');
    expect(getTask(typed.id, db)?.subject).toBe('Scheduled maintenance on Sunday');
  });

  it('fails the task with the reason when the model gives nothing usable', async () => {
    const task = brief();
    queued.push('not json');

    await expect(composeMessageHandler({ taskId: task.id }, context())).rejects.toThrow();

    const after = getTask(task.id, db);
    expect(after?.status).toBe('pending');
    expect(after?.error).toContain('no usable mail');
  });

  it('does not compose over a mail that already went out', async () => {
    const task = brief();
    updateTask(task.id, { status: 'sent' }, db);

    expect(await composeMessageHandler({ taskId: task.id }, context())).toEqual({
      skipped: 'sent',
    });
  });
});
