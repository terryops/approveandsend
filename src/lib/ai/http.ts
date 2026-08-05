import http from 'node:http';
import https from 'node:https';

export interface HttpResponse {
  status: number;
  body: string;
}

/**
 * POST JSON and return the raw response.
 *
 * Deliberately node:http rather than fetch(). Node's fetch (undici) enforces a
 * default 300s headersTimeout that AbortSignal cannot extend. Draft generation
 * against a slow or self-hosted model routinely runs 4-8 minutes, and every one
 * of those surfaced as a bare "fetch failed" with no way to raise the ceiling.
 * node:http lets us own the timeout.
 */
export function postJson(
  urlStr: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request aborted before it was sent'));
      return;
    }

    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(payload.length) },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', d => chunks.push(d as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }),
      );
    });

    const onAbort = () => req.destroy(new Error('Request aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', err => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));

    req.end(payload);
  });
}
