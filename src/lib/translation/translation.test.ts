import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { resetWorkspaceConfig } from '../config/workspace';
import { openDb, type Db } from '../db';
import { TRANSLATE_TASK, enqueueForTranslation, translateTaskHandler } from '../queue/handlers';
import { listJobs } from '../queue/store';
import { createTask, deleteTask, updateTask } from '../tasks/store';
import { clearTranslations, getTranslation, hasTranslation, saveTranslation } from './store';
import { reviewLanguage, translateForReview, translationEnabled } from './translate';

// --- an AI server that answers with whatever the test queued --------------

let server: Server | undefined;
const queued: string[] = [];
const prompts: string[] = [];
/** Requests after this many are refused, to fail one half of a job and not the other. */
let answerLimit = Number.POSITIVE_INFINITY;

async function startAi(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      prompts.push(body.messages.map((m: { content: string }) => m.content).join('\n'));

      if (prompts.length > answerLimit) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'the translator fell over' }));
        return;
      }

      const content = queued.shift() ?? 'SAME';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
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

let db: Db;

function task(body: string, draft?: string): string {
  const { task: created } = createTask(
    { subject: 'Aide', fromAddress: 'marie@example.fr', body },
    db,
  );
  if (draft !== undefined) updateTask(created.id, { draft }, db);
  return created.id;
}

function context() {
  return {
    job: {
      id: 'job-1',
      type: TRANSLATE_TASK,
      payload: {},
      dedupeKey: null,
      status: 'processing' as const,
      priority: 7,
      attempts: 1,
      maxAttempts: 2,
      runAfter: '',
      leaseExpiresAt: null,
      leaseToken: null,
      result: null,
      error: null,
      createdAt: '',
      startedAt: null,
      finishedAt: null,
    },
    db,
  };
}

beforeEach(async () => {
  db = openDb(':memory:');
  queued.length = 0;
  prompts.length = 0;
  answerLimit = Number.POSITIVE_INFINITY;
  process.env.AAS_CONFIG = '/nonexistent/absent.json';
  process.env.AAS_REVIEW_LANGUAGE = 'Chinese';
  resetWorkspaceConfig();
  await startAi();
});

afterEach(async () => {
  db.close();
  delete process.env.AAS_CONFIG;
  delete process.env.AAS_REVIEW_LANGUAGE;
  resetWorkspaceConfig();
  resetAiConfig();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});

describe('deciding whether anything needs translating', () => {
  it('is off until a review language is set', () => {
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();

    expect(translationEnabled()).toBe(false);
    expect(reviewLanguage()).toBe('');
  });

  it('asks the model rather than counting characters', async () => {
    queued.push('您好，我需要帮助。');

    const result = await translateForReview('Bonjour, j\'ai besoin d\'aide.');

    expect(result).toBe('您好，我需要帮助。');
    // The system this replaced decided with a CJK-ratio regex, in five copies
    // that had drifted apart, and its own comments admit it misclassifies
    // kanji-heavy Japanese as Chinese — so Japanese mail reached a
    // Chinese-reading reviewer untranslated. The model is told what the target
    // is and answers for itself.
    expect(prompts[0]).toContain('Chinese');
  });

  it('treats text already in the target language as nothing to translate', async () => {
    queued.push('SAME');
    expect(await translateForReview('您好')).toBeNull();
  });

  it('still understands SAME when the model insists on explaining itself', async () => {
    queued.push('SAME — this text is already written in Chinese.');
    expect(await translateForReview('您好')).toBeNull();
  });

  it('does not call the model at all for empty text', async () => {
    expect(await translateForReview('   ')).toBeNull();
    expect(prompts).toHaveLength(0);
  });

  it('tells the model the translation is not going to the customer', async () => {
    queued.push('译文');
    await translateForReview('Bonjour');

    // Otherwise it writes a reply-shaped thing, adds a greeting, softens the
    // tone — helpful for a customer, misleading for someone checking what the
    // draft actually says.
    expect(prompts[0]).toContain('never send your translation');
  });
});

describe('keeping a translation tied to what it translated', () => {
  it('returns the translation of exactly that text', () => {
    const id = task('Bonjour');
    saveTranslation(id, 'draft', 'Chinese', 'Bonjour', '你好', db);

    expect(getTranslation(id, 'draft', 'Bonjour', 'Chinese', db)?.content).toBe('你好');
  });

  it('shows nothing once the text it was made from has changed', () => {
    const id = task('Bonjour');
    saveTranslation(id, 'draft', 'Chinese', 'Bonjour', '你好', db);

    // The failure this exists to prevent: a reviewer who cannot read French
    // has no way of noticing the draft was regenerated after its Chinese
    // rendering was written. No translation is honest; the previous draft's
    // is a trap.
    expect(getTranslation(id, 'draft', 'Bonjour, ça va?', 'Chinese', db)).toBeNull();
  });

  it('shows nothing when the review language has since changed', () => {
    const id = task('Bonjour');
    saveTranslation(id, 'draft', 'Chinese', 'Bonjour', '你好', db);

    expect(getTranslation(id, 'draft', 'Bonjour', 'Japanese', db)).toBeNull();
  });

  it('keeps the incoming message and the reply apart', () => {
    const id = task('Bonjour');
    saveTranslation(id, 'body', 'Chinese', 'Bonjour', '你好', db);
    saveTranslation(id, 'draft', 'Chinese', 'Merci', '谢谢', db);

    expect(getTranslation(id, 'body', 'Bonjour', 'Chinese', db)?.content).toBe('你好');
    expect(getTranslation(id, 'draft', 'Merci', 'Chinese', db)?.content).toBe('谢谢');
  });

  it('replaces rather than accumulates when the same part is translated again', () => {
    const id = task('Bonjour');
    saveTranslation(id, 'draft', 'Chinese', 'Bonjour', '你好', db);
    saveTranslation(id, 'draft', 'Chinese', 'Merci', '谢谢', db);

    expect(getTranslation(id, 'draft', 'Bonjour', 'Chinese', db)).toBeNull();
    expect(getTranslation(id, 'draft', 'Merci', 'Chinese', db)?.content).toBe('谢谢');
  });

  it('goes when the task goes', () => {
    const id = task('Bonjour');
    saveTranslation(id, 'body', 'Chinese', 'Bonjour', '你好', db);

    deleteTask(id, db);

    // The cascade, not a cleanup call anyone has to remember: a translation of
    // a message nobody can open is nothing but a copy of a customer's words.
    expect(getTranslation(id, 'body', 'Bonjour', 'Chinese', db)).toBeNull();
  });

  it('can be cleared on its own', () => {
    const id = task('Bonjour');
    saveTranslation(id, 'body', 'Chinese', 'Bonjour', '你好', db);

    expect(clearTranslations(id, db)).toBe(1);
    expect(getTranslation(id, 'body', 'Bonjour', 'Chinese', db)).toBeNull();
  });
});

describe('the translation job', () => {
  it('renders both the message and the reply', async () => {
    const id = task('Bonjour, remboursement?', 'Bien sûr, sous 5 jours.');
    queued.push('你好，退款？', '当然，5天内。');

    const result = (await translateTaskHandler({ taskId: id }, context())) as {
      translated: string[];
    };

    expect(result.translated).toEqual(['body', 'draft']);
    expect(getTranslation(id, 'body', 'Bonjour, remboursement?', 'Chinese', db)?.content).toBe(
      '你好，退款？',
    );
    expect(getTranslation(id, 'draft', 'Bien sûr, sous 5 jours.', 'Chinese', db)?.content).toBe(
      '当然，5天内。',
    );
  });

  it('does not pay to translate what is already current', async () => {
    const id = task('Bonjour', 'Merci');
    queued.push('你好', '谢谢');
    await translateTaskHandler({ taskId: id }, context());
    expect(prompts).toHaveLength(2);

    await translateTaskHandler({ taskId: id }, context());

    // The body never changes and the draft usually has not. Re-translating
    // what is already on file is the easiest money to stop spending.
    expect(prompts).toHaveLength(2);
  });

  it('re-translates only the half that changed', async () => {
    const id = task('Bonjour', 'Merci');
    queued.push('你好', '谢谢');
    await translateTaskHandler({ taskId: id }, context());

    updateTask(id, { draft: 'Merci beaucoup' }, db);
    queued.push('非常感谢');
    const result = (await translateTaskHandler({ taskId: id }, context())) as {
      translated: string[];
    };

    expect(result.translated).toEqual(['draft']);
    expect(prompts).toHaveLength(3);
  });

  it('translates what actually went out once a reply has been sent', async () => {
    const id = task('Bonjour', 'Draft version');
    updateTask(id, { finalReply: 'The edited version', status: 'sent' }, db);
    queued.push('你好', '编辑后的版本');

    await translateTaskHandler({ taskId: id }, context());

    expect(getTranslation(id, 'draft', 'The edited version', 'Chinese', db)?.content).toBe(
      '编辑后的版本',
    );
    expect(getTranslation(id, 'draft', 'Draft version', 'Chinese', db)).toBeNull();
  });

  it('stores nothing for a message already in the reviewer language', async () => {
    const id = task('您好，我需要帮助', '好的，马上处理');
    queued.push('SAME', 'SAME');

    const result = (await translateTaskHandler({ taskId: id }, context())) as {
      translated: string[];
      alreadyInLanguage: string[];
    };

    expect(result.translated).toEqual([]);
    expect(result.alreadyInLanguage).toEqual(['body', 'draft']);
    expect(hasTranslation(id, 'body', '您好，我需要帮助', 'Chinese', db)).toBe(false);
  });

  it('keeps the half that worked when the other half fails', async () => {
    const id = task('Bonjour', 'Merci');
    queued.push('你好');
    answerLimit = 1; // the body is answered, the draft is not

    const result = (await translateTaskHandler({ taskId: id }, context())) as {
      translated: string[];
      failed: string[];
    };

    // A reviewer with the incoming mail translated and the draft not is better
    // served than one with neither.
    expect(result.translated).toEqual(['body']);
    expect(result.failed[0]).toContain('draft');
    expect(getTranslation(id, 'body', 'Bonjour', 'Chinese', db)?.content).toBe('你好');
  });

  it('fails loudly when nothing at all could be translated', async () => {
    const id = task('Bonjour', 'Merci');
    answerLimit = 0;

    await expect(translateTaskHandler({ taskId: id }, context())).rejects.toThrow();
  });

  it('does nothing when no review language is configured', async () => {
    const id = task('Bonjour', 'Merci');
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();

    const result = await translateTaskHandler({ taskId: id }, context());

    expect(result).toEqual({ skipped: 'no review language configured' });
    expect(prompts).toHaveLength(0);
  });
});

describe('queueing it', () => {
  it('enqueues nothing on an install that reads its own mail', () => {
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();

    const id = task('Bonjour');
    enqueueForTranslation(id, { db });

    // A no-op job per email would clutter the queue view of every install that
    // has no use for the feature.
    expect(listJobs({ type: TRANSLATE_TASK }, db)).toHaveLength(0);
  });

  it('enqueues once a review language is set', () => {
    const id = task('Bonjour');
    enqueueForTranslation(id, { db });

    const jobs = listJobs({ type: TRANSLATE_TASK }, db);
    expect(jobs).toHaveLength(1);
    // Behind drafting (5) and enrichment (4): it is the one step here that
    // nothing downstream consumes.
    expect(jobs[0]!.priority).toBe(7);
  });

  it('does not queue two translations of the same task at once', () => {
    const id = task('Bonjour');
    enqueueForTranslation(id, { db });
    enqueueForTranslation(id, { db });

    expect(listJobs({ type: TRANSLATE_TASK }, db)).toHaveLength(1);
  });
});
