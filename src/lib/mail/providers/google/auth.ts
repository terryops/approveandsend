import { createSign } from 'node:crypto';

import { MailError } from '../../types';

/**
 * Google access tokens, without pulling in `googleapis` (which is tens of
 * megabytes for the three endpoints we actually call).
 *
 * Two ways in, because Gmail and Google Workspace are administered
 * differently:
 *
 * - **Refresh token.** One mailbox, consented once by its owner. Works for
 *   personal Gmail and for a single Workspace user. This is what most people
 *   should use.
 * - **Service account with domain-wide delegation.** A Workspace admin grants
 *   the service account a scope for the whole domain, and it then impersonates
 *   any mailbox in it. No per-user consent, no refresh token to rotate — but
 *   it is domain-wide authority, so it is only appropriate when an admin has
 *   deliberately set it up.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PROVIDER_ID = 'gmail';

/** Send and read. Not `gmail.modify` alone: we need to send, too. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

export interface RefreshTokenAuth {
  kind: 'refresh-token';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ServiceAccountAuth {
  kind: 'service-account';
  clientEmail: string;
  privateKey: string;
  /** The mailbox to act as. Required: a service account has no mailbox. */
  impersonate: string;
}

export type GoogleAuthConfig = (RefreshTokenAuth | ServiceAccountAuth) & {
  /** Overridable so tests can point at a local server. */
  tokenEndpoint?: string;
  scopes?: string[];
};

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Private keys arrive from env vars with literal `\n` instead of newlines
 * more often than not. PEM parsing fails obscurely when that happens, so
 * normalise rather than making the user debug it.
 */
export function normalizePrivateKey(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

export class GoogleAuth {
  private readonly config: GoogleAuthConfig;
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(config: GoogleAuthConfig) {
    this.config = config;
  }

  private get endpoint(): string {
    return this.config.tokenEndpoint ?? TOKEN_ENDPOINT;
  }

  /** A valid access token, refreshed when needed. */
  async accessToken(): Promise<string> {
    // 60s of slack: a token that expires mid-request is a confusing 401.
    if (this.cached && this.cached.expiresAtMs - 60_000 > Date.now()) {
      return this.cached.token;
    }
    // Concurrent callers share one refresh instead of racing to the endpoint.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Drop the cached token; the next call re-fetches. */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    const body =
      this.config.kind === 'refresh-token'
        ? new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            refresh_token: this.config.refreshToken,
          })
        : new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: this.signAssertion(this.config),
          });

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw new MailError(PROVIDER_ID, `Google token endpoint unreachable: ${errText(err)}`, {
        transient: true,
        cause: err,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new MailError(
        PROVIDER_ID,
        `Google token request failed (${response.status}): ${text.slice(0, 300)}`,
        // 400 here usually means a revoked refresh token — retrying will not help.
        { transient: response.status === 429 || response.status >= 500 },
      );
    }

    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MailError(PROVIDER_ID, `Unparseable token response: ${text.slice(0, 200)}`, {
        transient: true,
      });
    }

    if (!parsed.access_token) {
      throw new MailError(PROVIDER_ID, 'Google token response contained no access_token');
    }

    this.cached = {
      token: parsed.access_token,
      expiresAtMs: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    return parsed.access_token;
  }

  /** The signed JWT a service account trades for an access token. */
  private signAssertion(config: ServiceAccountAuth & { scopes?: string[] }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: config.clientEmail,
        // Domain-wide delegation: act as this mailbox.
        sub: config.impersonate,
        scope: (config.scopes ?? GMAIL_SCOPES).join(' '),
        aud: this.endpoint,
        iat: now,
        // Google rejects assertions valid for more than an hour.
        exp: now + 3600,
      }),
    );

    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);

    let signature: string;
    try {
      signature = base64url(signer.sign(normalizePrivateKey(config.privateKey)));
    } catch (err) {
      throw new MailError(
        PROVIDER_ID,
        `Could not sign with the service account key: ${errText(err)}`,
        { cause: err },
      );
    }

    return `${header}.${claims}.${signature}`;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
