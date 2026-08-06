import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from './index';
import { snapshot } from './snapshot';
import { createRule, listRules } from '../rules/store';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aas-snap-'));
  db = openDb(join(dir, 'aas.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshot', () => {
  it('writes a copy you can open and read the old rulebook out of', async () => {
    createRule({ category: 'policy', content: 'Never promise a delivery date.' }, db);

    const path = await snapshot('consolidate', db);
    expect(path).toBeTruthy();

    // The point of the whole file: what the rules said before the pass.
    const restored = openDb(path!);
    expect(listRules({}, restored).map(rule => rule.content)).toEqual([
      'Never promise a delivery date.',
    ]);
    restored.close();
  });

  it('leaves the live database alone', async () => {
    createRule({ category: 'policy', content: 'A rule.' }, db);
    await snapshot('consolidate', db);

    expect(listRules({}, db)).toHaveLength(1);
  });

  it('keeps the last five and drops what is older', async () => {
    for (let i = 0; i < 8; i += 1) await snapshot('consolidate', db);

    expect(readdirSync(join(dir, 'snapshots'))).toHaveLength(5);
  });

  it('does not prune snapshots taken for another reason', async () => {
    for (let i = 0; i < 6; i += 1) await snapshot('consolidate', db);
    await snapshot('import', db);

    const names = readdirSync(join(dir, 'snapshots'));
    expect(names.filter(name => name.includes('-import-'))).toHaveLength(1);
    expect(names.filter(name => name.includes('-consolidate-'))).toHaveLength(5);
  });

  it('says nothing to copy for an in-memory database instead of failing', async () => {
    const memory = openDb(':memory:');

    expect(await snapshot('consolidate', memory)).toBeNull();

    memory.close();
  });

  it('returns null rather than throwing when the copy cannot be written', async () => {
    // Insurance that stops the work it was guarding is not insurance.
    const path = join(dir, 'aas.db');
    const doomed = openDb(path);
    rmSync(join(dir, 'snapshots'), { recursive: true, force: true });
    // A file where the directory needs to be.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'snapshots'), 'not a directory');

    expect(await snapshot('consolidate', doomed)).toBeNull();
    expect(existsSync(path)).toBe(true);

    doomed.close();
  });
});
