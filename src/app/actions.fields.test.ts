import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every box on a form reaches an action that actually reads it.
 *
 * The forms here are plain HTML posts, which is the whole design — but it also
 * means nothing connects a `name="notes"` to the `field(form, 'notes')` that was
 * supposed to receive it. Delete one side and the other keeps compiling. There
 * is no type, no import, no reference: the coupling is two string literals in
 * different files that happen to match, and when they stop matching the symptom
 * is a box the user filled in that quietly does nothing.
 *
 * That has already happened twice. A file picker was left in a form whose action
 * had been changed to one that ignores attachments, so a reviewer could attach
 * an invoice, press Send, and watch the mail go without it. And a notes box
 * moved onto a panel of its own while three actions went on reading `notes`
 * from forms that no longer carried it — see the sibling test for that half.
 *
 * So this reads both sides as text and matches them up. Blunt on purpose, for
 * the reason the `requireApi` check is: it cannot be satisfied by a mock, and it
 * fails on the day the wire comes loose rather than the day somebody notices an
 * attachment never arrived.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the action modules live. */
const ACTION_FILES = ['actions.ts', join('setup', 'actions.ts')];

/**
 * The helpers that pull a named value out of a posted form.
 *
 * `text` is the setup module's spelling of `field`; `optional` is the one that
 * can tell a cleared box from an absent one. A new helper added here without
 * being added to this list would make this test pass by seeing nothing, which
 * is why the count assertions below exist.
 */
const READERS = /(?:field|text|optional)\(form,\s*'([^']+)'|form\.get(?:All)?\('([^']+)'|readUploads\(form(?:,\s*'([^']+)')?\)/g;

/**
 * Comments out, before anything is matched against.
 *
 * Not fastidiousness — the first version of this test failed because the doc
 * comment on `optional()` quotes `field(form, 'notes')` while explaining why
 * that spelling is wrong. Prose about the code is not the code, and a scanner
 * that cannot tell them apart reports the explanation as the behaviour.
 *
 * Line comments only when they start the line, so that a `//` inside a string —
 * `http://localhost:11434/v1` and friends — survives.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Source text of every top-level function in a module, keyed by name. */
function functionBodies(source: string): Map<string, string> {
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  const marks = [...source.matchAll(/^(?:export )?(?:async )?(?:function|const)\s/gm)].map(m => m.index!);

  const out = new Map<string, string>();
  for (const match of starts) {
    const from = match.index!;
    const next = marks.find(index => index > from) ?? source.length;
    out.set(match[1]!, source.slice(from, next));
  }
  return out;
}

/**
 * Which form fields a function reads, following the helpers it hands the form
 * to.
 *
 * `keepEdits(form, id)` and `readUploads(form)` are where several actions do
 * their reading, so a check that only looked at the action's own body would
 * report half the app as dropping the draft.
 */
function fieldsRead(name: string, bodies: Map<string, string>, seen = new Set<string>()): Set<string> {
  const body = bodies.get(name);
  const found = new Set<string>();
  if (!body || seen.has(name)) return found;
  seen.add(name);

  for (const match of body.matchAll(READERS)) {
    found.add(match[1] ?? match[2] ?? match[3] ?? 'files');
  }
  for (const [, helper] of body.matchAll(/\b(\w+)\(form[,)]/g)) {
    if (helper && bodies.has(helper)) {
      for (const field of fieldsRead(helper, bodies, seen)) found.add(field);
    }
  }
  return found;
}

function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...componentFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

interface Form {
  file: string;
  action: string;
  /** The other actions this form's buttons can post to instead. */
  overrides: string[];
  names: string[];
}

function forms(): Form[] {
  const out: Form[] = [];
  for (const file of componentFiles(HERE)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/<form[^>]*action=\{(\w+)/g)) {
      const from = match.index! + match[0].length;
      const close = source.indexOf('</form>', from);
      const body = source.slice(from, close === -1 ? source.length : close);
      out.push({
        file: relative(HERE, file),
        action: match[1]!,
        overrides: [...new Set([...body.matchAll(/formAction=\{(\w+)/g)].map(m => m[1]!))],
        names: [...new Set([...body.matchAll(/name="([^"]+)"/g)].map(m => m[1]!))],
      });
    }
  }
  return out;
}

describe('form fields reach an action that reads them', () => {
  const reads = new Map<string, Set<string>>();
  for (const file of ACTION_FILES) {
    const source = stripComments(readFileSync(join(HERE, file), 'utf8'));
    const bodies = functionBodies(source);
    for (const match of source.matchAll(/^export async function (\w+)\((?:[^)]*,\s*)?form/gm)) {
      reads.set(match[1]!, fieldsRead(match[1]!, bodies));
    }
  }
  const all = forms();

  it('finds the forms and the actions at all, so this cannot pass by reading nothing', () => {
    expect(all.length).toBeGreaterThan(15);
    expect(reads.size).toBeGreaterThan(15);
    // If the reader patterns ever stop matching, every action looks like it
    // reads nothing and every form below looks broken — but a typo that made
    // them match *nothing* would instead make this whole file vacuous.
    expect(reads.get('login')).toEqual(new Set(['password', 'name']));
    // Followed through `keepFiles`, which is where the picker's contents are
    // read now that the picker is on the review screen rather than on the
    // panel that posts the send.
    expect(reads.get('attachFiles')?.has('files')).toBe(true);
    expect(reads.get('confirmSend')?.has('files')).toBe(true);
    // Followed through `keepEdits`, not read directly.
    expect(reads.get('askRedraft')?.has('draft')).toBe(true);
  });

  it('has no field that is posted and never read', () => {
    const dropped = all
      .map(form => {
        const readers = new Set<string>();
        for (const name of [form.action, ...form.overrides]) {
          for (const field of reads.get(name) ?? []) readers.add(field);
        }
        const lost = form.names.filter(name => !readers.has(name));
        return lost.length ? `${form.file} <form action={${form.action}}> drops ${lost.join(', ')}` : null;
      })
      .filter((entry): entry is string => entry !== null);

    expect(
      dropped,
      `these inputs post a value nothing reads:\n  ${dropped.join('\n  ')}\n` +
        'Either the action should read the field, or the input does not belong ' +
        'in this form — a box that silently does nothing is the worse of the two.',
    ).toEqual([]);
  });
});
