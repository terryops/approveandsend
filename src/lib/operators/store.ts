import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import { getDb, type Db } from '../db';

/**
 * Who is approving the mail.
 *
 * There is one bit of role here and no more: `admin`. Everyone who can log in
 * can do all of the *work* — read any task, edit any draft, send under their
 * own name, write rules — and the whole value of the table is still the
 * signature on the outcome. What the flag governs is the four screens that are
 * not work: the queue, the archive scan, this list, and the settings that hold
 * the mailbox password and the model key. A reviewer pressing the wrong thing
 * there does not send a bad reply, which is recoverable; it spends money, or
 * retires a colleague, or points the desk at a different mailbox.
 *
 * `ADMIN_PASSWORD` keeps working alongside this and is always an admin: it is
 * the shared key to the whole install, so treating it as anything less would
 * be a lock that opens for everyone and refuses the person holding the key. It
 * still logs in as nobody in particular — attribution reads "unattributed" —
 * which is right for a one-person install and is also the bootstrap path for
 * creating the first operator.
 */

export interface Operator {
  id: string;
  name: string;
  /** May reach the queue, the archive, this list and the settings. */
  admin: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  disabledAt: string | null;
}

interface Row {
  id: string;
  name: string;
  password_hash: string;
  is_admin: number;
  created_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
}

function toOperator(row: Row): Operator {
  return {
    id: row.id,
    name: row.name,
    admin: row.is_admin === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    disabledAt: row.disabled_at,
  };
}

/**
 * scrypt, at the parameters Node documents as interactive-login cost.
 *
 * Not bcrypt or argon2: both are native modules, and this project's one native
 * dependency is SQLite. A password hash that makes `npm install` need a
 * compiler on a Raspberry Pi is a password hash people work around.
 */
const COST = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, COST);
  return [
    'scrypt',
    COST.N,
    COST.r,
    COST.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * False rather than throwing on a hash this code did not write.
 *
 * A row corrupted by hand, or written by a future version with different
 * parameters, should fail one login — not take down every page that lists
 * operators.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Object.values(cost).every(value => Number.isInteger(value) && value > 0)) return false;

  const target = Buffer.from(expected, 'base64url');
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(salt, 'base64url'), target.length, cost);
  } catch {
    // Parameters this build of Node will not honour — an N above its memory
    // limit, most likely.
    return false;
  }

  return actual.length === target.length && timingSafeEqual(actual, target);
}

/**
 * The first person added is an admin; everybody after them is not.
 *
 * Not a parameter with a default, because the rule is about the install rather
 * than about the caller. The first row is written by the wizard, by whoever is
 * setting the desk up, and if it were not an admin the very next screen would
 * refuse them — there would be nobody who could promote anyone, on an install
 * that may well have no shared password to fall back on. Every row after that
 * is written by an admin who is already looking at the people page, which is
 * where the promoting happens.
 *
 * Counted over every row, retired ones included. Somebody who retires the only
 * admin and then adds a colleague has made a mistake worth refusing, not one
 * worth silently repairing by handing the newcomer the settings.
 */
export function createOperator(name: string, password: string, db: Db = getDb()): Operator {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('An operator needs a name');
  if (!password) throw new Error('An operator needs a password');

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM operators').get() as { n: number };

  const row: Row = {
    id: randomUUID(),
    name: trimmed,
    password_hash: hashPassword(password),
    is_admin: n === 0 ? 1 : 0,
    created_at: new Date().toISOString(),
    last_seen_at: null,
    disabled_at: null,
  };

  db.prepare(
    `INSERT INTO operators (id, name, password_hash, is_admin, created_at, last_seen_at, disabled_at)
     VALUES (@id, @name, @password_hash, @is_admin, @created_at, @last_seen_at, @disabled_at)`,
  ).run(row);

  return toOperator(row);
}

export function getOperator(id: string, db: Db = getDb()): Operator | null {
  const row = db.prepare('SELECT * FROM operators WHERE id = ?').get(id) as Row | undefined;
  return row ? toOperator(row) : null;
}

export function listOperators(db: Db = getDb()): Operator[] {
  const rows = db
    .prepare('SELECT * FROM operators ORDER BY disabled_at IS NOT NULL, name COLLATE NOCASE')
    .all() as Row[];
  return rows.map(toOperator);
}

/** How many people can currently log in. Zero means the door is `ADMIN_PASSWORD` alone. */
export function countActiveOperators(db: Db = getDb()): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM operators WHERE disabled_at IS NULL').get() as {
    n: number;
  };
  return row.n;
}

/**
 * How many people can currently change the settings.
 *
 * The number the two dangerous presses on the people page are checked against
 * — retiring an admin and demoting one. Zero here on an install with no shared
 * password is a desk nobody can configure again: no queue, no archive, no
 * mailbox settings, and no people page on which to undo it. The only way back
 * is a SQLite client, which is not a step to leave a colleague one click from.
 */
export function countActiveAdmins(db: Db = getDb()): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM operators WHERE disabled_at IS NULL AND is_admin = 1')
    .get() as { n: number };
  return row.n;
}

export function setOperatorAdmin(id: string, admin: boolean, db: Db = getDb()): boolean {
  const result = db
    .prepare('UPDATE operators SET is_admin = ? WHERE id = ?')
    .run(admin ? 1 : 0, id);
  return result.changes > 0;
}

export function setOperatorPassword(id: string, password: string, db: Db = getDb()): boolean {
  if (!password) throw new Error('An operator needs a password');
  const result = db
    .prepare('UPDATE operators SET password_hash = ? WHERE id = ?')
    .run(hashPassword(password), id);
  return result.changes > 0;
}

/**
 * Disable and re-enable. There is no delete, on purpose — see the migration.
 */
export function setOperatorEnabled(id: string, enabled: boolean, db: Db = getDb()): boolean {
  const result = db
    .prepare('UPDATE operators SET disabled_at = ? WHERE id = ?')
    .run(enabled ? null : new Date().toISOString(), id);
  return result.changes > 0;
}

export function touchOperator(id: string, db: Db = getDb()): void {
  db.prepare('UPDATE operators SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

/**
 * Name and password to an operator, or null.
 *
 * A disabled operator fails here rather than at a later check, so there is
 * exactly one place that decides whether someone may log in.
 *
 * A wrong name still costs a hash. Returning early on "no such operator" would
 * make the response time a working oracle for which names are real, and the
 * names on a support desk are worth guessing at.
 */
export function authenticate(name: string, password: string, db: Db = getDb()): Operator | null {
  const row = db
    .prepare('SELECT * FROM operators WHERE name = ? COLLATE NOCASE')
    .get(name.trim()) as Row | undefined;

  const hash = row?.password_hash ?? DECOY;
  const ok = verifyPassword(password, hash);

  if (!row || !ok || row.disabled_at) return null;
  return toOperator(row);
}

/** A real hash of a password nobody has, so the miss path costs what a hit does. */
const DECOY = hashPassword(randomBytes(32).toString('hex'));
