import { afterEach, describe, expect, it } from 'vitest';

import { checkPassword, isProtected, issueToken, verifyToken } from './session';

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
  it('accepts a token it just issued', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    expect(verifyToken(issueToken())).toBe(true);
  });

  it('rejects a token nobody signed', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    // The shape the predecessor accepted: user, timestamp, random, no proof.
    expect(verifyToken('terry:1700000000000:abcdef')).toBe(false);
    expect(verifyToken(`${Date.now() + 60_000}.nonce.`)).toBe(false);
    expect(verifyToken('')).toBe(false);
    expect(verifyToken(undefined)).toBe(false);
  });

  it('rejects a token whose payload was edited to extend it', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    const token = issueToken(-1000);
    const [, nonce, signature] = token.split('.');
    expect(verifyToken(`${Date.now() + 86_400_000}.${nonce}.${signature}`)).toBe(false);
  });

  it('rejects an expired token even though the signature is good', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    expect(verifyToken(issueToken(-1))).toBe(false);
  });

  it('invalidates existing tokens when the password changes', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    const token = issueToken();
    setEnv({ ADMIN_PASSWORD: 'something-else' });
    expect(verifyToken(token)).toBe(false);
  });

  it('keeps tokens alive across a password change when SESSION_SECRET is pinned', () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2', SESSION_SECRET: 'pinned' });
    const token = issueToken();
    setEnv({ ADMIN_PASSWORD: 'something-else', SESSION_SECRET: 'pinned' });
    expect(verifyToken(token)).toBe(true);
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
});
