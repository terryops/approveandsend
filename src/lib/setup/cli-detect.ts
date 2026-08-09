import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CLI_KINDS, cliChildEnv, type CliKind } from '../ai/providers/cli';

const exec = promisify(execFile);

/**
 * Is there a subscription on this machine we could be spending?
 *
 * The setup screen cannot ask somebody to paste a key they do not have, and the
 * two things that would work instead are already sitting on their disk, logged
 * in, from some afternoon they spent in a terminal. So the screen goes and
 * looks, and offers what it finds by name — "Claude Max, signed in as you@…"
 * is an offer; "set AI_PROVIDER=cli" is homework.
 *
 * Every probe returns rather than throws, for the same reason the connection
 * checks next door do: not finding a CLI is the ordinary case, not an error.
 */

/** What we found, in the order of how much use it is. */
export type CliState =
  /** No such binary on this process's PATH. */
  | 'missing'
  /** Installed, but nobody has signed it in. */
  | 'logged-out'
  /** Signed in with an API key, which the direct providers do better. */
  | 'api-key'
  /** Signed in against a subscription. This is the one we are looking for. */
  | 'ready';

export interface CliStatus {
  kind: CliKind;
  state: CliState;
  /** As the CLI reports it, for the line that says what was found. */
  version: string | null;
  /** The signed-in address, when the CLI will say. */
  account: string | null;
  /** The plan word the CLI uses: `max`, `pro`, `ChatGPT`. */
  plan: string | null;
  /** The command that moves this on a state, or null when nothing will. */
  fix: string | null;
}

/**
 * The same binary the provider will run.
 *
 * `AI_CLI_BIN` overrides the name for whichever CLI is configured, so a server
 * whose PATH is missing `~/.local/bin` can be pointed at an absolute path — and
 * this screen has to agree with that, or it reports a CLI as absent while the
 * drafter happily uses it.
 */
function binFor(kind: CliKind): string {
  const configured = process.env.AI_CLI?.trim().toLowerCase();
  const override = process.env.AI_CLI_BIN?.trim();
  return override && configured === kind ? override : kind;
}

/** Five seconds. These are local processes that answer in under one. */
const PROBE_TIMEOUT_MS = 5_000;

async function probe(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(bin, args, {
      timeout: PROBE_TIMEOUT_MS,
      env: cliChildEnv(),
      windowsHide: true,
    });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (error) {
    // A non-zero exit still carries the output we want — "not logged in" is
    // reported that way by both — so the body matters as much as the failure.
    const shell = error as { stdout?: string; stderr?: string; code?: string | number };
    if (shell.code === 'ENOENT') return { ok: false, out: '' };
    return { ok: false, out: `${shell.stdout ?? ''}${shell.stderr ?? ''}` };
  }
}

const missing = (kind: CliKind): CliStatus => ({
  kind,
  state: 'missing',
  version: null,
  account: null,
  plan: null,
  fix: null,
});

/** `2.1.226 (Claude Code)` and `codex-cli 0.145.0` both reduce to the number. */
function versionOf(text: string): string | null {
  return /(\d+\.\d+\.\d+\S*)/.exec(text)?.[1] ?? null;
}

interface ClaudeAuth {
  loggedIn?: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

async function detectClaude(): Promise<CliStatus> {
  const bin = binFor('claude');
  const version = await probe(bin, ['--version']);
  if (!version.ok && !version.out) return missing('claude');

  const status = await probe(bin, ['auth', 'status']);
  const base = {
    kind: 'claude' as const,
    version: versionOf(version.out),
    fix: 'claude auth login',
  };

  let auth: ClaudeAuth = {};
  try {
    auth = JSON.parse(status.out.trim()) as ClaudeAuth;
  } catch {
    // An older build, or a shape we do not know. It is installed, and that is
    // all we can honestly claim.
    return { ...base, state: 'logged-out', account: null, plan: null };
  }

  if (!auth.loggedIn) return { ...base, state: 'logged-out', account: null, plan: null };

  // `claude.ai` is the seat. Anything else is a key, and a key is better spent
  // through the Anthropic provider, which does not resend a coding agent's
  // preamble before every draft.
  const seat = auth.authMethod === 'claude.ai';
  return {
    ...base,
    state: seat ? 'ready' : 'api-key',
    account: auth.email ?? null,
    plan: seat ? (auth.subscriptionType ?? null) : null,
    fix: seat ? null : base.fix,
  };
}

async function detectCodex(): Promise<CliStatus> {
  const bin = binFor('codex');
  const version = await probe(bin, ['--version']);
  if (!version.ok && !version.out) return missing('codex');

  const status = await probe(bin, ['login', 'status']);
  const base = { kind: 'codex' as const, version: versionOf(version.out), fix: 'codex login' };

  // `Logged in using ChatGPT` is the sentence we are hoping for. The API-key
  // login says so in its own words, and a logged-out CLI exits non-zero.
  if (/api key/i.test(status.out)) {
    return { ...base, state: 'api-key', account: emailIn(status.out), plan: null };
  }
  if (status.ok && /logged in/i.test(status.out)) {
    return { ...base, state: 'ready', account: emailIn(status.out), plan: 'ChatGPT', fix: null };
  }
  return { ...base, state: 'logged-out', account: null, plan: null };
}

function emailIn(text: string): string | null {
  return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0] ?? null;
}

/**
 * Cached, because this renders on a page rather than behind a button.
 *
 * Four processes per paint is not a cost the settings screen should carry every
 * time somebody scrolls past the model section. Fifteen seconds is short enough
 * that finishing `claude auth login` in the next terminal and reloading shows
 * the new answer, which is the one interaction that would be maddening to get
 * wrong.
 */
let cache: { at: number; statuses: CliStatus[] } | null = null;
const CACHE_MS = 15_000;

export function resetCliDetection(): void {
  cache = null;
}

export async function detectClis(): Promise<CliStatus[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.statuses;

  const statuses = await Promise.all([detectClaude(), detectCodex()]);
  // Ordered as declared, so the screen does not reshuffle itself between one
  // visit and the next.
  statuses.sort((a, b) => CLI_KINDS.indexOf(a.kind) - CLI_KINDS.indexOf(b.kind));

  cache = { at: Date.now(), statuses };
  return statuses;
}
