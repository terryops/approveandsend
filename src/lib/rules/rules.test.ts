import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { openDb, type Db } from '../db';
import { currentVersion, migrate, MIGRATIONS, SCHEMA_VERSION } from '../db/migrations';
import { dedupeAndApplyRule } from './dedup';
import { diffSentences, diffSummary, splitSentences } from './diff';
import { learnFromSentReply } from './learn';
import { formatRulesForReview, selectRules } from './prompt';
import { formatRetrieved, retrieveRules } from './retrieve';
import { rankBySimilarity, shortlist, tokenize } from './similarity';
import { installStarterRules, STARTER_RULES } from './starter';
import {
  createRule,
  deleteRule,
  disableRule,
  getRule,
  listRevisions,
  listRules,
  recordApplied,
  revisionsByRule,
  updateRule,
} from './store';
import { attachSummary, summariseRules } from './summarise';
import type { Rule } from './types';

// --- an AI server that returns whatever the test queues -------------------

let server: Server | undefined;
const queued: string[] = [];
const prompts: string[] = [];

async function startAi(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      prompts.push(body.messages.map((m: { content: string }) => m.content).join('\n'));
      const content = queued.shift() ?? '{}';
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

beforeEach(async () => {
  db = openDb(':memory:');
  queued.length = 0;
  prompts.length = 0;
  await startAi();
});

afterEach(async () => {
  db.close();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  resetAiConfig();
});

const seed = (content: string, extra: Partial<Parameters<typeof createRule>[0]> = {}): Rule =>
  createRule({ content, ...extra }, db);

// --- schema ---------------------------------------------------------------

describe('migrations', () => {
  it('brings a fresh database to the current version', () => {
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('is idempotent — reopening the same file applies nothing', () => {
    const before = currentVersion(db);
    const again = openDb(':memory:');
    expect(currentVersion(again)).toBe(before);
    again.close();
  });

  it('carries an existing database\'s rule scopes over into topics', async () => {
    // The upgrade this is really about. A desk that has been running for
    // months has rules confined by `scope`, and a migration that created an
    // empty join table would silently promote every one of them to
    // applies-to-everything — which reads as nothing breaking, right up to
    // the refund rules turning up in a reply about the API.
    const { default: Database } = await import('better-sqlite3');
    const old = new Database(':memory:');
    for (const migration of MIGRATIONS.filter(m => m.version <= 10)) migration.up(old);
    old.pragma('user_version = 10');

    const insert = old.prepare(
      `INSERT INTO rules (id, content, category, scope, enabled, applied_count,
                          created_at, updated_at)
       VALUES (?, ?, 'general', ?, 1, 0, '2020-01-01', '2020-01-01')`,
    );
    insert.run('a', 'Scoped.', '  Refunds ');
    insert.run('b', 'Unscoped.', null);
    insert.run('c', 'Blank scope.', '   ');

    migrate(old);

    const tagged = old.prepare('SELECT rule_id, topic FROM rule_topics ORDER BY rule_id').all();
    expect(tagged).toEqual([{ rule_id: 'a', topic: 'refunds' }]);
    old.close();
  });
});

// --- store ----------------------------------------------------------------

describe('rule store', () => {
  it('creates with sane defaults and reads back', () => {
    const rule = seed('Do not promise a refund date.', {
      category: 'policy',
      sourceTaskId: 'task-1',
      rationale: 'A reviewer removed one.',
    });

    expect(rule).toMatchObject({
      content: 'Do not promise a refund date.',
      category: 'policy',
      topics: [],
      enabled: true,
      sourceTaskId: 'task-1',
      appliedCount: 0,
      lastAppliedAt: null,
    });
    expect(getRule(rule.id, db)).toEqual(rule);
  });

  it('rejects an empty rule rather than storing a blank one', () => {
    expect(() => seed('   ')).toThrow(/needs content/i);
  });

  it('records a revision when the content changes, and not when it does not', () => {
    const rule = seed('Original text.');

    updateRule(rule.id, { content: 'Corrected text.' }, { reason: 'learned' }, db);
    updateRule(rule.id, { category: 'tone' }, {}, db);
    updateRule(rule.id, { content: 'Corrected text.' }, {}, db);

    const revisions = listRevisions(rule.id, db);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      previousContent: 'Original text.',
      newContent: 'Corrected text.',
      reason: 'learned',
    });
    expect(getRule(rule.id, db)?.category).toBe('tone');
  });

  it('groups a whole page of histories in one lookup, newest first', () => {
    const changed = seed('First wording.');
    const twice = seed('Also first.');
    const untouched = seed('Never edited.');

    updateRule(changed.id, { content: 'Second wording.' }, { actor: 'Sam' }, db);
    updateRule(twice.id, { content: 'Also second.' }, { actor: 'Ada' }, db);
    updateRule(twice.id, { content: 'Also third.' }, { actor: 'Ada' }, db);

    const history = revisionsByRule([changed.id, twice.id, untouched.id], db);

    expect(history.get(changed.id)).toHaveLength(1);
    expect(history.get(changed.id)?.[0]).toMatchObject({
      previousContent: 'First wording.',
      actor: 'Sam',
    });
    // Newest first, so the page shows the most recent rewording at the top.
    expect(history.get(twice.id)?.map(r => r.previousContent)).toEqual([
      'Also second.',
      'Also first.',
    ]);
    // A rule nobody has touched is a missing key, not an empty array — the
    // page tests for history by asking whether the key is there.
    expect(history.has(untouched.id)).toBe(false);
    expect(revisionsByRule([], db).size).toBe(0);
  });

  it('returns null for an unknown id instead of throwing', () => {
    expect(updateRule('nope', { content: 'x' }, {}, db)).toBeNull();
    expect(getRule('nope', db)).toBeNull();
    expect(deleteRule('nope', db)).toBe(false);
  });

  it('filters by enabled, category and topic, with untagged rules always included', () => {
    const global = seed('Global rule.');
    const refunds = seed('Refund rule.', { topics: ['refunds'], category: 'policy' });
    const onboarding = seed('Onboarding rule.', { topics: ['onboarding'] });
    const off = seed('Retired rule.');
    disableRule(off.id, db);

    const forRefunds = listRules({ enabledOnly: true, topic: 'refunds' }, db).map(r => r.id);
    expect(forRefunds).toContain(global.id);
    expect(forRefunds).toContain(refunds.id);
    expect(forRefunds).not.toContain(onboarding.id);
    expect(forRefunds).not.toContain(off.id);

    expect(listRules({ category: 'policy' }, db).map(r => r.id)).toEqual([refunds.id]);
    // Disabled rules are still listed for an admin view.
    expect(listRules({}, db)).toHaveLength(4);
  });

  it('routes a rule that is about two things to both of them', () => {
    // The case a single scope column could not express, and the reason this
    // is a join table: read as an account problem, answered out of the
    // refund policy.
    const both = seed('Check the subscription before offering a refund.', {
      topics: ['refunds', 'account'],
    });
    const refundsOnly = seed('Refunds only.', { topics: ['refunds'] });

    expect(getRule(both.id, db)?.topics).toEqual(['account', 'refunds']);
    expect(listRules({ topic: 'account' }, db).map(r => r.id)).toEqual([both.id]);
    expect(listRules({ topic: 'refunds' }, db).map(r => r.id)).toEqual([both.id, refundsOnly.id]);
  });

  it('normalises topic names on the way in, so one topic cannot become three', () => {
    const rule = seed('Whatever.', { topics: [' Refunds ', 'REFUNDS', 'refunds', '', 'not a slug!'] });
    expect(rule.topics).toEqual(['refunds']);
  });

  it('replaces a rule\'s topics wholesale rather than adding to them', () => {
    const rule = seed('Whatever.', { topics: ['refunds', 'account'] });

    expect(updateRule(rule.id, { topics: ['billing'] }, {}, db)?.topics).toEqual(['billing']);
    expect(updateRule(rule.id, { topics: [] }, {}, db)?.topics).toEqual([]);
  });

  it('leaves the topics alone when an update does not mention them', () => {
    const rule = seed('Whatever.', { topics: ['refunds'] });
    expect(updateRule(rule.id, { enabled: false }, {}, db)?.topics).toEqual(['refunds']);
  });

  it('sweeps the tags when a rule is deleted, so a reused id cannot inherit them', () => {
    const rule = seed('Whatever.', { topics: ['refunds'] });
    deleteRule(rule.id, db);

    const left = db
      .prepare('SELECT COUNT(*) c FROM rule_topics WHERE rule_id = ?')
      .get(rule.id) as { c: number };
    expect(left.c).toBe(0);
  });

  it('counts applications so a rule that never fires can be found later', () => {
    const a = seed('A.');
    const b = seed('B.');

    recordApplied([a.id, b.id], db);
    recordApplied([a.id], db);

    expect(getRule(a.id, db)?.appliedCount).toBe(2);
    expect(getRule(b.id, db)?.appliedCount).toBe(1);
    expect(getRule(a.id, db)?.lastAppliedAt).toBeTruthy();
  });

  it('keeps a disabled rule readable — merges must stay reversible', () => {
    const rule = seed('Absorbed by a merge.');
    disableRule(rule.id, db);
    expect(getRule(rule.id, db)?.enabled).toBe(false);
  });
});

// --- similarity -----------------------------------------------------------

describe('similarity', () => {
  it('drops filler and keeps distinguishing words', () => {
    const tokens = tokenize('Always tell the customer that the refund takes ten days.');
    expect(tokens).toContain('refund');
    expect(tokens).toContain('takes');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('customer');
    expect(tokens).not.toContain('always');
  });

  it('splits CJK per character, since there are no spaces to split on', () => {
    expect(tokenize('退款政策')).toEqual(['退', '款', '政', '策']);
  });

  it('ranks a paraphrase above an unrelated rule', () => {
    const rules = [
      { content: 'Never mention competitor pricing in a reply.' },
      { content: 'Refunds are processed within ten business days.' },
      { content: 'A refund normally completes inside ten working days.' },
    ];
    const ranked = rankBySimilarity(
      'Tell customers refunds take about ten business days.',
      rules,
      r => r.content,
    );
    expect(ranked[0]!.item.content).toMatch(/ten (business|working) days/);
    expect(ranked.map(r => r.item.content)).not.toContain(
      'Never mention competitor pricing in a reply.',
    );
  });

  it('returns nothing for a rule with no vocabulary in common', () => {
    const rules = [{ content: 'Refunds take ten business days.' }];
    expect(shortlist('Sign every reply with the agent first name.', rules, r => r.content)).toEqual(
      [],
    );
  });

  it('bounds the shortlist', () => {
    const rules = Array.from({ length: 50 }, (_, i) => ({
      content: `Refund policy variant ${i} about refunds and refund timing.`,
    }));
    expect(shortlist('refund policy refund timing', rules, r => r.content, { limit: 5 })).toHaveLength(
      5,
    );
  });
});

// --- diff -----------------------------------------------------------------

describe('diff', () => {
  it('splits on sentence terminators and paragraph breaks', () => {
    expect(splitSentences('One. Two!\n\nThree?')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('reports only what moved', () => {
    const ops = diffSentences(['A.', 'B.', 'C.'], ['A.', 'D.', 'C.']);
    expect(ops.filter(o => o.kind === 'remove').map(o => o.text)).toEqual(['B.']);
    expect(ops.filter(o => o.kind === 'add').map(o => o.text)).toEqual(['D.']);
    expect(ops.filter(o => o.kind === 'keep')).toHaveLength(2);
  });

  it('summarises an edit without repeating the unchanged text', () => {
    const summary = diffSummary(
      'Hi there. I am so sorry about this. We will refund you within 3 days. Thanks.',
      'Hi there. We will look into this and get back to you. Thanks.',
    );
    expect(summary).toContain('I am so sorry about this.');
    expect(summary).toContain('We will look into this and get back to you.');
    // The sentences that survived are already elsewhere in the prompt.
    expect(summary).not.toContain('Hi there.');
  });

  it('says so plainly when nothing changed', () => {
    expect(diffSummary('Same text.', 'Same text.')).toMatch(/sent as written/i);
  });

  it('caps a runaway diff instead of pasting the whole letter', () => {
    const before = Array.from({ length: 40 }, (_, i) => `Old sentence ${i}.`).join(' ');
    const after = Array.from({ length: 40 }, (_, i) => `New sentence ${i}.`).join(' ');
    expect(diffSummary(before, after, { maxEntries: 3 })).toContain('and 37 more');
  });
});

// --- prompt block ---------------------------------------------------------

describe('rule block', () => {
  it('numbers the rules and returns the ids that went in', () => {
    const a = seed('First.');
    const b = seed('Second.');

    const block = selectRules(listRules({ enabledOnly: true }, db));
    // Both were written in the same millisecond, so this only holds because
    // ordering is by insertion sequence and not by timestamp or id.
    expect(block.text).toContain('1. First.');
    expect(block.text).toContain('2. Second.');
    expect(block.includedIds).toEqual([a.id, b.id]);
    expect(block.droppedIds).toEqual([]);
  });

  it('is empty when there is nothing to say', () => {
    expect(selectRules([]).text).toBe('');
  });

  it('keeps an untagged rule in every topic, and a tagged one only in its own', () => {
    seed('Always.');
    seed('Refunds and billing.', { topics: ['refunds', 'billing'] });

    const billing = selectRules(listRules({ enabledOnly: true }, db), { topic: 'billing' });
    expect(billing.text).toContain('Always.');
    expect(billing.text).toContain('Refunds and billing.');

    // No topic asked for at all — an admin listing, or a draft before the
    // mail has been classified — still sees everything.
    expect(selectRules(listRules({ enabledOnly: true }, db)).text).toContain('Refunds and billing.');
  });

  it('excludes rules about something else', () => {
    seed('Global.');
    seed('Refunds only.', { topics: ['refunds'] });

    const block = selectRules(listRules({ enabledOnly: true }, db), { topic: 'onboarding' });
    expect(block.text).toContain('Global.');
    expect(block.text).not.toContain('Refunds only.');
  });

  it('keeps policy over tone when the budget bites, and reports the drops', () => {
    const tone = seed('T'.repeat(200), { category: 'tone' });
    const policy = seed('P'.repeat(200), { category: 'policy' });

    const block = selectRules(listRules({ enabledOnly: true }, db), { maxChars: 250 });
    expect(block.includedIds).toEqual([policy.id]);
    expect(block.droppedIds).toEqual([tone.id]);
  });

  it('never drops a policy rule, however tight the budget', () => {
    // The budget decides which rules to spend characters on. A policy rule is
    // not that kind of decision: dropped, it is a refund promised that the
    // desk does not give. So it is exempt, and the drops the retrieval layer
    // is later asked to choose from can only be the cheaper categories.
    const policyOne = seed('P'.repeat(400), { category: 'policy' });
    const policyTwo = seed('Q'.repeat(400), { category: 'policy' });
    const product = seed('R'.repeat(400), { category: 'product' });

    const block = selectRules(listRules({ enabledOnly: true }, db), { maxChars: 100 });

    expect(block.includedIds).toContain(policyOne.id);
    expect(block.includedIds).toContain(policyTwo.id);
    expect(block.droppedIds).toEqual([product.id]);
  });

  it('emits at least one rule even when a single rule exceeds the budget', () => {
    seed('X'.repeat(500));
    expect(selectRules(listRules({}, db), { maxChars: 10 }).includedIds).toHaveLength(1);
  });

  it('orders rules by insertion, not by id, when timestamps collide', () => {
    const created = Array.from({ length: 8 }, (_, i) => seed(`Rule ${i}.`));
    const listed = listRules({}, db);
    expect(listed.map(r => r.id)).toEqual(created.map(r => r.id));
    expect(listed.map(r => r.seq)).toEqual([...listed.map(r => r.seq)].sort((a, b) => a - b));
  });

  it('preserves creation order in the output regardless of priority', () => {
    seed('Older tone rule.', { category: 'tone' });
    seed('Newer policy rule.', { category: 'policy' });

    const text = selectRules(listRules({ enabledOnly: true }, db)).text;
    expect(text.indexOf('Older tone rule.')).toBeLessThan(text.indexOf('Newer policy rule.'));
  });

  it('groups by category with ids for the extractor', () => {
    seed('A policy.', { category: 'policy' });
    seed('A tone note.', { category: 'tone' });

    const formatted = formatRulesForReview(listRules({}, db));
    expect(formatted).toContain('### policy');
    expect(formatted).toContain('### tone');
    expect(formatRulesForReview([])).toBe('(no rules yet)');
  });
});

// --- dedup ----------------------------------------------------------------

describe('dedupeAndApplyRule', () => {
  it('inserts without asking when there is nothing similar to compare against', async () => {
    seed('Refunds take ten business days.');

    const result = await dedupeAndApplyRule(
      { content: 'Sign every reply with the agent first name.' },
      { db },
    );

    expect(result.action).toBe('add');
    // No shortlist means no call — the model never sees a prompt it could
    // hallucinate a match from.
    expect(prompts).toHaveLength(0);
  });

  it('skips a duplicate the model recognises', async () => {
    const existing = seed('Refunds are processed within ten business days.');
    queued.push(
      JSON.stringify({ action: 'skip', conflictRuleId: existing.id, reason: 'Same thing' }),
    );

    const result = await dedupeAndApplyRule(
      { content: 'A refund completes inside ten business days.' },
      { db },
    );

    expect(result).toMatchObject({ action: 'skip', conflictRuleId: existing.id, rule: null });
    expect(listRules({}, db)).toHaveLength(1);
  });

  it('adds instead of skipping when the model names a rule it was never shown', async () => {
    seed('Refunds are processed within ten business days.');
    queued.push(JSON.stringify({ action: 'skip', conflictRuleId: 'invented-id' }));

    const result = await dedupeAndApplyRule(
      { content: 'A refund completes inside ten business days.' },
      { db },
    );

    // Honouring the hallucination would silently discard a learned rule.
    expect(result.action).toBe('add');
    expect(listRules({}, db)).toHaveLength(2);
  });

  it('merges into the existing rule and keeps the old text in history', async () => {
    const existing = seed('Refunds take ten business days.');
    queued.push(
      JSON.stringify({
        action: 'merge',
        conflictRuleId: existing.id,
        mergedContent: 'Refunds take ten business days, longer for bank transfers.',
      }),
    );

    const result = await dedupeAndApplyRule(
      { content: 'Refunds by bank transfer take longer.' },
      { db },
    );

    expect(result.action).toBe('merge');
    expect(listRules({}, db)).toHaveLength(1);
    expect(getRule(existing.id, db)?.content).toContain('bank transfers');
    expect(listRevisions(existing.id, db)[0]).toMatchObject({
      reason: 'merge',
      previousContent: 'Refunds take ten business days.',
    });
  });

  it('replaces a contradicted rule, recording what it used to say', async () => {
    const existing = seed('Refunds take ten business days.', { category: 'general' });
    queued.push(JSON.stringify({ action: 'replace', conflictRuleId: existing.id }));

    const result = await dedupeAndApplyRule(
      { content: 'Refunds take five business days.', category: 'policy' },
      { db },
    );

    expect(result.action).toBe('replace');
    const updated = getRule(existing.id, db)!;
    expect(updated.content).toBe('Refunds take five business days.');
    expect(updated.category).toBe('policy');
    expect(listRevisions(existing.id, db)[0]?.reason).toBe('replace');
  });

  it('falls back to adding when a merge arrives without merged text', async () => {
    const existing = seed('Refunds take ten business days.');
    queued.push(JSON.stringify({ action: 'merge', conflictRuleId: existing.id }));

    expect(
      (await dedupeAndApplyRule({ content: 'Refunds by transfer take longer.' }, { db })).action,
    ).toBe('add');
  });

  it('adds the rule when the dedup call fails — a learned rule is not lost to an outage', async () => {
    seed('Refunds take ten business days.');
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;

    const result = await dedupeAndApplyRule(
      { content: 'Refunds take ten working days.' },
      { db },
    );

    expect(result.action).toBe('add');
    expect(listRules({}, db)).toHaveLength(2);
  });

  it('adds the rule when the verdict is unparseable', async () => {
    seed('Refunds take ten business days.');
    queued.push('I am afraid I cannot do that.');

    expect(
      (await dedupeAndApplyRule({ content: 'Refunds take ten working days.' }, { db })).action,
    ).toBe('add');
  });

  it('only compares rules about the same topics', async () => {
    seed('Answer within one business day.', { topics: ['refunds'] });

    const result = await dedupeAndApplyRule(
      { content: 'Answer within one business day.', topics: ['onboarding'] },
      { db },
    );

    // Same sentence, different kind of mail — not a duplicate, and no call.
    expect(result.action).toBe('add');
    expect(prompts).toHaveLength(0);
  });

  it('dedupes a batch against itself, not just against the database', async () => {
    const pool = listRules({ enabledOnly: true }, db);

    const first = await dedupeAndApplyRule(
      { content: 'Refunds take ten business days.' },
      { against: pool, db },
    );
    queued.push(JSON.stringify({ action: 'skip', conflictRuleId: first.rule!.id }));
    const second = await dedupeAndApplyRule(
      { content: 'A refund completes in ten business days.' },
      { against: pool, db },
    );

    expect(second.action).toBe('skip');
    expect(listRules({}, db)).toHaveLength(1);
  });

  it('rejects an empty candidate before it reaches the model', async () => {
    expect((await dedupeAndApplyRule({ content: '  ' }, { db })).action).toBe('skip');
    expect(prompts).toHaveLength(0);
  });
});

// --- the loop -------------------------------------------------------------

const sample = {
  taskId: 'task-42',
  incomingSubject: 'Where is my refund?',
  incomingBody: '<p>I asked for a refund last week and heard nothing.</p>',
  originalDraft: 'Hi. I am so sorry. Your refund will arrive within 3 days. Thanks.',
  sentReply: 'Hi. We have escalated this and will update you shortly. Thanks.',
};

describe('learnFromSentReply', () => {
  it('puts both versions and the diff in front of the model', async () => {
    queued.push(JSON.stringify({ newRules: [] }));
    await learnFromSentReply(sample, { db });

    const prompt = prompts[0]!;
    expect(prompt).toContain('What the assistant drafted');
    expect(prompt).toContain('What the human actually sent');
    expect(prompt).toContain('The human removed:');
    expect(prompt).toContain('Your refund will arrive within 3 days.');
    // HTML is stripped rather than sent as markup.
    expect(prompt).toContain('I asked for a refund last week');
    expect(prompt).not.toContain('<p>');
  });

  it('stores a proposed rule with its provenance', async () => {
    queued.push(
      JSON.stringify({
        newRules: [
          {
            content: 'Never commit to a refund date that has not been confirmed.',
            category: 'policy',
            rationale: 'The reviewer removed a promised date.',
          },
        ],
      }),
    );

    const outcome = await learnFromSentReply(sample, { db });

    expect(outcome.results.map(r => r.action)).toEqual(['add']);
    const stored = listRules({}, db)[0]!;
    expect(stored).toMatchObject({
      category: 'policy',
      sourceTaskId: 'task-42',
      rationale: 'The reviewer removed a promised date.',
    });
  });

  it('confines what it learns to the topic it was given', async () => {
    queued.push(JSON.stringify({ newRules: [{ content: 'Escalate before promising a date.' }] }));
    await learnFromSentReply({ ...sample, topic: 'refunds' }, { db });
    expect(listRules({}, db)[0]?.topics).toEqual(['refunds']);
  });

  it('tells the model an unedited draft is usually not a lesson', async () => {
    queued.push(JSON.stringify({ newRules: [] }));
    await learnFromSentReply(
      { ...sample, originalDraft: sample.sentReply },
      { db },
    );

    expect(prompts[0]!).toContain('sent unchanged');
    expect(prompts[0]!).not.toContain('What the human actually sent');
  });

  it('honours the cap on new rules per conversation', async () => {
    queued.push(
      JSON.stringify({
        newRules: [
          { content: 'Rule one about promising refund dates.' },
          { content: 'Rule two about signing off politely.' },
          { content: 'Rule three about escalation paths.' },
        ],
      }),
    );

    const outcome = await learnFromSentReply(sample, { db, maxNewRules: 2 });
    expect(outcome.results).toHaveLength(2);
    expect(listRules({}, db)).toHaveLength(2);
  });

  it('applies an amendment to a rule it was shown', async () => {
    const existing = seed('Refunds take ten business days.');
    queued.push(
      JSON.stringify({
        amendRules: [{ ruleId: existing.id, newContent: 'Refunds take up to ten business days.' }],
      }),
    );

    const outcome = await learnFromSentReply(sample, { db });

    expect(outcome.amended).toEqual([
      { ruleId: existing.id, content: 'Refunds take up to ten business days.' },
    ]);
    expect(listRevisions(existing.id, db)[0]).toMatchObject({ reason: 'learned', actor: 'task-42' });
  });

  it('discards an amendment naming a rule that was never in the prompt', async () => {
    const untouched = seed('Refunds take ten business days.');
    queued.push(
      JSON.stringify({ amendRules: [{ ruleId: 'made-up', newContent: 'Something else.' }] }),
    );

    const outcome = await learnFromSentReply(sample, { db });

    expect(outcome.amended).toEqual([]);
    expect(outcome.discarded).toContain('amend:made-up');
    expect(getRule(untouched.id, db)?.content).toBe('Refunds take ten business days.');
  });

  it('reports a failed learning call without pretending it succeeded', async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;

    const outcome = await learnFromSentReply(sample, { db });
    expect(outcome).toMatchObject({ attempted: true, results: [], amended: [] });
  });

  it('does nothing when there is no sent reply to learn from', async () => {
    const outcome = await learnFromSentReply({ ...sample, sentReply: '   ' }, { db });
    expect(outcome.attempted).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('drops a proposal with no content', async () => {
    queued.push(JSON.stringify({ newRules: [{ category: 'policy' }] }));
    const outcome = await learnFromSentReply(sample, { db });
    expect(outcome.discarded).toContain('new:(empty)');
    expect(listRules({}, db)).toHaveLength(0);
  });
});

// --- summaries ------------------------------------------------------------

describe('summarising rules', () => {
  const reply = (entries: { id: string; summary: string }[]): string =>
    JSON.stringify({ summaries: entries });

  it('returns a line per rule, keyed by id', async () => {
    const a = seed('Refunds are not given after thirty days.');
    const b = seed('Never mention the internal ticket number.');
    queued.push(
      reply([
        { id: a.id, summary: 'When a refund is asked for late' },
        { id: b.id, summary: 'What must not appear in a reply' },
      ]),
    );

    const summaries = await summariseRules([a, b]);

    expect(summaries.get(a.id)).toBe('When a refund is asked for late');
    expect(summaries.get(b.id)).toBe('What must not appear in a reply');
  });

  it('ignores a summary for a rule it was never given', async () => {
    const rule = seed('Refunds are not given after thirty days.');
    queued.push(reply([{ id: 'invented', summary: 'Something' }]));

    const summaries = await summariseRules([rule]);
    expect(summaries.size).toBe(0);
  });

  it('strips an echoed id and flattens a multi-line answer', async () => {
    const rule = seed('Refunds are not given after thirty days.');
    queued.push(reply([{ id: rule.id, summary: `[${rule.id}] Late\n   refund requests` }]));

    expect((await summariseRules([rule])).get(rule.id)).toBe('Late refund requests');
  });

  it('makes no call at all for an empty batch', async () => {
    expect((await summariseRules([])).size).toBe(0);
    expect(prompts).toHaveLength(0);
  });

  it('survives an unparseable response with no summaries rather than a throw', async () => {
    const rule = seed('Refunds are not given after thirty days.');
    queued.push('I am afraid I cannot do that.');

    expect((await summariseRules([rule])).size).toBe(0);
  });

  it('attaches a summary only while the rule still says what was summarised', () => {
    const rule = seed('Refunds are not given after thirty days.');

    expect(attachSummary(rule.id, 'Late refunds', rule.content, db)).toBe(true);
    expect(getRule(rule.id, db)?.summary).toBe('Late refunds');

    // The rule moved under us — a summary of text that no longer exists is
    // worse than none.
    expect(attachSummary(rule.id, 'Stale', 'text it no longer has', db)).toBe(false);
    expect(getRule(rule.id, db)?.summary).toBe('Late refunds');
  });

  it('clears the summary when the content is rewritten', () => {
    const rule = seed('Refunds are not given after thirty days.');
    attachSummary(rule.id, 'Late refunds', rule.content, db);

    const updated = updateRule(rule.id, { content: 'Refunds are given for sixty days.' }, {}, db);
    expect(updated?.summary).toBeNull();
  });

  it('keeps the summary when only the category or topics move', () => {
    const rule = seed('Refunds are not given after thirty days.');
    attachSummary(rule.id, 'Late refunds', rule.content, db);

    const updated = updateRule(rule.id, { category: 'policy', topics: ['account-access'] }, {}, db);
    expect(updated?.summary).toBe('Late refunds');
  });

  it('lists exactly the rules still waiting for one', () => {
    const done = seed('Refunds are not given after thirty days.');
    const waiting = seed('Never mention the internal ticket number.');
    attachSummary(done.id, 'Late refunds', done.content, db);

    const pending = listRules({ unsummarisedOnly: true }, db);
    expect(pending.map(r => r.id)).toEqual([waiting.id]);
  });
});

// --- retrieval ------------------------------------------------------------

describe('retrieving the rules that did not fit', () => {
  const ask = (available: Rule[]) =>
    retrieveRules({ subject: 'Refund please', body: 'I want my money back.', available });

  it('returns the full text of the rules it asks for', async () => {
    const wanted = seed('Refunds take ten business days.', { category: 'product' });
    const other = seed('Never quote an API rate limit.', { category: 'product' });
    queued.push(JSON.stringify({ read: [wanted.id] }));

    const result = await ask([wanted, other]);

    expect(result.rules.map(r => r.id)).toEqual([wanted.id]);
    expect(formatRetrieved(result.rules)).toContain('Refunds take ten business days.');
  });

  it('indexes by summary where there is one, and by the rule where there is not', async () => {
    const summarised = seed('Refunds take ten business days.', { category: 'product' });
    const bare = seed('Never quote an API rate limit.', { category: 'product' });
    attachSummary(summarised.id, 'How long a refund takes', summarised.content, db);
    queued.push(JSON.stringify({ read: [] }));

    await ask([getRule(summarised.id, db)!, bare]);

    expect(prompts[0]).toContain('How long a refund takes');
    // Not silently unreachable just because nothing has summarised it yet.
    expect(prompts[0]).toContain('Never quote an API rate limit.');
    expect(prompts[0]).not.toContain('Refunds take ten business days.');
  });

  it('ignores an id it was never shown', async () => {
    const rule = seed('Refunds take ten business days.', { category: 'product' });
    queued.push(JSON.stringify({ read: ['invented', rule.id] }));

    expect((await ask([rule])).rules.map(r => r.id)).toEqual([rule.id]);
  });

  it('refuses to undo the budget when the model asks for everything', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      seed(`Rule ${i}: ${'x'.repeat(50)}`, { category: 'tone' }),
    );
    queued.push(JSON.stringify({ read: many.map(r => r.id) }));

    const result = await ask(many);

    expect(result.rules.length).toBeLessThanOrEqual(12);
    expect(result.refusedIds.length).toBe(20 - result.rules.length);
  });

  it('returns the rules in the order they were written, not the order asked for', async () => {
    const first = seed('First.', { category: 'tone' });
    const second = seed('Second.', { category: 'tone' });
    queued.push(JSON.stringify({ read: [second.id, first.id] }));

    expect((await ask([first, second])).rules.map(r => r.id)).toEqual([first.id, second.id]);
  });

  it('costs nothing when nothing was dropped', async () => {
    expect((await ask([])).rules).toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  it('drafts without them rather than failing when the call does', async () => {
    const rule = seed('Refunds take ten business days.', { category: 'product' });
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;

    expect((await ask([rule])).rules).toEqual([]);
  });
});

// --- the rulebook a desk starts with --------------------------------------

describe('starter rules', () => {
  it('installs every one of them into an empty rulebook', () => {
    const result = installStarterRules(db);

    expect(result).toEqual({ added: STARTER_RULES.length, skipped: 0 });
    expect(listRules({}, db)).toHaveLength(STARTER_RULES.length);
  });

  it('adds nothing the second time', () => {
    installStarterRules(db);
    const again = installStarterRules(db);

    expect(again).toEqual({ added: 0, skipped: STARTER_RULES.length });
    expect(listRules({}, db)).toHaveLength(STARTER_RULES.length);
  });

  it('does not resurrect a starter rule somebody retired', () => {
    installStarterRules(db);
    const retired = listRules({}, db)[0]!;
    disableRule(retired.id, db);

    installStarterRules(db);

    expect(listRules({}, db)).toHaveLength(STARTER_RULES.length);
    expect(getRule(retired.id, db)?.enabled).toBe(false);
  });

  it('leaves a starter rule that has since been rewritten alone', () => {
    installStarterRules(db);
    const edited = listRules({}, db)[0]!;
    updateRule(edited.id, { content: 'Our own wording, thanks.' }, {}, db);

    // The old text is gone, so that one comes back — and the rewritten rule is
    // untouched, which is what matters: an edit is never overwritten.
    const again = installStarterRules(db);

    expect(again.added).toBe(1);
    expect(getRule(edited.id, db)?.content).toBe('Our own wording, thanks.');
  });

  it('ships every rule with a summary, so the page is scannable at once', () => {
    installStarterRules(db);
    expect(listRules({ unsummarisedOnly: true }, db)).toEqual([]);
  });

  it('applies to every kind of mail, on a desk whose topics it cannot know', () => {
    installStarterRules(db);
    const rules = listRules({ enabledOnly: true }, db);

    expect(rules.every(rule => rule.topics.length === 0)).toBe(true);
    // Which is the only reason they survive routing to an unheard-of topic.
    const block = selectRules(rules, { topic: 'something-else-entirely' });
    expect(block.includedIds).toHaveLength(STARTER_RULES.length);
    expect(block.droppedIds).toEqual([]);
  });

  it('says where each one came from', () => {
    installStarterRules(db);
    expect(listRules({}, db).every(rule => rule.rationale?.includes('Starter rule'))).toBe(true);
  });
});
