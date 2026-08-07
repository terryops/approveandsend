import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { callAI, resetAiConfig } from './index';
import { AiError } from './types';

interface Recorded {
  path: string;
  headers: http.IncomingHttpHeaders;
  /**
   * Whatever the provider put on the wire. Deliberately `any`: giving it our
   * own type would let a provider stop sending a field and still typecheck,
   * which is the one thing these tests exist to notice.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** Every server a test started, so a failed assertion cannot leak one. */
const started: (() => Promise<void>)[] = [];

/** A stand-in model server, so the tests exercise real HTTP, not a mock. */
function startServer(
  handler: (req: Recorded, res: http.ServerResponse) => void,
): Promise<{ url: string; calls: Recorded[]; close: () => Promise<void> }> {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const recorded: Recorded = {
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(recorded);
      handler(recorded, res);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const close = () => new Promise<void>(done => server.close(() => done()));
      started.push(close);
      resolve({ url: `http://127.0.0.1:${port}/v1`, calls, close });
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const completion = (text: string) => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetAiConfig();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AI_')) delete process.env[key];
  }
  // Retries are real sleeps; keep the default at zero and opt in per test.
  process.env.AI_MAX_RETRIES = '0';
  process.env.AI_TIMEOUT_MS = '5000';
});

afterEach(async () => {
  // Each test closes its own server on the way out, but only on the way out:
  // an assertion that throws first would otherwise leave a socket listening.
  for (const close of started.splice(0)) await close();
  process.env = { ...ORIGINAL_ENV };
  resetAiConfig();
});

describe('OpenAI-compatible provider', () => {
  it('sends the OpenAI wire format and returns the completion', async () => {
    const server = await startServer((_req, res) => json(res, 200, completion('Hello Vincent')));
    process.env.AI_BASE_URL = server.url;
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL = 'some-model';

    const text = await callAI('draft a reply', { role: 'drafter', system: 'you are support' });

    expect(text).toBe('Hello Vincent');
    expect(server.calls).toHaveLength(1);
    const call = server.calls[0]!;
    expect(call.path).toBe('/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer test-key');
    expect(call.body.model).toBe('some-model');
    expect(call.body.messages).toEqual([
      { role: 'system', content: 'you are support' },
      { role: 'user', content: 'draft a reply' },
    ]);
    // drafter defaults
    expect(call.body.temperature).toBe(0.7);
    expect(call.body.max_tokens).toBe(4000);

    await server.close();
  });

  it('omits the Authorization header when no key is set, for local runtimes', async () => {
    const server = await startServer((_req, res) => json(res, 200, completion('ok')));
    process.env.AI_BASE_URL = server.url;
    process.env.AI_MODEL = 'llama3';

    await callAI('hi');

    expect(server.calls[0]!.headers.authorization).toBeUndefined();
    await server.close();
  });

  it('treats a 200 with empty content as a failure rather than an empty draft', async () => {
    const server = await startServer((_req, res) =>
      json(res, 200, { choices: [{ message: { content: '   ' } }] }),
    );
    process.env.AI_BASE_URL = server.url;
    process.env.AI_MODEL = 'm';

    await expect(callAI('hi')).rejects.toThrow(/empty completion/i);
    await server.close();
  });

  it('does not retry a 400, which means our request is wrong', async () => {
    const server = await startServer((_req, res) => json(res, 400, { error: { message: 'bad' } }));
    process.env.AI_BASE_URL = server.url;
    process.env.AI_MODEL = 'm';
    process.env.AI_MAX_RETRIES = '2';

    await expect(callAI('hi')).rejects.toBeInstanceOf(AiError);
    expect(server.calls).toHaveLength(1);
    await server.close();
  });

  it('retries a 503 and succeeds on the next attempt', async () => {
    let seen = 0;
    const server = await startServer((_req, res) => {
      seen += 1;
      if (seen === 1) return json(res, 503, { error: { message: 'overloaded' } });
      return json(res, 200, completion('recovered'));
    });
    process.env.AI_BASE_URL = server.url;
    process.env.AI_MODEL = 'm';
    process.env.AI_MAX_RETRIES = '1';
    // The real backoff is ten seconds, which is a third of the suite's wall
    // time for one sleep. The pause is not what is under test; the retry is.
    process.env.AI_RETRY_BASE_MS = '10';

    await expect(callAI('hi')).resolves.toBe('recovered');
    expect(server.calls).toHaveLength(2);
    await server.close();
  });
});

describe('Anthropic provider', () => {
  it('uses x-api-key, a top-level system field, and joins text blocks', async () => {
    const server = await startServer((_req, res) =>
      json(res, 200, {
        content: [
          { type: 'text', text: 'Dear ' },
          { type: 'thinking', text: 'ignored' },
          { type: 'text', text: 'Vincent' },
        ],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    process.env.AI_PROVIDER = 'anthropic';
    process.env.AI_BASE_URL = server.url;
    process.env.AI_API_KEY = 'sk-ant-test';
    process.env.AI_MODEL = 'claude-x';

    const text = await callAI('draft', { role: 'critic', system: 'be strict' });

    expect(text).toBe('Dear Vincent');
    const call = server.calls[0]!;
    expect(call.path).toBe('/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body.system).toBe('be strict');
    expect(call.body.messages).toEqual([{ role: 'user', content: 'draft' }]);
    // critic runs cold
    expect(call.body.temperature).toBe(0.2);

    await server.close();
  });
});

describe('role configuration', () => {
  it('lets each role target a different model, falling back to AI_MODEL', async () => {
    const server = await startServer((_req, res) => json(res, 200, completion('ok')));
    process.env.AI_BASE_URL = server.url;
    process.env.AI_MODEL = 'default-model';
    process.env.AI_MODEL_DRAFTER = 'big-model';
    process.env.AI_MODEL_TRANSLATOR = 'cheap-model';

    await callAI('a', { role: 'drafter' });
    await callAI('b', { role: 'translator' });
    await callAI('c', { role: 'critic' });

    expect(server.calls.map(c => c.body.model)).toEqual([
      'big-model',
      'cheap-model',
      'default-model',
    ]);
    await server.close();
  });

  it('fails loudly when AI_MODEL is missing instead of guessing', async () => {
    process.env.AI_BASE_URL = 'http://127.0.0.1:1';
    await expect(callAI('hi')).rejects.toThrow(/AI_MODEL is required/);
  });

  it('rejects an unknown provider by name', async () => {
    process.env.AI_PROVIDER = 'not-a-provider';
    process.env.AI_MODEL = 'm';
    await expect(callAI('hi')).rejects.toThrow(/Unknown AI_PROVIDER/);
  });

  it('rejects an empty prompt before making a request', async () => {
    process.env.AI_BASE_URL = 'http://127.0.0.1:1';
    process.env.AI_MODEL = 'm';
    await expect(callAI('   ')).rejects.toThrow(/non-empty prompt/);
  });
});

describe('network failures', () => {
  it('surfaces a connection refusal as a transient AiError', async () => {
    process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1';
    process.env.AI_MODEL = 'm';

    const err = await callAI('hi').catch(e => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/unreachable/);
  });
});
