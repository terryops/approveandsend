import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The one invariant no individual test can hold.
 *
 * Every server action mutates something on behalf of whoever posted the form,
 * and the only thing standing between a form post and the mailbox is the
 * `requireApi()` on the first line of each. Thirty-odd of them do it today.
 * Nothing makes the next one — written in a hurry, next to thirty examples
 * that all look right — do it too, and an action that forgets is not a failing
 * test anywhere: it is a working feature with the lock left off.
 *
 * So this reads the file as text. It is a blunt instrument and deliberately
 * so: it cannot be satisfied by a mock, and it fails on the day the guard is
 * dropped rather than the day somebody notices.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Exempt, and they have to be.
 *
 * `login` is the call that establishes a session, so requiring one would make
 * signing in impossible. `logout` destroys the session it is handed; refusing
 * an unauthenticated caller would leave a half-expired cookie with no way to
 * clear it. Adding a name here is a decision to expose an endpoint to the
 * open internet, which is why the list is spelled out rather than derived.
 */
const UNAUTHENTICATED = new Set(['login', 'logout']);

/** The text of each `export async function`, keyed by name. */
function exportedFunctions(source: string): Map<string, string> {
  const starts = [...source.matchAll(/^export async function (\w+)/gm)];
  const boundaries = [...source.matchAll(/^export /gm)].map(m => m.index!);

  const out = new Map<string, string>();
  for (const match of starts) {
    const from = match.index!;
    const next = boundaries.find(index => index > from) ?? source.length;
    out.set(match[1]!, source.slice(from, next));
  }
  return out;
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

describe('server actions', () => {
  const path = join(HERE, 'actions.ts');
  const actions = exportedFunctions(readFileSync(path, 'utf8'));

  it('finds the actions at all, so this file cannot pass by reading nothing', () => {
    expect(actions.size).toBeGreaterThan(20);
    for (const name of UNAUTHENTICATED) expect(actions.has(name)).toBe(true);
  });

  it('every one of them asks who is calling', () => {
    const unguarded = [...actions]
      .filter(([name]) => !UNAUTHENTICATED.has(name))
      .filter(([, body]) => !body.includes('requireApi()'))
      .map(([name]) => name);

    expect(
      unguarded,
      `these server actions never call requireApi(): ${unguarded.join(', ')}. ` +
        'Add the guard, or — if it is genuinely meant to be reachable without ' +
        'a session — add it to UNAUTHENTICATED with the reason.',
    ).toEqual([]);
  });
});

describe('machine routes', () => {
  const files = routeFiles(join(HERE, 'api'));

  it('finds the routes at all', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it('every POST handler checks a caller before doing the work', () => {
    // Three ways to be authorised, because there are three kinds of caller: a
    // cron container with the shared token, a reviewer's browser, and the app
    // itself. Which one a route wants is its business; having none is not.
    const unguarded: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const post = exportedFunctions(source).get('POST');
      if (!post) continue;
      if (!/requireMachine|requireApi|hasSession/.test(post)) {
        unguarded.push(file.slice(file.indexOf('src/')));
      }
    }

    expect(
      unguarded,
      `these POST routes accept anybody: ${unguarded.join(', ')}`,
    ).toEqual([]);
  });
});
