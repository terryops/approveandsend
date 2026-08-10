import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { resetWorkspaceConfig } from '../config/workspace';
import { listContext, saveContext } from '../context/store';
import { openDb, type Db } from '../db';
import { TRANSLATE_TASK, enqueueForTranslation, translateTaskHandler } from '../queue/handlers';
import { completeJob, listJobs } from '../queue/store';
import { createTask, deleteTask, updateTask } from '../tasks/store';
import { cardsSource, parseCards, renderCard } from './cards';
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

  it('tells the model a regional variant of the target is the target', async () => {
    queued.push('SAME');

    // `zh-CN` in the first line reads as "convert this", so a letter from
    // Taipei came back rewritten into Simplified: a paid call whose whole
    // output was a script change, on the panel that exists to show the
    // reviewer the customer's own words.
    expect(await translateForReview('您好，我需要協助處理統一編號。')).toBeNull();
    expect(prompts[0]).toContain('Never convert between them');
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

  it('does nothing when there is no review language and nothing to render', async () => {
    const id = task('Bonjour', 'Merci');
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();

    const result = await translateTaskHandler({ taskId: id }, context());

    expect(result).toEqual({ skipped: 'nothing on this task needs rendering' });
    expect(prompts).toHaveLength(0);
  });
});

/*
 * The cards, which are the other thing on that screen written by somebody who
 * was not thinking about the language it would be read in.
 *
 * A source writes its own prose, and it writes it in English: the built-in ones
 * because this repository is, a declarative one because the config file sits
 * next to an internal endpoint whose fields are called `plan` and `credits`. On
 * a Chinese desk that put a paragraph of English above a draft where every
 * other word had been translated.
 */
describe('rendering the context cards', () => {
  beforeEach(() => {
    // The desk is read in Chinese. The cards arrive in English regardless.
    process.env.AAS_LANGUAGE = 'zh-CN';
    resetWorkspaceConfig();
  });

  afterEach(() => {
    delete process.env.AAS_LANGUAGE;
    resetWorkspaceConfig();
  });

  function card(id: string, block: Parameters<typeof saveContext>[3]): void {
    saveContext(id, 'subeasy', 'Subeasy', block, db);
  }

  const account = {
    title: 'Subeasy Account',
    fields: [
      { label: 'Plan', value: 'Pro' },
      { label: 'Credits', value: '200' },
      { label: 'User', value: '洪藝珊' },
    ],
    prompt: 'They have 200 credits left; the next batch expires 9 September 2026.',
  };

  it('renders the card into the language the desk is read in', async () => {
    const id = task('Bonjour');
    card(id, account);
    // The mail first — this desk translates both — then the card.
    queued.push(
      '你好',
      JSON.stringify({
        text: ['Subeasy 账户', '方案', 'Pro', '积分', '用户', '洪藝珊', '他们还剩 200 积分。'],
      }),
    );

    const result = (await translateTaskHandler({ taskId: id }, context())) as {
      translated: string[];
      deskLanguage: string;
    };

    expect(result.translated).toContain('context');
    // The interface language, not the review language. A card is furniture on
    // this screen; the mail beside it is the thing `reviewLanguage` is about.
    expect(result.deskLanguage).toBe('Simplified Chinese');

    const rendered = parseCards(
      getTranslation(id, 'context', cardsSource(listContext(id, db)), 'Simplified Chinese', db)?.content,
    );
    expect(rendered?.subeasy?.title).toBe('Subeasy 账户');
    expect(rendered?.subeasy?.fields[0]).toEqual({ label: '方案', value: 'Pro' });
    expect(rendered?.subeasy?.prompt).toBe('他们还剩 200 积分。');
  });

  it('does not send values that are not words', async () => {
    const id = task('Bonjour');
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();
    card(id, account);
    queued.push(JSON.stringify({ text: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));

    await translateTaskHandler({ taskId: id }, context());

    // `200` is a number, and asking is how it comes back as 二百. Six strings
    // go: the title, three labels, `Pro` and the name (both of which the model
    // is told to leave alone), and the sentence.
    expect(prompts[0]).toContain('"Pro"');
    expect(prompts[0]).not.toContain('"200"');
  });

  it('asks once for a label two cards share', async () => {
    const id = task('Bonjour');
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();
    saveContext(id, 'billing', 'Billing', { title: 'Billing', fields: [{ label: 'Plan', value: 'Pro' }], prompt: '' }, db);
    saveContext(id, 'crm', 'CRM', { title: 'CRM', fields: [{ label: 'Plan', value: 'Pro' }], prompt: '' }, db);
    queued.push(JSON.stringify({ text: ['账单', '方案', 'Pro', '客户系统'] }));

    await translateTaskHandler({ taskId: id }, context());

    const rendered = parseCards(
      getTranslation(id, 'context', cardsSource(listContext(id, db)), 'Simplified Chinese', db)?.content,
    );
    // One string in, one string out — and the same label on two cards cannot
    // come back reading two ways.
    expect(rendered?.billing?.fields[0]?.label).toBe('方案');
    expect(rendered?.crm?.fields[0]?.label).toBe('方案');
    expect(prompts).toHaveLength(1);
  });

  it('stores nothing when the answer does not line up with the card', async () => {
    const id = task('Bonjour');
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();
    card(id, account);
    // Two strings merged into one. Matched back by position, that would put a
    // label from one row onto the row below it.
    queued.push(JSON.stringify({ text: ['Subeasy 账户', '方案 / 积分', '用户'] }));

    await expect(translateTaskHandler({ taskId: id }, context())).rejects.toThrow();
    expect(
      getTranslation(id, 'context', cardsSource(listContext(id, db)), 'Simplified Chinese', db),
    ).toBeNull();
  });

  it('stops asking once a card has been rendered, even when nothing changed', async () => {
    const id = task('Bonjour');
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();
    card(id, account);
    queued.push(JSON.stringify({ text: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));

    await translateTaskHandler({ taskId: id }, context());
    await translateTaskHandler({ taskId: id }, context());

    // Stored even where the model changed nothing, which is the difference
    // between paying once per desk that already reads English and paying again
    // every time somebody saves a draft.
    expect(prompts).toHaveLength(1);
  });

  it('shows nothing once the lookup behind it has changed', async () => {
    const id = task('Bonjour');
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();
    card(id, account);
    queued.push(JSON.stringify({ text: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));
    await translateTaskHandler({ taskId: id }, context());

    // The subscription lapsed between one lookup and the next.
    card(id, { ...account, fields: [{ label: 'Plan', value: 'Free' }] });

    // A rendering of last week's card with this week's numbers missing is the
    // same trap the mail panels refuse.
    expect(
      getTranslation(id, 'context', cardsSource(listContext(id, db)), 'Simplified Chinese', db),
    ).toBeNull();
  });

  it('falls back a field at a time, and never moves a link', () => {
    const block = {
      sourceId: 'subeasy',
      title: 'Subeasy Account',
      fields: [
        { label: 'Plan', value: 'Pro', href: 'https://subeasy.ai/u/1' },
        { label: 'Credits', value: '200' },
      ],
      prompt: 'They have 200 credits left.',
    };

    const rendered = renderCard(block, { subeasy: { title: '账户', fields: [{ label: '方案', value: 'Pro' }], prompt: '' } });

    expect(rendered.title).toBe('账户');
    expect(rendered.fields[0]).toEqual({ label: '方案', value: 'Pro', href: 'https://subeasy.ai/u/1' });
    // A rendering one field short leaves the rest as its source wrote it,
    // rather than shifting the next row's answer onto it.
    expect(rendered.fields[1]).toEqual({ label: 'Credits', value: '200' });
    expect(rendered.prompt).toBe('They have 200 credits left.');
  });

  it('shows the card as its source wrote it when there is no rendering', () => {
    const block = { sourceId: 'subeasy', title: 'Subeasy Account', fields: [], prompt: 'Pro since April.' };

    // The state every card is in until the job has run, and the state it stays
    // in if the job could not.
    expect(renderCard(block, null)).toEqual({ title: 'Subeasy Account', fields: [], prompt: 'Pro since April.' });
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

  it('enqueues for a desk that reads its own mail but not its own cards', () => {
    delete process.env.AAS_REVIEW_LANGUAGE;
    resetWorkspaceConfig();

    const id = task('Bonjour');
    saveContext(id, 'subeasy', 'Subeasy', { title: 'Subeasy Account', fields: [], prompt: 'Pro since April.' }, db);
    enqueueForTranslation(id, { db });

    // Nothing about the mail needs rendering here; the card above it does, and
    // deciding that from `reviewLanguage` alone would leave it in English for
    // good.
    expect(listJobs({ type: TRANSLATE_TASK }, db)).toHaveLength(1);
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

  /*
   * The redraft, which is the case the dedupe key could quietly have broken.
   *
   * `translate-task:{taskId}` is the same string every time this task is
   * queued, for the life of the task. That is what stops a reviewer who saves
   * four times in a minute from buying four translations — and it would just as
   * happily stop the one that matters, if the key were held by a job that had
   * already finished. A redraft rewrites the reply, `getTranslation` refuses
   * the old rendering the moment the text under it changes, and the panel would
   * then be empty with nothing on its way to fill it.
   *
   * It holds only while a job is pending or processing. Once the first one has
   * run, the next draft gets its own.
   */
  it('queues another once the first has finished, which is what a redraft needs', async () => {
    const id = task('Bonjour', 'Merci de votre patience.');
    enqueueForTranslation(id, { db });

    queued.push('您好', '感谢您的耐心。');
    await translateTaskHandler({ taskId: id }, context());
    completeJob(listJobs({ type: TRANSLATE_TASK }, db)[0]!.id, null, db);

    // What the model writes on a redraft, landing on top of the old reply.
    updateTask(id, { draft: 'Le remboursement est en route.' }, db);
    expect(getTranslation(id, 'draft', 'Le remboursement est en route.', 'Chinese', db)).toBeNull();

    enqueueForTranslation(id, { db });
    expect(listJobs({ type: TRANSLATE_TASK, status: 'pending' }, db)).toHaveLength(1);

    queued.push('退款已在路上。');
    await translateTaskHandler({ taskId: id }, context());

    expect(getTranslation(id, 'draft', 'Le remboursement est en route.', 'Chinese', db)?.content).toBe(
      '退款已在路上。',
    );
    // The customer's own message never changed, so nobody paid to render it
    // twice: three calls for four halves.
    expect(prompts).toHaveLength(3);
  });
});
