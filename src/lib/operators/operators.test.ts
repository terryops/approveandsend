import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import {
  authenticate,
  countActiveOperators,
  createOperator,
  getOperator,
  hashPassword,
  listOperators,
  setOperatorEnabled,
  setOperatorPassword,
  touchOperator,
  verifyPassword,
} from './store';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('storing a password', () => {
  it('never stores the password', () => {
    // The system this replaces kept them in plaintext in a source file.
    const hash = hashPassword('hunter2');
    expect(hash).not.toContain('hunter2');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('salts, so two people with the same password do not look alike', () => {
    expect(hashPassword('hunter2')).not.toBe(hashPassword('hunter2'));
  });

  it('recognises the password it was made from, and only that one', () => {
    const hash = hashPassword('hunter2');
    expect(verifyPassword('hunter2', hash)).toBe(true);
    expect(verifyPassword('hunter', hash)).toBe(false);
    expect(verifyPassword('hunter2 ', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('refuses a hash it did not write rather than throwing', () => {
    // A row edited by hand should cost one login, not every page that lists
    // operators.
    for (const junk of ['', 'hunter2', 'bcrypt$a$b$c$d', 'scrypt$x$8$1$c2FsdA$aGFzaA', 'scrypt$0$8$1$c2FsdA$aGFzaA']) {
      expect(verifyPassword('hunter2', junk), junk).toBe(false);
    }
  });
});

describe('the people on the desk', () => {
  it('remembers one, without its password', () => {
    const sam = createOperator('Sam', 'hunter2', db);

    expect(sam.name).toBe('Sam');
    expect(sam.disabledAt).toBeNull();
    expect(JSON.stringify(sam)).not.toContain('hunter2');
    expect(getOperator(sam.id, db)?.name).toBe('Sam');
  });

  it('refuses a second Sam, whatever the capitals', () => {
    // Two identical names is an ambiguity at exactly the moment someone is
    // reading an attribution.
    createOperator('Sam', 'hunter2', db);
    expect(() => createOperator('sam', 'other', db)).toThrow();
  });

  it('refuses a nameless or passwordless operator', () => {
    expect(() => createOperator('  ', 'hunter2', db)).toThrow();
    expect(() => createOperator('Sam', '', db)).toThrow();
  });

  it('counts only the ones who can still log in', () => {
    const sam = createOperator('Sam', 'hunter2', db);
    createOperator('Ada', 'hunter2', db);
    expect(countActiveOperators(db)).toBe(2);

    setOperatorEnabled(sam.id, false, db);
    expect(countActiveOperators(db)).toBe(1);
  });

  it('keeps a disabled operator, because their name is on sent mail', () => {
    const sam = createOperator('Sam', 'hunter2', db);
    setOperatorEnabled(sam.id, false, db);

    // Still readable, so an old reply's byline still resolves to a person.
    expect(getOperator(sam.id, db)?.disabledAt).toBeTruthy();
    expect(listOperators(db)).toHaveLength(1);
  });

  it('lists the active ones first', () => {
    const sam = createOperator('Sam', 'hunter2', db);
    createOperator('Zoe', 'hunter2', db);
    setOperatorEnabled(sam.id, false, db);

    expect(listOperators(db).map(o => o.name)).toEqual(['Zoe', 'Sam']);
  });
});

describe('logging in as yourself', () => {
  it('takes the right password', () => {
    const sam = createOperator('Sam', 'hunter2', db);
    expect(authenticate('Sam', 'hunter2', db)?.id).toBe(sam.id);
  });

  it('does not mind how the name was capitalised or padded', () => {
    createOperator('Sam', 'hunter2', db);
    expect(authenticate('  sAm ', 'hunter2', db)).not.toBeNull();
  });

  it('refuses the wrong password, an unknown name, and a disabled operator alike', () => {
    const sam = createOperator('Sam', 'hunter2', db);

    expect(authenticate('Sam', 'wrong', db)).toBeNull();
    expect(authenticate('Nobody', 'hunter2', db)).toBeNull();

    setOperatorEnabled(sam.id, false, db);
    expect(authenticate('Sam', 'hunter2', db)).toBeNull();

    // And comes back when they do.
    setOperatorEnabled(sam.id, true, db);
    expect(authenticate('Sam', 'hunter2', db)).not.toBeNull();
  });

  it('takes a new password and stops taking the old one', () => {
    const sam = createOperator('Sam', 'hunter2', db);
    setOperatorPassword(sam.id, 'correct-horse', db);

    expect(authenticate('Sam', 'hunter2', db)).toBeNull();
    expect(authenticate('Sam', 'correct-horse', db)).not.toBeNull();
  });

  it('spends as long on a name that does not exist as on one that does', () => {
    // Returning early on an unknown name makes response time an oracle for
    // which names are real, and the names on a support desk are guessable.
    createOperator('Sam', 'hunter2', db);

    const time = (run: () => void) => {
      const started = process.hrtime.bigint();
      run();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const hit = time(() => authenticate('Sam', 'wrong', db));
    const miss = time(() => authenticate('Nobody', 'wrong', db));

    // Both do one scrypt. A miss that skipped it would be near-instant next to
    // the tens of milliseconds a hash costs, so a generous ratio still catches
    // the regression.
    expect(miss).toBeGreaterThan(hit / 4);
  });

  it('records when someone was last seen', () => {
    const sam = createOperator('Sam', 'hunter2', db);
    expect(sam.lastSeenAt).toBeNull();

    touchOperator(sam.id, db);
    expect(getOperator(sam.id, db)?.lastSeenAt).toBeTruthy();
  });
});
