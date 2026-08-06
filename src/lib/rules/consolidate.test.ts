import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAiConfig } from '../ai';
import { openDb, type Db } from '../db';
import { getMeta } from '../db/meta';
import {
  applyConsolidation,
  consolidationGate,
  LAST_CONSOLIDATION,
  planConsolidation,
  salvageGroups,
} from './consolidate';
import { createRule, getRule, listRevisions, listRules, updateRule } from './store';
import type { Rule } from './types';

// A real HTTP server returning queued responses, so the prompt, the transport
// and the JSON extraction are all exercised — the same shape the other rule
// tests use.
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
      const content = queued.shift() ?? '{"groups":[]}';
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

const seed = (content: string, category: Rule['category'] = 'policy'): Rule =>
  createRule({ content, category }, db);

describe('salvageGroups', () => {
  const rules = [
    { id: 'a', content: 'Rule A' },
    { id: 'b', content: 'Rule B' },
    { id: 'c', content: 'Rule C' },
  ];

  it('keeps a rule the model forgot to mention', () => {
    const groups = salvageGroups([{ content: 'A and B', absorbs: ['a', 'b'] }], rules);

    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ content: 'Rule C', absorbs: ['c'] });
  });

  it('ignores an id that is not in the set', () => {
    const groups = salvageGroups([{ content: 'merged', absorbs: ['a', 'made-up'] }], rules);
    expect(groups[0]!.absorbs).toEqual(['a']);
  });

  it('gives a repeated id to the first group that claimed it', () => {
    const groups = salvageGroups(
      [
        { content: 'first', absorbs: ['a', 'b'] },
        { content: 'second', absorbs: ['b', 'c'] },
      ],
      rules,
    );

    expect(groups[0]!.absorbs).toEqual(['a', 'b']);
    expect(groups[1]!.absorbs).toEqual(['c']);
  });

  it('repairs an id with junk stuck to the end', () => {
    const groups = salvageGroups([{ content: 'merged', absorbs: ['a_placeholder'] }], rules);
    expect(groups[0]!.absorbs).toEqual(['a']);
  });

  it('does not prefix-match when told not to', () => {
    const synthetic = [
      { id: 'g_1', content: 'One' },
      { id: 'g_12', content: 'Twelve' },
    ];
    // Without exactOnly, "g_12" would also resolve to "g_1".
    const groups = salvageGroups([{ content: 'x', absorbs: ['g_12'] }], synthetic, {
      exactOnly: true,
    });
    expect(groups[0]!.absorbs).toEqual(['g_12']);
  });

  it('strips an id the model echoed into the rule text', () => {
    const groups = salvageGroups([{ content: '[a] [b] Say it once.', absorbs: ['a', 'b'] }], rules);
    expect(groups[0]!.content).toBe('Say it once.');
  });

  it('falls back to the original text when the model returns none', () => {
    const groups = salvageGroups([{ absorbs: ['a'] }], rules);
    expect(groups[0]!.content).toBe('Rule A');
  });

  it('covers every rule exactly once, whatever it is given', () => {
    const groups = salvageGroups('not even an array', rules);
    expect(groups.flatMap(g => g.absorbs).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('planConsolidation', () => {
  it('groups a category in one call when it fits', async () => {
    const first = seed('Never promise a refund date.');
    const second = seed('Do not give customers a date for their refund.');

    queued.push(
      JSON.stringify({
        groups: [
          {
            content: 'Never give a customer a date for a refund.',
            absorbs: [first.id, second.id],
            note: 'same instruction',
          },
        ],
      }),
    );

    const plan = await planConsolidation({ db });

    expect(prompts).toHaveLength(1);
    expect(plan).toMatchObject({ before: 2, after: 1 });
    expect(plan.categories[0]).toMatchObject({ category: 'policy', before: 2, after: 1 });
  });

  it('does not call the model for a category of one', async () => {
    seed('The only rule.');
    const plan = await planConsolidation({ db });

    expect(prompts).toHaveLength(0);
    expect(plan).toMatchObject({ before: 1, after: 1 });
  });

  it('leaves disabled rules out of the pass', async () => {
    seed('Live rule.');
    const retired = seed('Retired rule.');
    createRule({ content: 'x' }, db); // a second category, so 'policy' stays at one
    db.prepare('UPDATE rules SET enabled = 0 WHERE id = ?').run(retired.id);

    const plan = await planConsolidation({ db });
    expect(plan.before).toBe(2);
  });

  it('batches a large category and still accounts for every rule', async () => {
    const rules = Array.from({ length: 5 }, (_, i) => seed(`Rule number ${i}.`));

    // Two batches of two and one of one, then a cross-batch pass over the
    // groups that come back. Every response merges nothing, so coverage is
    // the only thing under test.
    for (let i = 0; i < 10; i++) queued.push('{"groups":[]}');

    const plan = await planConsolidation({ db, batchSize: 2, crossChunkSize: 2 });

    const covered = plan.categories.flatMap(c => c.groups).flatMap(g => g.absorbs);
    expect(covered.sort()).toEqual(rules.map(r => r.id).sort());
  });
});

describe('applyConsolidation', () => {
  async function planMerge(...contents: string[]) {
    const rules = contents.map(content => seed(content));
    queued.push(
      JSON.stringify({
        groups: [{ content: 'The merged rule.', absorbs: rules.map(r => r.id), note: 'why' }],
      }),
    );
    return { rules, plan: await planConsolidation({ db }) };
  }

  it('keeps the first rule, rewrites it, and retires the rest', async () => {
    const { rules, plan } = await planMerge('One.', 'Two.', 'Three.');

    const summary = applyConsolidation(plan, { db, actor: 'test' });

    expect(summary).toEqual({ merged: 1, rewritten: 1, disabled: 2 });
    expect(getRule(rules[0]!.id, db)).toMatchObject({
      content: 'The merged rule.',
      enabled: true,
    });
    expect(getRule(rules[1]!.id, db)!.enabled).toBe(false);
    expect(getRule(rules[2]!.id, db)!.enabled).toBe(false);
  });

  it('records what the surviving rule used to say', async () => {
    const { rules, plan } = await planMerge('One.', 'Two.');
    applyConsolidation(plan, { db, actor: 'job-1' });

    const revisions = listRevisions(rules[0]!.id, db);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      previousContent: 'One.',
      newContent: 'The merged rule.',
      reason: 'consolidation',
      actor: 'job-1',
    });
  });

  it('never rewrites a rule the model was told to keep', async () => {
    const rule = seed('Exactly this wording.');
    const other = seed('Something else entirely.', 'tone');
    void other;

    // The model "keeps" it but reflows the text — the failure this guards.
    queued.push(
      JSON.stringify({
        groups: [{ content: 'exactly this wording', absorbs: [rule.id] }],
      }),
    );

    const plan = await planConsolidation({ db });
    const summary = applyConsolidation(plan, { db });

    expect(summary).toEqual({ merged: 0, rewritten: 0, disabled: 0 });
    expect(getRule(rule.id, db)!.content).toBe('Exactly this wording.');
  });

  it('is one transaction — nothing is half applied', async () => {
    const { rules, plan } = await planMerge('One.', 'Two.');
    // A group naming a rule that has since been deleted must not stop the
    // rest of the plan, but must also not leave a dangling disable.
    plan.categories[0]!.groups.push({ content: 'Ghost.', absorbs: ['gone-1', 'gone-2'], note: null });

    const summary = applyConsolidation(plan, { db });

    expect(summary.merged).toBe(1);
    expect(listRules({ enabledOnly: true }, db)).toHaveLength(1);
  });

  it('stamps when it ran', async () => {
    const { plan } = await planMerge('One.', 'Two.');
    expect(getMeta(LAST_CONSOLIDATION, db)).toBeNull();

    applyConsolidation(plan, { db });
    const mark = JSON.parse(getMeta(LAST_CONSOLIDATION, db)!);
    expect(mark.seq).toBeGreaterThan(0);
    expect(mark.at).toMatch(/^\d{4}-/);
  });
});

describe('consolidationGate', () => {
  it('wants to run once enough rules have been written', () => {
    expect(consolidationGate({ db })).toMatchObject({ shouldRun: false, since: 'never' });

    for (let i = 0; i < 4; i++) seed(`Rule ${i}.`);

    expect(consolidationGate({ db })).toMatchObject({ shouldRun: true, changed: 4 });
    expect(consolidationGate({ db, threshold: 10 }).shouldRun).toBe(false);
  });

  it('stops wanting to run after a pass, and starts again after a new rule', async () => {
    for (let i = 0; i < 4; i++) seed(`Rule ${i}.`);

    queued.push('{"groups":[]}');
    applyConsolidation(await planConsolidation({ db }), { db });

    expect(consolidationGate({ db })).toMatchObject({ shouldRun: false, changed: 0 });
    // A hand-edit counts, even though the pass's own rewrites did not.
    updateRule(listRules({ enabledOnly: true }, db)[0]!.id, { content: 'Edited by hand.' }, {}, db);
    expect(consolidationGate({ db }).changed).toBe(1);

    // Four more rules on top of that one hand-edit.
    for (let i = 0; i < 4; i++) seed(`Later rule ${i}.`);
    expect(consolidationGate({ db })).toMatchObject({ shouldRun: true, changed: 5 });
  });
});
