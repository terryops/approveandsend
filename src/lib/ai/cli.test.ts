import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { callAI, resetAiConfig } from './index';
import { CliProvider } from './providers/cli';
import { AiError, type AiRequest } from './types';

/**
 * Real subprocesses, standing in for the real CLIs.
 *
 * The same argument the HTTP tests next door make: a mocked `spawn` would let
 * this provider stop passing `--disallowed-tools` and still go green, and that
 * flag is the only thing standing between a customer's email and a shell on the
 * mail server. So each test writes a small shell script that records exactly
 * what it was handed — argv, environment, stdin — answers the way the tool it
 * is imitating answers, and is then read back and asserted against.
 *
 * Unix-only, like the scripts. So is the deployment: this is software that
 * holds an IMAP connection open.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aas-cli-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetAiConfig();
  for (const name of ['AI_PROVIDER', 'AI_CLI', 'AI_CLI_BIN', 'AI_MODEL', 'AI_MAX_RETRIES']) {
    delete process.env[name];
  }
});

/** A script that records its invocation into `dir`, then runs `body`. */
function fakeCli(body: string): string {
  const path = join(dir, 'fake-cli');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      // The child's environment is deliberately stripped, so the capture
      // directory cannot travel in a variable — it is baked in instead.
      `CAP='${dir}'`,
      // NUL-separated rather than one per line, because an empty argument is
      // one of the things being asserted — `--system-prompt ''` is how the
      // agent's own brief is removed, and a newline-separated capture loses it.
      'printf "%s\\0" "$@" > "$CAP/argv"',
      'env > "$CAP/env"',
      'cat > "$CAP/stdin"',
      body,
    ].join('\n'),
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
}

const captured = (name: string) => readFileSync(join(dir, name), 'utf8');
/** Every argument as passed, empty ones included; the trailing NUL is not one. */
const argv = () => captured('argv').split('\0').slice(0, -1);

function ask(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    prompt: 'Draft a reply.',
    model: 'default',
    temperature: 0.7,
    maxTokens: 4000,
    timeoutMs: 20_000,
    ...overrides,
  };
}

/** What `claude -p --output-format json` puts on stdout, trimmed to what we read. */
const claudeResult = (text: string, extra: Record<string, unknown> = {}) =>
  `echo '${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage: { input_tokens: 11, output_tokens: 22 },
    ...extra,
  })}'`;

/** Codex narrates on stdout and leaves the reply in the file it was given. */
const codexResult = (text: string) =>
  [
    'prev=""',
    'out=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi',
    '  prev="$a"',
    'done',
    `printf '%s' '${text}' > "$out"`,
    `echo '{"type":"turn.completed","usage":{"input_tokens":33,"output_tokens":44}}'`,
  ].join('\n');

describe('borrowing a Claude subscription through the CLI', () => {
  it('reads the answer and the token counts out of the result object', async () => {
    const provider = new CliProvider('claude', fakeCli(claudeResult('Thanks for writing in.')));

    const reply = await provider.complete(ask());

    expect(reply.text).toBe('Thanks for writing in.');
    expect(reply.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it('denies the agent every tool it would otherwise have', async () => {
    const provider = new CliProvider('claude', fakeCli(claudeResult('ok')));

    await provider.complete(ask());

    const denied = argv()[argv().indexOf('--disallowed-tools') + 1] ?? '';
    // Named individually rather than compared to a list, so that adding a tool
    // to the denial does not fail the test that exists to notice one leaving.
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch']) {
      expect(denied, tool).toContain(tool);
    }
    expect(argv()).toContain('--strict-mcp-config');
  });

  /*
   * The coding agent's brief is removed rather than overwritten.
   *
   * Putting our drafting instructions in that slot works on ordinary mail and
   * shows a seam on anything unusual — an adversarial email came back as
   * commentary about the email instead of as a draft. Emptying it and passing
   * the brief as the user turn is what both CLIs now do, byte for byte.
   */
  it('empties the agent’s own system prompt and does not write ours into it', async () => {
    const provider = new CliProvider('claude', fakeCli(claudeResult('ok')));

    await provider.complete(ask({ system: 'You answer support mail.', prompt: 'Draft a reply.' }));

    expect(argv()[argv().indexOf('--system-prompt') + 1]).toBe('');
    expect(argv()).not.toContain('You answer support mail.');
    expect(argv()).not.toContain('--append-system-prompt');

    const stdin = captured('stdin');
    expect(stdin.indexOf('You answer support mail.')).toBeLessThan(stdin.indexOf('Draft a reply.'));
  });

  it('sends the same bytes Codex would get', async () => {
    const claude = new CliProvider('claude', fakeCli(claudeResult('ok')));
    await claude.complete(ask({ system: 'Be brief.', prompt: 'Say hello.' }));
    const toClaude = captured('stdin');

    const codex = new CliProvider('codex', fakeCli(codexResult('ok')));
    await codex.complete(ask({ system: 'Be brief.', prompt: 'Say hello.' }));

    expect(captured('stdin')).toBe(toClaude);
  });

  it('leaves the model alone when nobody has named one', async () => {
    const provider = new CliProvider('claude', fakeCli(claudeResult('ok')));

    await provider.complete(ask({ model: 'default' }));
    expect(argv()).not.toContain('--model');

    await provider.complete(ask({ model: 'opus' }));
    expect(argv()[argv().indexOf('--model') + 1]).toBe('opus');
  });

  /*
   * The one this file exists for.
   *
   * This process holds the mailbox password and the Stripe key, and it is about
   * to hand a stranger's email to an agent. Inheriting the environment would
   * put both within reach of anything that talked the agent into reading them.
   */
  it('hands the agent none of this server’s secrets', async () => {
    process.env.MAIL_PASSWORD = 'hunter2';
    process.env.STRIPE_API_KEY = 'rk_live_nope';
    process.env.ADMIN_PASSWORD = 'letmein';
    const provider = new CliProvider('claude', fakeCli(claudeResult('ok')));

    try {
      await provider.complete(ask());
    } finally {
      delete process.env.MAIL_PASSWORD;
      delete process.env.STRIPE_API_KEY;
      delete process.env.ADMIN_PASSWORD;
    }

    const env = captured('env');
    expect(env).not.toContain('hunter2');
    expect(env).not.toContain('rk_live_nope');
    expect(env).not.toContain('letmein');
    // …while still leaving it able to find itself and its own login.
    expect(env).toMatch(/^PATH=/m);
    expect(env).toMatch(/^HOME=/m);
  });

  it('runs somewhere empty, so no CLAUDE.md joins the prompt', async () => {
    const provider = new CliProvider('claude', fakeCli([claudeResult('ok'), 'pwd > "$CAP/cwd"'].join('\n')));

    await provider.complete(ask());

    const cwd = captured('cwd').trim();
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toContain('aas-cli-');
  });

  it('says where to look when the binary is not there', async () => {
    const provider = new CliProvider('claude', join(dir, 'no-such-binary'));

    await expect(provider.complete(ask())).rejects.toThrow(/not found.*PATH|AI_CLI_BIN/s);
  });

  /*
   * A spent subscription is not a transient failure.
   *
   * It clears on a rolling window measured in hours. Retrying in thirty seconds
   * spends the first request of the next window on the same wall, which is how
   * a desk ends up rate-limited for longer than it had to be.
   */
  it('treats a spent subscription as final, not as something to retry', async () => {
    const script = fakeCli(['echo "5-hour usage limit reached" >&2', 'exit 1'].join('\n'));
    const provider = new CliProvider('claude', script);

    const error = await provider.complete(ask()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).transient).toBe(false);
    expect((error as AiError).message).toContain('rolling window');
  });

  it('names the login command when nobody is signed in', async () => {
    const script = fakeCli(['echo "Not logged in." >&2', 'exit 1'].join('\n'));
    const provider = new CliProvider('claude', script);

    const error = await provider.complete(ask()).catch((err: unknown) => err);

    expect((error as AiError).message).toContain('claude auth login');
    expect((error as AiError).transient).toBe(false);
  });

  it('retries an empty completion, the way the HTTP providers do', async () => {
    const provider = new CliProvider('claude', fakeCli(claudeResult('   ')));

    const error = await provider.complete(ask()).catch((err: unknown) => err);

    expect((error as AiError).transient).toBe(true);
  });
});

describe('borrowing a ChatGPT subscription through the CLI', () => {
  it('reads the reply out of the file it asked Codex to write', async () => {
    const provider = new CliProvider('codex', fakeCli(codexResult('Sorry about the delay.')));

    const reply = await provider.complete(ask());

    expect(reply.text).toBe('Sorry about the delay.');
    expect(reply.usage).toEqual({ inputTokens: 33, outputTokens: 44 });
  });

  it('sandboxes it, since it has no tools to deny', async () => {
    const provider = new CliProvider('codex', fakeCli(codexResult('ok')));

    await provider.complete(ask());

    expect(argv()).toContain('exec');
    expect(argv()[argv().indexOf('--sandbox') + 1]).toBe('read-only');
    expect(argv()).toContain('--ephemeral');
    expect(argv()).toContain('shell_environment_policy.inherit=none');
  });

  it('puts the system turn in front of the prompt, having nowhere else', async () => {
    const provider = new CliProvider('codex', fakeCli(codexResult('ok')));

    await provider.complete(ask({ system: 'You answer support mail.', prompt: 'Draft a reply.' }));

    const stdin = captured('stdin');
    expect(stdin.indexOf('You answer support mail.')).toBeLessThan(stdin.indexOf('Draft a reply.'));
  });

  /*
   * Codex reports a deprecated key in the operator's own config.toml as an
   * `error` item on stdout, mid-run, and then answers perfectly well. Throwing
   * that away would break this provider for anybody whose config has drifted.
   */
  it('keeps a good answer that arrived alongside a config warning', async () => {
    const noisy = [
      `echo '{"type":"item.completed","item":{"type":"error","message":"[features].codex_hooks is deprecated"}}'`,
      codexResult('Here is your refund.'),
    ].join('\n');
    const provider = new CliProvider('codex', fakeCli(noisy));

    const reply = await provider.complete(ask());

    expect(reply.text).toBe('Here is your refund.');
  });
});

describe('wiring it up through the configuration', () => {
  it('builds the CLI provider from AI_PROVIDER, AI_CLI and AI_CLI_BIN', async () => {
    process.env.AI_PROVIDER = 'cli';
    process.env.AI_CLI = 'claude';
    process.env.AI_CLI_BIN = fakeCli(claudeResult('ready'));
    process.env.AI_MODEL = 'default';
    resetAiConfig();

    await expect(callAI('Say ready')).resolves.toBe('ready');
  });

  it('refuses a CLI it does not have', async () => {
    process.env.AI_PROVIDER = 'cli';
    process.env.AI_CLI = 'gemini';
    process.env.AI_MODEL = 'default';
    resetAiConfig();

    await expect(callAI('anything')).rejects.toThrow(/AI_CLI/);
  });
});
