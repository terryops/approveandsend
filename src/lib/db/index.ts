import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { migrate } from './migrations';

export type Db = Database.Database;

let cached: Db | null = null;

function defaultPath(): string {
  return process.env.DATABASE_PATH?.trim() || resolve(process.cwd(), 'data/aas.db');
}

/**
 * Opens (and migrates) a database. `:memory:` is honoured, which is what the
 * tests use — every test gets a real SQLite instance rather than a fake, so
 * the schema and the queries are exercised for real.
 */
export function openDb(path: string = defaultPath()): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // WAL lets the web request reading rules and the background worker writing
  // them proceed at the same time. Without it the worker's transaction blocks
  // page loads for as long as an LLM call takes.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

/** The process-wide connection. */
export function getDb(): Db {
  if (!cached) cached = openDb();
  return cached;
}

export function closeDb(): void {
  cached?.close();
  cached = null;
}

/** Point the process-wide connection at an already-open database. For tests. */
export function setDb(db: Db | null): void {
  cached = db;
}

export { migrate, SCHEMA_VERSION } from './migrations';
