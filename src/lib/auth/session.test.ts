import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, setDb } from '../db';
import { createOperator } from '../operators/store';
import { resetSessionSecret } from './secret';
import { checkPassword, cookieSecure, isProtected, issueToken, verifyToken } from './session';

const KEYS = ['ADMIN_PASSWORD', 'SESSION_SECRET'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('sessions', () => {
  // `isProtected()` asks the database whether there are operators, so even the
  // password-only tests need one to ask.
  beforeEach(() => {
    setDb(openDb(':memory:'));
    // The generated signing key is cached per process; a fresh database means
    // a fresh key, or a test would sign with the previous one's.
    resetSessionSecret();
  });

  afterEach(() => {
    setDb(null);
  });

  it('accepts a token it just issued', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    expect(verifyToken(issueToken())).toEqual({ operatorId: null });
  });

  it('remembers which operator it was issued to', () => {
    setEnv({ ADMIN_PASSWORD: undefined });
    const sam = createOperator('Sam', 'hunter2');
    expect(verifyToken(issueToken(sam.id))).toEqual({ operatorId: sam.id });
  });

  it('rejects a token nobody signed', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    // The shape the predecessor accepted: user, timestamp, random, no proof.
    expect(verifyToken('terry:1700000000000:abcdef')).toBeNull();
    expect(verifyToken(`.${Date.now() + 60_000}.nonce.`)).toBeNull();
    expect(verifyToken('')).toBeNull();
    expect(verifyToken(undefined)).toBeNull();
  });

  it('rejects a token whose payload was edited to extend it', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    const token = issueToken(null, -1000);
    const [operator, , nonce, signature] = token.split('.');
    expect(verifyToken(`${operator}.${Date.now() + 86_400_000}.${nonce}.${signature}`)).toBeNull();
  });

  it('rejects a token edited to claim someone else sent the reply', () => {
    setEnv({ ADMIN_PASSWORD: undefined });
    const sam = createOperator('Sam', 'hunter2');
    const ada = createOperator('Ada', 'hunter2');
    const [, ...rest] = issueToken(sam.id).split('.');
    expect(verifyToken([ada.id, ...rest].join('.'))).toBeNull();
  });

  it('rejects an expired token even though the signature is good', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    expect(verifyToken(issueToken(null, -1))).toBeNull();
  });

  it('invalidates existing tokens when the password changes', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    const token = issueToken();
    setEnv({ ADMIN_PASSWORD: 'something-else' });
    expect(verifyToken(token)).toBeNull();
  });

  it('keeps tokens alive across a password change when SESSION_SECRET is pinned', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2', SESSION_SECRET: 'pinned' });
    const token = issueToken();
    setEnv({ ADMIN_PASSWORD: 'something-else', SESSION_SECRET: 'pinned' });
    expect(verifyToken(token)).toEqual({ operatorId: null });
  });

  it('compares passwords without leaking length through an exception', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    expect(checkPassword('hunter2')).toBe(true);
    expect(checkPassword('hunter')).toBe(false);
    expect(checkPassword('hunter2-and-then-some')).toBe(false);
    expect(checkPassword('')).toBe(false);
  });

  it('reports itself unprotected when no password is configured', () => {
    setEnv({ ADMIN_PASSWORD: undefined });
    expect(isProtected()).toBe(false);
    // And lets everything through rather than locking the operator out.
    expect(checkPassword('anything')).toBe(true);
  });

  it('treats a whitespace-only password as no password at all', () => {
    setEnv({ ADMIN_PASSWORD: '   ' });
    expect(isProtected()).toBe(false);
  });

  it('counts operators as protection, with no password at all', () => {
    setEnv({ ADMIN_PASSWORD: undefined });
    createOperator('Sam', 'hunter2');
    expect(isProtected()).toBe(true);
  });
});

describe('cookieSecure', () => {
  afterEach(() => {
    delete process.env.COOKIE_SECURE;
  });

  it('marks the cookie Secure on HTTPS', () => {
    expect(cookieSecure('https')).toBe(true);
  });

  it('does not, on the plain-http address a self-hosted install usually has', () => {
    // The regression this replaces: NODE_ENV=production forced Secure here,
    // the browser dropped the cookie, and /login reloaded forever.
    expect(cookieSecure('http')).toBe(false);
  });

  it('reads the client-facing scheme from a proxy chain', () => {
    expect(cookieSecure('https, http')).toBe(true);
    expect(cookieSecure('http, https')).toBe(false);
  });

  it('is not fooled by case or padding', () => {
    expect(cookieSecure('  HTTPS ')).toBe(true);
  });

  it('defaults to not-Secure rather than guessing when there is no header', () => {
    expect(cookieSecure(null)).toBe(false);
    expect(cookieSecure(undefined)).toBe(false);
  });

  it('lets an operator force it either way', () => {
    process.env.COOKIE_SECURE = 'true';
    expect(cookieSecure('http')).toBe(true);

    process.env.COOKIE_SECURE = 'false';
    expect(cookieSecure('https')).toBe(false);
  });

  it('ignores a value that means neither', () => {
    process.env.COOKIE_SECURE = 'maybe';
    expect(cookieSecure('https')).toBe(true);
    expect(cookieSecure('http')).toBe(false);
  });
});
