import { MailError } from '../../types';

const PROVIDER_ID = 'zoho';

/**
 * Zoho runs one account per data centre and they do not share anything — a
 * token minted in the US is meaningless in the EU, and the API for an EU
 * mailbox lives on a different hostname. Which one you are on is decided by
 * where the account was created, so it has to be told to us.
 */
export const ZOHO_REGIONS = {
  com: { accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com' },
  eu: { accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', mail: 'https://mail.zoho.in' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', mail: 'https://mail.zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', mail: 'https://mail.zoho.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', mail: 'https://mail.zohocloud.ca' },
} as const;

export type ZohoRegion = keyof typeof ZOHO_REGIONS;

export function isZohoRegion(value: string): value is ZohoRegion {
  return value in ZOHO_REGIONS;
}

export interface ZohoAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  region: ZohoRegion;
  /** Overridable so tests can point at a local server. */
  accountsBaseUrl?: string;
}

/**
 * The scopes a refresh token needs. `messages.ALL` covers reading, sending and
 * flagging; `folders.READ` is what turns a folder name into the id every other
 * call wants; `accounts.READ` is how we find the account id so nobody has to
 * copy it out of a URL.
 */
export const ZOHO_SCOPES = [
  'ZohoMail.messages.ALL',
  'ZohoMail.folders.READ',
  'ZohoMail.accounts.READ',
] as const;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

/** Refreshed a minute early, so a token cannot expire mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Access tokens from a long-lived refresh token, cached in memory.
 *
 * Deliberately not written back to disk. Zoho's refresh token does not rotate,
 * so there is nothing durable to save, and a provider that rewrites its own
 * credentials file is a provider that can corrupt it — the old portal this
 * replaces did exactly that and a half-written file locked the desk out.
 */
export class ZohoAuth {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(private readonly config: ZohoAuthConfig) {}

  private get accountsBase(): string {
    return (
      this.config.accountsBaseUrl ?? ZOHO_REGIONS[this.config.region].accounts
    ).replace(/\/+$/, '');
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;

    const params = new URLSearchParams({
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    let response: Response;
    try {
      // Zoho wants these in the query string, not the body.
      response = await fetch(`${this.accountsBase}/oauth/v2/token?${params}`, { method: 'POST' });
    } catch (err) {
      throw new MailError(PROVIDER_ID, `Zoho accounts unreachable: ${text(err)}`, {
        transient: true,
        cause: err,
      });
    }

    const body = (await response.json().catch(() => ({}))) as TokenResponse;

    // Zoho answers 200 with {"error":"invalid_code"} for a dead refresh token,
    // so the status alone does not tell us whether this worked.
    if (!response.ok || !body.access_token) {
      throw new MailError(
        PROVIDER_ID,
        `Zoho refused the refresh token (${response.status}${body.error ? `: ${body.error}` : ''}). ` +
          'A token minted in another data centre fails exactly like this — check ZOHO_REGION.',
        { transient: response.status >= 500 },
      );
    }

    this.token = body.access_token;
    this.expiresAt = Date.now() + Math.max((body.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS, 0);
    return this.token;
  }
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
