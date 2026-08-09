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
      // `requireAdminApi()` calls `requireApi()` — it is the same question
      // followed by a second one, not a way around the first.
      .filter(([, body]) => !/require(?:Admin)?Api\(\)/.test(body))
      .map(([name]) => name);

    expect(
      unguarded,
      `these server actions never call requireApi(): ${unguarded.join(', ')}. ` +
        'Add the guard, or — if it is genuinely meant to be reachable without ' +
        'a session — add it to UNAUTHENTICATED with the reason.',
    ).toEqual([]);
  });

  /*
   * The second question, on the actions where a session is not the whole
   * answer.
   *
   * Every one of these is a button on a screen a reviewer cannot open, which is
   * exactly why the list is written down here rather than trusted to the nav: a
   * hidden link is not a permission check, and a form posts to an address, not
   * to a page. Somebody's browser has `/queue` in its history; a bookmarked POST
   * costs nothing to replay.
   *
   * Spelled out rather than derived from a path, because there is no path to
   * derive it from — all of them live in one `actions.ts` next to thirty that
   * are correctly open to everyone who reviews mail.
   */
  const ADMIN_ONLY = [
    'addOperator',
    'changeOperatorPassword',
    'setOperatorAccess',
    'setOperatorRole',
    'runQueue',
    'retryJobNow',
    'releaseJobNow',
    'deleteJobNow',
    'sweepNow',
    'askBackfill',
    'startBackfill',
    'stopBackfill',
    'clearBackfillHistory',
  ];

  it('asks a second question on the ones behind the admin flag', () => {
    const open = ADMIN_ONLY.filter(name => {
      const body = actions.get(name);
      // A renamed or deleted action is a failure here too. Dropping silently
      // out of the list is how a check like this stops checking anything.
      return body === undefined || !body.includes('requireAdminApi()');
    });

    expect(
      open,
      `these actions drive an admin-only screen but do not call requireAdminApi(): ${open.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * And the screens those buttons are on.
 *
 * Four files, named one by one. `/setup` is the layout rather than its pages
 * because a layout is the one place the check cannot be forgotten by whoever
 * adds the fifth step — the wizard is six files today and every one of them
 * would otherwise need remembering.
 */
const ADMIN_SCREENS = [
  ['queue', 'page.tsx'],
  ['backfill', 'page.tsx'],
  ['operators', 'page.tsx'],
  ['setup', 'layout.tsx'],
];

describe('admin-only screens', () => {
  it.each(ADMIN_SCREENS)('%s/%s stops a reviewer who types the address', (dir, file) => {
    const source = readFileSync(join(HERE, dir!, file!), 'utf8');
    expect(source).toContain('requireAdminPage()');
    // The plain guard left in place next to the new one would pass the line
    // above and let everyone in from whichever call ran first.
    expect(source).not.toMatch(/await requirePage\(\)/);
  });
});

/**
 * The same, for the wizard and the settings screen it becomes.
 *
 * Every action in that file writes something an install runs on — the mailbox
 * password, the model key, the Stripe secret, the organisation's own
 * description — so the rule there is not a list but the whole file.
 */
describe('setup actions', () => {
  const source = readFileSync(join(HERE, 'setup', 'actions.ts'), 'utf8');
  const actions = exportedFunctions(source);

  it('finds them at all', () => {
    expect(actions.size).toBeGreaterThan(5);
  });

  it('every one of them is behind the admin flag', () => {
    const open = [...actions]
      .filter(([, body]) => !body.includes('requireAdminApi()'))
      .map(([name]) => name);

    expect(
      open,
      `these setup actions never call requireAdminApi(): ${open.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * The other thing no individual test can hold.
 *
 * `field()` answers `''` both for a box somebody emptied and for a field the
 * form never carried, and `x || null` turns both into a wipe. That is harmless
 * while every form that reaches an action contains every field it writes — and
 * it stops being harmless the moment a field moves onto a panel of its own,
 * which is exactly what happened to the reviewer's note. Save and Approve then
 * cleared it on the way past: no error, no diff on screen, just a sentence
 * gone — and it is the sentence the rule extractor learns from, so the loss is
 * silent twice over.
 *
 * Read as text, for the reason the guard above is: a mock would have to be
 * written by somebody who already knew.
 */
const NULLABLE_FROM_FORM = ['reviewerNotes'];

describe('optional form fields', () => {
  const source = readFileSync(join(HERE, 'actions.ts'), 'utf8');
  const actions = exportedFunctions(source);

  /*
   * Through one variable, because that is where it actually hid.
   *
   * The first version of this matched only the inline spelling —
   * `reviewerNotes: field(form, 'notes') || null` — and `approveAndSend` wrote
   * `const notes = field(form, 'notes')` on one line and `reviewerNotes: notes
   * || null` twenty lines later. One name of indirection and the check saw
   * nothing, on the one action that still had the bug the check was written for.
   */
  it('never clears one from a field the form may not have carried', () => {
    const offenders: string[] = [];

    for (const [name, body] of actions) {
      for (const key of NULLABLE_FROM_FORM) {
        // `key: <something> || null`, where <something> is either the call
        // itself or a name bound to it earlier in the same function.
        const writes = new RegExp(`${key}:\\s*(field\\(form[^)]*\\)|[A-Za-z_$][\\w$]*)\\s*\\|\\|\\s*null`, 'g');
        for (const match of body.matchAll(writes)) {
          const read = match[1]!;
          if (read.startsWith('field(')) {
            offenders.push(`${name}: ${match[0]}`);
            continue;
          }
          const bound = new RegExp(`\\b(?:const|let)\\s+${read}\\s*=\\s*field\\(form`);
          if (bound.test(body)) offenders.push(`${name}: ${match[0]} — ${read} = field(form, …)`);
        }
      }
    }

    expect(
      offenders,
      `these writes cannot tell a cleared box from an absent one: ${offenders.join(' / ')}. ` +
        'Read it with optional() and skip the key when it is undefined, so an ' +
        'action that was never given the field leaves what is on the row alone.',
    ).toEqual([]);
  });

  /*
   * The draft and the subject are the same problem with a bigger blast radius,
   * and they had it: the layout switch posts from a form in the header that
   * carries neither, `field` turned both into `''`, and `keepEdits` wrote the
   * empties over the row. Switching the view with JavaScript off emptied the
   * reply. So `keepEdits` — the one function every button that is not Save goes
   * through — reads all three with the helper that can tell absent from empty.
   */
  it('keeps the draft and the subject the same way', () => {
    const body = actions.get('keepEdits') ?? source.slice(source.indexOf('async function keepEdits'));
    for (const name of ['draft', 'subject', 'notes']) {
      expect(body, `keepEdits reads ${name} with field(), which cannot tell absent from empty`)
        .toContain(`optional(form, '${name}')`);
    }
  });

  it('reads the note with the helper that can tell them apart', () => {
    expect(source).toContain("optional(form, 'notes')");
  });
});

/**
 * The third thing no individual test can hold: who may write the draft column.
 *
 * `sendReply` claims the row and then records `finalReply` against the draft it
 * was handed, so a write that lands between those two leaves a task whose record
 * of what was proposed is text somebody typed after the customer had already
 * read the mail. `keepEdits`, `restoreDraft`, `setReplyFormat` and
 * `useAlternative` all refuse `sent` and `sending` and each says so in a comment
 * — and `confirmSend`, the action bound to the review form itself, wrote three
 * columns unconditionally anyway, next to those four examples. `saveDraft` and
 * `approveAndSend` did too.
 *
 * That is the shape this file exists for: an invariant everybody agrees with,
 * documented in four places, and quietly missing from the fifth.
 */
describe('actions that write the draft', () => {
  const source = readFileSync(join(HERE, 'actions.ts'), 'utf8');
  const actions = exportedFunctions(source);

  /** Each `updateTask(…)` in a body, arguments and all, by counting brackets. */
  function updateTaskCalls(body: string): string[] {
    const out: string[] = [];
    for (const match of body.matchAll(/\bupdateTask\(/g)) {
      let depth = 0;
      let i = match.index! + match[0].length - 1;
      for (; i < body.length; i++) {
        if (body[i] === '(') depth += 1;
        else if (body[i] === ')' && (depth -= 1) === 0) break;
      }
      out.push(body.slice(match.index!, i + 1));
    }
    return out;
  }

  it('finds the writers at all, so this cannot pass by matching nothing', () => {
    const writers = [...actions].filter(([, body]) =>
      updateTaskCalls(body).some(call => /\bdraft\b/.test(call)),
    );
    expect(writers.map(([name]) => name)).toContain('confirmSend');
    expect(writers.length).toBeGreaterThan(2);
  });

  it('every one of them refuses a task that is sent or being sent', () => {
    const unguarded = [...actions]
      .filter(([, body]) => updateTaskCalls(body).some(call => /\bdraft\b/.test(call)))
      .filter(([, body]) => !(body.includes("'sent'") && body.includes("'sending'")))
      .map(([name]) => name);

    expect(
      unguarded,
      `these actions write the draft without checking the status first: ${unguarded.join(', ')}. ` +
        'A send holds a claim on the row and is about to record finalReply against ' +
        'that column — read the task and skip the write when it is sent or sending, ' +
        'the way keepEdits and restoreDraft do.',
    ).toEqual([]);
  });
});

/**
 * A submit button cannot carry its own name into a Server Action.
 *
 * `<button name="enabled" value="true" formAction={fn}>` is the obvious HTML —
 * a clicked submit contributes its name and value, which is how several buttons
 * are meant to share one form. React needs that same `name` to encode which
 * action to invoke, so it overwrites it: the rendered markup says
 * `name="$ACTION_ID_…"` and the field never arrives. The action then reads an
 * empty string, and `=== 'true'` is false forever.
 *
 * It cost this app two buttons that could only go one way. Retiring a rule
 * worked and restoring it retired it again; the same for an operator, where the
 * dead field also made the last-operator guard fire on the button meant to undo
 * a lockout. Both look exactly like a page that failed to reload.
 *
 * The supported way to give one action per-button arguments is to bind them —
 * see the note on `useAlternative`. This checks nobody reaches for the obvious
 * HTML again.
 */
describe('submit buttons with a server action', () => {
  const files: string[] = [];
  (function collect(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.tsx')) files.push(full);
    }
  })(HERE);

  it('finds the components at all', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('never carry a name of their own, because React overwrites it', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<button\b[^>]*>/g)) {
        const tag = match[0];
        if (!/formAction=/.test(tag)) continue;
        if (!/\bname=/.test(tag)) continue;
        offenders.push(`${file.slice(file.indexOf('src/'))}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }

    expect(
      offenders,
      `these buttons post a name React is going to overwrite:\n  ${offenders.join('\n  ')}\n` +
        'Bind the value to the action instead — formAction={theAction.bind(null, value)} — ' +
        'the way useAlternative does.',
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
