import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The machine door, which six endpoints share.
 *
 * `requireMachine` used to end in `return hasSession()`, so a token that did
 * not match fell through to the cookie, and an install with no password and no
 * operators answered `{ operatorId: null }` to a request carrying nothing at
 * all. These tests are the shape of that bug, kept where it can be seen.
 */

const jar = { value: undefined as string | undefined };

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (jar.value ? { value: jar.value } : undefined) }),
}));

const { openDb, setDb } = await import('../db');
const { createOperator, setOperatorAdmin, setOperatorEnabled } = await import(
  '../operators/store'
);
const { resetSessionSecret } = await import('./secret');
const { issueToken } = await import('./session');
const { isAdmin, requireMachine } = await import('./guard');

const KEYS = ['CRON_TOKEN', 'AAS_MACHINE_SESSION', 'ADMIN_PASSWORD', 'SESSION_SECRET'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** A POST as a scheduler makes it: no Origin, because nothing rendered a page. */
function machineRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://desk.example/api/sync', { method: 'POST', headers });
}

beforeEach(() => {
  setDb(openDb(':memory:'));
  resetSessionSecret();
  jar.value = undefined;
});

afterEach(() => {
  setDb(null);
  jar.value = undefined;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('requireMachine', () => {
  it('accepts the token it was given', async () => {
    setEnv({ CRON_TOKEN: 'sekrit' });
    expect(await requireMachine(machineRequest({ authorization: 'Bearer sekrit' }))).toBe(true);
  });

  it('refuses a wrong token instead of trying the cookie', async () => {
    setEnv({ CRON_TOKEN: 'sekrit', AAS_MACHINE_SESSION: '1' });
    const sam = createOperator('Sam', 'hunter2');
    jar.value = issueToken(sam.id);

    // A logged-in reviewer holding a perfectly good cookie is still not the
    // scheduler, and a caller who guessed the wrong token learns nothing.
    expect(await requireMachine(machineRequest({ authorization: 'Bearer wrong' }))).toBe(false);
    expect(await requireMachine(machineRequest())).toBe(false);
  });

  it('refuses everything when no token is set and the fallback is not opted into', async () => {
    setEnv({ CRON_TOKEN: undefined, AAS_MACHINE_SESSION: undefined });
    const sam = createOperator('Sam', 'hunter2');
    jar.value = issueToken(sam.id);

    expect(await requireMachine(machineRequest())).toBe(false);
  });

  it('is wide open to nobody on a fresh install with neither password nor operators', async () => {
    // The state this was reachable in: no ADMIN_PASSWORD, no operators, so
    // `hasSession()` answers "logged in as nobody" to a request with no cookie.
    setEnv({ CRON_TOKEN: undefined, AAS_MACHINE_SESSION: undefined, ADMIN_PASSWORD: undefined });
    expect(await requireMachine(machineRequest())).toBe(false);
  });

  it('takes the session once someone opts in', async () => {
    setEnv({ CRON_TOKEN: undefined, AAS_MACHINE_SESSION: '1' });
    const sam = createOperator('Sam', 'hunter2');
    jar.value = issueToken(sam.id);

    expect(await requireMachine(machineRequest({ host: 'desk.example' }))).toBe(true);
  });

  it('refuses a session request that came from another site', async () => {
    setEnv({ CRON_TOKEN: undefined, AAS_MACHINE_SESSION: '1' });
    const sam = createOperator('Sam', 'hunter2');
    jar.value = issueToken(sam.id);

    // A form on evil.example posting here with the reviewer's cookie attached.
    // SameSite=Lax is a browser default, not a check this code performs.
    expect(
      await requireMachine(
        machineRequest({ host: 'desk.example', origin: 'https://evil.example' }),
      ),
    ).toBe(false);
  });

  it('lets the app post to itself', async () => {
    setEnv({ CRON_TOKEN: undefined, AAS_MACHINE_SESSION: '1' });
    const sam = createOperator('Sam', 'hunter2');
    jar.value = issueToken(sam.id);

    expect(
      await requireMachine(
        machineRequest({ host: 'desk.example', origin: 'https://desk.example' }),
      ),
    ).toBe(true);
  });

  it('treats an unparseable Origin as not this one', async () => {
    setEnv({ CRON_TOKEN: undefined, AAS_MACHINE_SESSION: '1' });
    const sam = createOperator('Sam', 'hunter2');
    jar.value = issueToken(sam.id);

    expect(
      await requireMachine(machineRequest({ host: 'desk.example', origin: 'null' })),
    ).toBe(false);
  });
});

/**
 * The other door: the queue, the archive, the people list and the settings.
 *
 * What is behind it is not mail — it is the mailbox password, the model key and
 * the button that retires a colleague — so "is somebody logged in" stopped
 * being the whole question.
 */
describe('isAdmin', () => {
  it('is everyone on an install with nothing guarding it', async () => {
    // No password, no operators, and the wizard that fixes that is one of the
    // four screens. A flag that locked it would lock the only way to set it.
    setEnv({ ADMIN_PASSWORD: undefined });
    expect(await isAdmin()).toBe(true);
  });

  it('is the shared password, which is the key to the whole install', async () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    jar.value = issueToken(null);
    expect(await isAdmin()).toBe(true);
  });

  it('is nobody without a session', async () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    jar.value = undefined;
    expect(await isAdmin()).toBe(false);
  });

  it('is the first operator and not the colleague they added', async () => {
    setEnv({ ADMIN_PASSWORD: undefined });
    const sam = createOperator('Sam', 'hunter2');
    const zoe = createOperator('Zoe', 'hunter2');

    jar.value = issueToken(sam.id);
    expect(await isAdmin()).toBe(true);

    jar.value = issueToken(zoe.id);
    expect(await isAdmin()).toBe(false);
  });

  it('reads the row rather than the cookie, so a promotion takes effect now', async () => {
    // The cookie is good for a week and says nothing but who you are. Baking
    // the flag into it would mean a demotion took a week to land — which is the
    // same argument that makes `currentIdentity` read the row on every request.
    setEnv({ ADMIN_PASSWORD: undefined });
    createOperator('Sam', 'hunter2');
    const zoe = createOperator('Zoe', 'hunter2');
    jar.value = issueToken(zoe.id);

    setOperatorAdmin(zoe.id, true);
    expect(await isAdmin()).toBe(true);

    setOperatorAdmin(zoe.id, false);
    expect(await isAdmin()).toBe(false);
  });

  it('is not a retired admin', async () => {
    setEnv({ ADMIN_PASSWORD: 'hunter2' });
    const sam = createOperator('Sam', 'hunter2');
    jar.value = issueToken(sam.id);

    setOperatorEnabled(sam.id, false);
    expect(await isAdmin()).toBe(false);
  });
});
