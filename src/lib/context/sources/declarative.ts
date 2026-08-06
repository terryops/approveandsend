import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ContextBlock, ContextField, ContextSource, LookupSubject } from '../types';

/**
 * Sources you declare instead of writing.
 *
 * The module-path mechanism assumes whoever wants a lookup can write
 * JavaScript and deploy a file next to the app. Most of the time they cannot,
 * or should not have to: the thing they want is one internal endpoint that
 * already returns JSON for an email address, and the only real work is saying
 * which of its fields matter and what they mean.
 *
 * So a spec in the config file gets the same treatment as a module: fetch a
 * URL or run a command, pull values out by path, and turn them into the same
 * `ContextBlock` everything else produces.
 *
 * It cannot act, for the same reason nothing else here can. `GET` and `POST`
 * are both allowed because plenty of internal lookups are POST-only, but a
 * source is called once per incoming email by a background job, and a config
 * file that fires a POST at something which charges a card is a footgun the
 * shape of the interface cannot prevent — only the discipline of pointing it
 * at read endpoints can.
 */

const execFileAsync = promisify(execFile);

export interface DeclarativeField {
  label: string;
  /** Dotted path into the response. A missing path drops the field. */
  path: string;
  /** Template for a link out. Same placeholders as everywhere else. */
  href?: string;
  /**
   * Rewrites the raw value, which is how a declarative source obeys the rule
   * that a source writes its own prose: `{"0": "Free", "2": "Unlimited"}`
   * spares the model from guessing what level 2 is.
   */
  map?: Record<string, string>;
  /** Appended to the mapped value. "credits", "days left". */
  suffix?: string;
}

export interface DeclarativeSpec {
  id: string;
  label: string;

  /** An HTTP lookup. Mutually exclusive with `command`. */
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  /** JSON body for a POST. Placeholders are substituted inside strings. */
  body?: unknown;

  /**
   * A command to run, as argv — never a shell string.
   *
   * The system this replaced built its lookup as
   * `execSync('node lookup.js "' + email + '"')`, so an address containing a
   * quote ran whatever followed it. An array of arguments cannot do that, and
   * costs nothing.
   */
  command?: string[];

  /** Milliseconds before giving up. External lookups fail fast or not at all. */
  timeoutMs?: number;

  /** Path to the object the rest of the paths are relative to. */
  root?: string;
  /**
   * A path that must be present and non-empty, or the lookup returns null.
   *
   * Most internal endpoints answer "no such user" with a 200 and an empty
   * record rather than a 404, and a card reading "Plan: —" is worse than no
   * card.
   */
  requires?: string;

  title: string;
  href?: string;
  fields?: DeclarativeField[];
  /**
   * Sentences for the model. Each is dropped whole if any placeholder in it is
   * missing, so a spec can describe a rich account and a sparse one without a
   * conditional: the sentence about expiring credits simply is not there for
   * someone who has none.
   */
  prompt?: string | string[];
}

export function isDeclarativeSpec(value: unknown): value is DeclarativeSpec {
  const spec = value as DeclarativeSpec | null;
  return (
    !!spec &&
    typeof spec === 'object' &&
    typeof spec.id === 'string' &&
    spec.id.trim() !== '' &&
    typeof spec.title === 'string' &&
    (typeof spec.url === 'string' || Array.isArray(spec.command))
  );
}

/** Dotted path, tolerant of everything: any miss is `undefined`, never a throw. */
export function readPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((node, key) => {
      if (node == null) return undefined;
      if (Array.isArray(node)) {
        const index = Number(key);
        return Number.isInteger(index) ? node[index] : undefined;
      }
      return typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    }, value);
}

function scalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

interface Filled {
  text: string;
  /** False when any placeholder had no value — the caller decides what that means. */
  complete: boolean;
}

/**
 * `{path}` substitution against the response, falling back to the sender.
 *
 * The sender's own `email`, `name` and `subject` are always available; a
 * response field of the same name shadows them, which is only ever the same
 * address written two ways.
 */
export function fill(template: string, data: unknown, subject: LookupSubject): Filled {
  let complete = true;

  const text = template.replace(/\{([^{}]+)\}/g, (_, raw: string) => {
    const path = raw.trim();
    const found = scalar(readPath(data, path)) ?? fallback(path, subject);
    if (found === null) {
      complete = false;
      return '';
    }
    return found;
  });

  return { text, complete };
}

function fallback(path: string, subject: LookupSubject): string | null {
  if (path === 'email') return subject.email;
  if (path === 'name') return subject.name;
  if (path === 'subject') return subject.subject;
  return null;
}

function encodeInto(template: string, subject: LookupSubject): string {
  // URL-encoded, because an address with a `+` or a `&` in it is a normal
  // address and a broken query string.
  return template.replace(/\{([^{}]+)\}/g, (_, raw: string) => {
    const value = fallback(raw.trim(), subject);
    return value === null ? '' : encodeURIComponent(value);
  });
}

function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    // `${VAR}` reads the environment, so a token stays in the environment and
    // the config file stays committable.
    resolved[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  return resolved;
}

function substituteBody(value: unknown, subject: LookupSubject): unknown {
  if (typeof value === 'string') return fill(value, null, subject).text;
  if (Array.isArray(value)) return value.map(entry => substituteBody(entry, subject));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substituteBody(entry, subject)]),
    );
  }
  return value;
}

async function runHttp(spec: DeclarativeSpec, subject: LookupSubject): Promise<unknown> {
  const method = (spec.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && spec.body !== undefined;

  const response = await fetch(encodeInto(spec.url ?? '', subject), {
    method,
    headers: {
      ...resolveHeaders(spec.headers),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(substituteBody(spec.body, subject)) } : {}),
    signal: AbortSignal.timeout(spec.timeoutMs ?? 8_000),
  });

  // A 404 is an answer: this person is not in that system.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${spec.id} lookup returned ${response.status}`);

  return response.json();
}

async function runCommand(spec: DeclarativeSpec, subject: LookupSubject): Promise<unknown> {
  const [program, ...rest] = spec.command ?? [];
  if (!program) throw new Error(`${spec.id} has an empty command`);

  // Each argument substituted whole and passed as an argument. No shell, so
  // no quoting to get wrong.
  const args = rest.map(arg => fill(arg, null, subject).text);

  const { stdout } = await execFileAsync(program, args, {
    timeout: spec.timeoutMs ?? 60_000,
    maxBuffer: 4 * 1024 * 1024,
    // Scripts of this kind habitually print progress to stderr and JSON to
    // stdout; only stdout is parsed.
    encoding: 'utf8',
  });

  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  return JSON.parse(stdout.slice(start, end + 1));
}

function buildFields(spec: DeclarativeSpec, data: unknown, subject: LookupSubject): ContextField[] {
  return (spec.fields ?? []).flatMap((field): ContextField[] => {
    const raw = scalar(readPath(data, field.path));
    if (raw === null) return [];

    const mapped = field.map?.[raw] ?? raw;
    const value = field.suffix ? `${mapped} ${field.suffix}` : mapped;
    const href = field.href ? fill(field.href, data, subject) : null;

    return [{ label: field.label, value, ...(href?.complete && href.text ? { href: href.text } : {}) }];
  });
}

function buildPrompt(spec: DeclarativeSpec, data: unknown, subject: LookupSubject): string {
  const sentences = typeof spec.prompt === 'string' ? [spec.prompt] : (spec.prompt ?? []);

  return sentences
    .map(sentence => fill(sentence, data, subject))
    .filter(result => result.complete && result.text.trim() !== '')
    .map(result => result.text.trim())
    .join(' ');
}

/** Turns a spec into the same thing a hand-written module would have exported. */
export function buildDeclarativeSource(spec: DeclarativeSpec): ContextSource {
  return {
    id: spec.id,
    label: spec.label || spec.title,

    async lookup(subject: LookupSubject): Promise<ContextBlock | null> {
      const response = spec.command ? await runCommand(spec, subject) : await runHttp(spec, subject);
      if (response == null) return null;

      const data = spec.root ? readPath(response, spec.root) : response;
      if (data == null) return null;
      if (spec.requires && scalar(readPath(data, spec.requires)) === null) return null;

      const href = spec.href ? fill(spec.href, data, subject) : null;

      return {
        title: fill(spec.title, data, subject).text || spec.title,
        fields: buildFields(spec, data, subject),
        prompt: buildPrompt(spec, data, subject),
        ...(href?.text ? { href: href.text } : {}),
      };
    },
  };
}
