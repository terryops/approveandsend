import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { notify } from './notify';

let server: Server | undefined;
let received: Record<string, unknown>[] = [];
let status = 204;

beforeEach(async () => {
  received = [];
  status = 204;

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        received.push({ unparseable: true });
      }
      res.writeHead(status);
      res.end();
    });
  });

  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server!.address() as AddressInfo;
  process.env.NOTIFY_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  delete process.env.NOTIFY_WEBHOOK_URL;
});

describe('notify', () => {
  it('sends the text under both the keys the two common webhooks read', async () => {
    // Discord reads `content`, Slack reads `text`, and each ignores the
    // other's key — so nobody has to declare which one they pointed at.
    expect(await notify('Rulebook tidied.')).toBe(true);

    expect(received).toEqual([{ content: 'Rulebook tidied.', text: 'Rulebook tidied.' }]);
  });

  it('stays out of the way when no webhook is configured', async () => {
    delete process.env.NOTIFY_WEBHOOK_URL;

    expect(await notify('Nobody is listening.')).toBe(false);
    expect(received).toEqual([]);
  });

  it('says nothing rather than posting an empty message', async () => {
    expect(await notify('   ')).toBe(false);
    expect(received).toEqual([]);
  });

  it('swallows a webhook that rejects the post', async () => {
    status = 400;

    expect(await notify('Something happened.')).toBe(false);
  });

  it('swallows a webhook that is not there at all', async () => {
    // The last thing after work that already succeeded. Alerting that can fail
    // a job is the outage it was meant to warn about.
    process.env.NOTIFY_WEBHOOK_URL = 'http://127.0.0.1:1/hook';

    await expect(notify('Something happened.')).resolves.toBe(false);
  });
});
