import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

import { formatAddress, normalizeMessageId, parseAddressList, parseReferences } from '../../address';
import { buildReferences } from '../../threading';
import {
  MailError,
  type DownloadedAttachment,
  type ListOptions,
  type MailAddress,
  type MailMessage,
  type MailMessageDetail,
  type MailProvider,
  type OutgoingMail,
  type SendResult,
} from '../../types';
import { GoogleAuth, type GoogleAuthConfig } from './auth';

const PROVIDER_ID = 'gmail';
const DEFAULT_API_BASE = 'https://gmail.googleapis.com';

export interface GmailConfig {
  auth: GoogleAuthConfig;
  /** The address replies are sent from. */
  from: MailAddress;
  /** Overridable so tests can point at a local server. */
  apiBaseUrl?: string;
  /** How many message fetches to run at once. */
  concurrency?: number;
}

interface GmailListResponse {
  messages?: { id: string; threadId: string }[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  raw?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

/**
 * Gmail and Google Workspace, via the Gmail REST API.
 *
 * Worth knowing where this differs from IMAP:
 *
 * - Gmail has real threads, so `getThread` is one request rather than a
 *   header-reconstruction over a bounded window. Threads are complete here.
 * - `messages.send` files the copy in Sent itself, so there is no APPEND step
 *   and no risk of a send succeeding while the filing fails.
 * - Message ids are stable and account-wide, so no UIDVALIDITY dance.
 *
 * Message bodies are fetched as `format=raw` and handed to the same mailparser
 * path the IMAP provider uses. Gmail's own MIME-tree JSON would work too, but
 * one parser for both backends means one set of edge cases.
 */
export class GmailProvider implements MailProvider {
  readonly id = PROVIDER_ID;
  readonly label: string;

  private readonly auth: GoogleAuth;
  private readonly config: GmailConfig;

  constructor(config: GmailConfig) {
    this.config = config;
    this.auth = new GoogleAuth(config.auth);
    this.label =
      config.auth.kind === 'service-account'
        ? `Gmail (${config.auth.impersonate})`
        : `Gmail (${config.from.address})`;
  }

  private get apiBase(): string {
    return (this.config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  }

  // --- transport ----------------------------------------------------------

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; retryOn401?: boolean } = {},
  ): Promise<T> {
    const { method = 'GET', body, retryOn401 = true } = init;
    const token = await this.auth.accessToken();
    const url = `${this.apiBase}/gmail/v1/users/me${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new MailError(PROVIDER_ID, `Gmail API unreachable: ${errText(err)}`, {
        transient: true,
        cause: err,
      });
    }

    // A token can be revoked mid-session. Drop the cache and try once more
    // before surfacing this as a failure.
    if (response.status === 401 && retryOn401) {
      this.auth.invalidate();
      return this.request<T>(path, { ...init, retryOn401: false });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new MailError(
        PROVIDER_ID,
        `Gmail ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
        { transient: response.status === 429 || response.status >= 500 },
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // --- reading ------------------------------------------------------------

  private async listLabel(label: string, options: ListOptions): Promise<MailMessage[]> {
    const limit = options.limit ?? 50;
    const params = new URLSearchParams({
      labelIds: label,
      maxResults: String(Math.min(limit, 500)),
    });
    // Gmail's `after:` takes a date, not a timestamp — it is a coarser filter
    // than IMAP's SINCE, so callers may see a little more than they asked for.
    if (options.since) params.set('q', `after:${toGmailDate(options.since)}`);

    const list = await this.request<GmailListResponse>(`/messages?${params}`);
    const ids = (list.messages ?? []).slice(0, limit).map(m => m.id);
    if (ids.length === 0) return [];

    const messages = await this.mapLimit(ids, this.config.concurrency ?? 8, id =>
      this.request<GmailMessage>(
        `/messages/${encodeURIComponent(id)}?format=metadata` +
          '&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To' +
          '&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Message-ID' +
          '&metadataHeaders=In-Reply-To&metadataHeaders=References',
      ),
    );

    return messages
      .map(m => this.toSummary(m))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  }

  async listInbox(options: ListOptions = {}): Promise<MailMessage[]> {
    return this.listLabel('INBOX', options);
  }

  async listSent(options: ListOptions = {}): Promise<MailMessage[]> {
    return this.listLabel('SENT', options);
  }

  private toSummary(message: GmailMessage): MailMessage {
    const headers = new Map(
      (message.payload?.headers ?? []).map(h => [h.name.toLowerCase(), h.value]),
    );
    const from = parseAddressList(headers.get('from'))[0] ?? { address: '' };

    return {
      id: message.id,
      threadId: message.threadId,
      messageIdHeader: normalizeMessageId(headers.get('message-id')),
      inReplyTo: normalizeMessageId(headers.get('in-reply-to')) || undefined,
      references: parseReferences(headers.get('references')),
      subject: headers.get('subject') ?? '',
      from,
      to: parseAddressList(headers.get('to')),
      cc: parseAddressList(headers.get('cc')),
      receivedAt: internalDateToIso(message.internalDate, headers.get('date')),
      isRead: !(message.labelIds ?? []).includes('UNREAD'),
      hasAttachments: false, // Not knowable from metadata; getMessage fills it in.
    };
  }

  private async parseRaw(message: GmailMessage): Promise<MailMessageDetail> {
    if (!message.raw) {
      throw new MailError(PROVIDER_ID, `Gmail returned no body for message ${message.id}`);
    }

    const parsed = await simpleParser(Buffer.from(message.raw, 'base64url'));
    const from = parsed.from?.value?.[0];

    return {
      id: message.id,
      threadId: message.threadId,
      messageIdHeader: normalizeMessageId(parsed.messageId),
      inReplyTo: normalizeMessageId(parsed.inReplyTo) || undefined,
      references: parseReferences(
        Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references,
      ),
      subject: parsed.subject ?? '',
      from: from
        ? { name: from.name || undefined, address: (from.address ?? '').toLowerCase() }
        : { address: '' },
      to: parseAddressList(addressText(parsed.to)),
      cc: parseAddressList(addressText(parsed.cc)),
      receivedAt: internalDateToIso(message.internalDate, parsed.date?.toISOString()),
      isRead: !(message.labelIds ?? []).includes('UNREAD'),
      hasAttachments: parsed.attachments.length > 0,
      html: typeof parsed.html === 'string' ? parsed.html : undefined,
      text: parsed.text ?? undefined,
      attachments: parsed.attachments.map((a, index) => ({
        id: String(index),
        filename: a.filename ?? `attachment-${index}`,
        contentType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? a.content?.length ?? 0,
        inline: a.contentDisposition === 'inline' || Boolean(a.cid),
        contentId: a.cid ? normalizeMessageId(a.cid) : undefined,
      })),
    };
  }

  async getMessage(id: string): Promise<MailMessageDetail> {
    const message = await this.request<GmailMessage>(
      `/messages/${encodeURIComponent(id)}?format=raw`,
    );
    return this.parseRaw(message);
  }

  /** One request — Gmail knows its own threads, so this is complete. */
  async getThread(message: MailMessage): Promise<MailMessageDetail[]> {
    const threadId = message.threadId;
    if (!threadId) return [await this.getMessage(message.id)];

    const thread = await this.request<{ messages?: GmailMessage[] }>(
      `/threads/${encodeURIComponent(threadId)}?format=raw`,
    );

    const details: MailMessageDetail[] = [];
    for (const m of thread.messages ?? []) {
      details.push(await this.parseRaw(m));
    }
    details.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    return details;
  }

  // --- writing ------------------------------------------------------------

  async send(mail: OutgoingMail): Promise<SendResult> {
    if (mail.to.length === 0) {
      throw new MailError(PROVIDER_ID, 'Refusing to send with no recipients');
    }
    if (!mail.html && !mail.text) {
      throw new MailError(PROVIDER_ID, 'Refusing to send an empty body');
    }

    const raw = await buildRawMessage(this.config.from, mail);

    const sent = await this.request<GmailMessage>('/messages/send', {
      method: 'POST',
      body: {
        raw: raw.toString('base64url'),
        // Without this Gmail may file the reply as its own conversation even
        // though the headers thread correctly in other clients.
        ...(mail.threadId ? { threadId: mail.threadId } : {}),
      },
    });

    // Gmail rewrites Message-ID on send, so read it back rather than trusting
    // what we composed — a stale id breaks the threading of the next reply.
    const stored = await this.request<GmailMessage>(
      `/messages/${encodeURIComponent(sent.id)}?format=metadata&metadataHeaders=Message-ID`,
    );
    const header = (stored.payload?.headers ?? []).find(
      h => h.name.toLowerCase() === 'message-id',
    );

    return {
      messageId: normalizeMessageId(header?.value) || sent.id,
      threadId: sent.threadId,
    };
  }

  async markAsRead(id: string): Promise<void> {
    await this.request(`/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST',
      body: { removeLabelIds: ['UNREAD'] },
    });
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
    // Indexes into the parsed message, matching the IMAP provider. Gmail's own
    // attachment ids would work but would make the two backends disagree about
    // what an attachment id is.
    const detail = await this.getMessage(messageId);
    const index = Number(attachmentId);
    const ref = Number.isInteger(index) ? detail.attachments[index] : undefined;
    if (!ref) {
      throw new MailError(PROVIDER_ID, `Attachment ${attachmentId} not in ${messageId}`);
    }

    const message = await this.request<GmailMessage>(
      `/messages/${encodeURIComponent(messageId)}?format=raw`,
    );
    const parsed = await simpleParser(Buffer.from(message.raw ?? '', 'base64url'));
    const attachment = parsed.attachments[index];
    if (!attachment) {
      throw new MailError(PROVIDER_ID, `Attachment ${attachmentId} not in ${messageId}`);
    }

    return {
      filename: attachment.filename ?? `attachment-${attachmentId}`,
      contentType: attachment.contentType ?? 'application/octet-stream',
      content: attachment.content,
    };
  }

  /** Stateless over HTTPS; nothing to release. */
  async close(): Promise<void> {}

  private async mapLimit<In, Out>(
    items: In[],
    limit: number,
    fn: (item: In) => Promise<Out>,
  ): Promise<Out[]> {
    const results = new Array<Out>(items.length);
    let cursor = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]!);
      }
    });

    await Promise.all(workers);
    return results;
  }
}

// --- helpers --------------------------------------------------------------

/** Gmail's `after:` operator wants YYYY/MM/DD. */
function toGmailDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new MailError(PROVIDER_ID, `Invalid \`since\` value: ${JSON.stringify(iso)}`);
  }
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}/${month}/${day}`;
}

/**
 * internalDate is when Gmail received it, in ms. Prefer it over the Date
 * header, which is set by the sender and is wrong more often than you would
 * hope — clock skew, forged dates, misconfigured clients.
 */
function internalDateToIso(internalDate: string | undefined, fallback?: string): string {
  if (internalDate) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  if (fallback) {
    const parsed = new Date(fallback);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function addressText(field: { text?: string } | { text?: string }[] | undefined): string {
  if (!field) return '';
  if (Array.isArray(field)) return field.map(f => f.text ?? '').filter(Boolean).join(', ');
  return field.text ?? '';
}

async function buildRawMessage(from: MailAddress, mail: OutgoingMail): Promise<Buffer> {
  const references = buildReferences(mail.inReplyTo, mail.references ?? []);
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });

  const result = await composer.sendMail({
    from: formatAddress(from),
    to: mail.to.map(formatAddress),
    cc: mail.cc?.map(formatAddress),
    bcc: mail.bcc?.map(formatAddress),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    inReplyTo: mail.inReplyTo ? `<${normalizeMessageId(mail.inReplyTo)}>` : undefined,
    references: references.map(id => `<${id}>`),
    attachments: mail.attachments?.map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      cid: a.contentId,
    })),
  });

  return result.message as Buffer;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
