import { htmlToText } from '../../../thread-context';
import { normalizeMessageId, parseAddressList, parseReferences } from '../../address';
import { findThreadFor } from '../../threading';
import {
  MailError,
  type DownloadedAttachment,
  type ListOptions,
  type MailAddress,
  type MailAttachmentRef,
  type MailMessage,
  type MailMessageDetail,
  type MailProvider,
  type OutgoingMail,
  type SendResult,
} from '../../types';
import { ZOHO_REGIONS, ZohoAuth, type ZohoAuthConfig } from './auth';

const PROVIDER_ID = 'zoho';

export interface ZohoConfig {
  auth: ZohoAuthConfig;
  /** The address replies are sent from. Must be an address this account owns. */
  from: MailAddress;
  /**
   * Zoho's numeric account id. Discovered from /accounts when absent, which is
   * one fewer thing to copy out of a URL during setup.
   */
  accountId?: string;
  /** Overridable so tests can point at a local server. */
  apiBaseUrl?: string;
  /** Folder display names, if this mailbox has been renamed or localised. */
  inboxFolder?: string;
  sentFolder?: string;
}

interface ZohoEnvelope<T> {
  data?: T;
  status?: { code?: number; description?: string };
}

interface ZohoFolder {
  folderId: string;
  folderName: string;
  folderType?: string;
}

interface ZohoAccount {
  accountId: string;
  primaryEmailAddress?: string;
}

/** What /messages/view and /details return. Everything is a string. */
interface ZohoSummary {
  messageId: string;
  folderId?: string;
  threadId?: string | null;
  subject?: string;
  sender?: string;
  fromAddress?: string;
  toAddress?: string;
  ccAddress?: string;
  /** Milliseconds since the epoch, as a string. */
  receivedTime?: string;
  summary?: string;
  hasAttachment?: string;
  /** "1" means unread. Verified against ?status=read/unread, not guessed. */
  status2?: string;
}

interface ZohoAttachmentInfo {
  attachmentId: string;
  attachmentName?: string;
  attachmentSize?: string;
  contentType?: string;
}

/**
 * Zoho Mail, via its REST API.
 *
 * Zoho also speaks IMAP, but only after an admin turns it on and issues an
 * app-specific password — two settings changes that both fail as "Invalid
 * credentials", which is a miserable thing to debug. The API needs neither, so
 * it is the better default for this mailbox even though it is more code.
 *
 * Three things about this API are worth knowing before changing anything here:
 *
 * - **Message ids are folder-scoped.** Every read endpoint is
 *   /folders/{folderId}/messages/{messageId}, and the same message moved to
 *   another folder is addressed differently. So the id we hand out is
 *   `folderId:messageId`, the way the IMAP provider encodes its mailbox — a
 *   stale id then fails loudly instead of reading the wrong message.
 * - **Thread *search* is broken.** `/messages/search?searchKey=threadId:X`
 *   happily returns messages from other threads (measured: 10 results, 6 of
 *   them other conversations). Every message does carry a trustworthy
 *   `threadId` field, so threads are assembled by filtering on that field
 *   instead — never by asking the search endpoint.
 * - **Zoho composes replies itself.** There is no "send this MIME" endpoint,
 *   so In-Reply-To cannot be set by us; the reply action takes the original
 *   message's Zoho id and threads it server-side. That is what
 *   `inReplyToProviderId` on OutgoingMail is for.
 */
export class ZohoProvider implements MailProvider {
  readonly id = PROVIDER_ID;
  readonly label: string;

  private readonly auth: ZohoAuth;
  private accountId: string | null;
  private folders: Map<string, ZohoFolder> | null = null;

  constructor(private readonly config: ZohoConfig) {
    this.auth = new ZohoAuth(config.auth);
    this.accountId = config.accountId ?? null;
    this.label = `Zoho (${config.from.address})`;
  }

  private get apiBase(): string {
    return (this.config.apiBaseUrl ?? ZOHO_REGIONS[this.config.auth.region].mail).replace(
      /\/+$/,
      '',
    );
  }

  // --- transport ----------------------------------------------------------

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; retryOn401?: boolean } = {},
  ): Promise<T> {
    const { method = 'GET', body, retryOn401 = true } = init;
    const token = await this.auth.accessToken();
    const url = `${this.apiBase}/api${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new MailError(PROVIDER_ID, `Zoho Mail unreachable: ${errText(err)}`, {
        transient: true,
        cause: err,
      });
    }

    // Zoho answers an expired token with 500 on some endpoints and 401 on
    // others, so both get one retry with a fresh one rather than surfacing as
    // an outage the caller has to interpret.
    if ((response.status === 401 || response.status === 500) && retryOn401) {
      this.auth.invalidate();
      return this.request<T>(path, { ...init, retryOn401: false });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new MailError(
        PROVIDER_ID,
        `Zoho ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
        { transient: response.status === 429 || response.status >= 500 },
      );
    }

    const envelope = (await response.json().catch(() => ({}))) as ZohoEnvelope<T>;
    return envelope.data as T;
  }

  /** Everything below /api/accounts/{id}, which is everything except /accounts. */
  private async account<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    return this.request<T>(`/accounts/${await this.resolveAccountId()}${path}`, init);
  }

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;

    const accounts = await this.request<ZohoAccount[]>('/accounts');
    const wanted = this.config.from.address.toLowerCase();
    const match =
      accounts?.find(a => a.primaryEmailAddress?.toLowerCase() === wanted) ?? accounts?.[0];

    if (!match?.accountId) {
      throw new MailError(
        PROVIDER_ID,
        `No Zoho account found for ${this.config.from.address}. Set ZOHO_ACCOUNT_ID explicitly.`,
      );
    }

    this.accountId = match.accountId;
    return this.accountId;
  }

  /**
   * Folder ids by lowercased name. Cached for the life of the provider: a
   * folder id is stable, and looking it up before every list would double the
   * request count on the hottest path in the app.
   */
  private async folderId(name: string): Promise<string> {
    if (!this.folders) {
      const list = await this.account<ZohoFolder[]>('/folders');
      this.folders = new Map((list ?? []).map(f => [f.folderName.toLowerCase(), f]));
    }

    const folder = this.folders.get(name.toLowerCase());
    if (!folder) {
      const known = [...this.folders.keys()].join(', ');
      throw new MailError(
        PROVIDER_ID,
        `No Zoho folder named ${JSON.stringify(name)}. This mailbox has: ${known}`,
      );
    }
    return folder.folderId;
  }

  // --- ids ----------------------------------------------------------------

  /**
   * Folder and message, together. The folder is not decoration — every read
   * endpoint needs it, and a bare message id cannot be used at all.
   */
  private static encodeId(folderId: string, messageId: string): string {
    return `${folderId}:${messageId}`;
  }

  private static decodeId(id: string): { folderId: string; messageId: string } {
    const at = id.indexOf(':');
    if (at <= 0 || at === id.length - 1) {
      throw new MailError(PROVIDER_ID, `Not a Zoho message id: ${JSON.stringify(id)}`);
    }
    return { folderId: id.slice(0, at), messageId: id.slice(at + 1) };
  }

  // --- reading ------------------------------------------------------------

  private async listFolder(name: string, options: ListOptions): Promise<MailMessage[]> {
    const folderId = await this.folderId(name);
    const limit = Math.min(options.limit ?? 50, 200);
    const params = new URLSearchParams({ folderId, limit: String(limit) });

    const rows = await this.account<ZohoSummary[]>(`/messages/view?${params}`);
    const since = options.since ? new Date(options.since).getTime() : null;

    return (rows ?? [])
      .map(row => this.toSummary(row, folderId))
      .filter(m => (since === null ? true : new Date(m.receivedAt).getTime() >= since))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  }

  async listInbox(options: ListOptions = {}): Promise<MailMessage[]> {
    return this.listFolder(this.config.inboxFolder ?? 'Inbox', options);
  }

  async listSent(options: ListOptions = {}): Promise<MailMessage[]> {
    return this.listFolder(this.config.sentFolder ?? 'Sent', options);
  }

  private toSummary(row: ZohoSummary, fallbackFolder: string): MailMessage {
    const folderId = row.folderId ?? fallbackFolder;
    // Zoho splits the From into a display name and an address, and fills the
    // name with the address when the sender had none — which would otherwise
    // render as "ethan@example.com <ethan@example.com>" all over the UI.
    const address = (row.fromAddress ?? '').toLowerCase();
    const name = row.sender && row.sender.toLowerCase() !== address ? row.sender : undefined;
    const from = parseAddressList(name ? `${name} <${address}>` : address)[0] ?? { address };

    return {
      id: ZohoProvider.encodeId(folderId, row.messageId),
      // Some rows genuinely have no thread — a single message nobody replied
      // to. Undefined rather than null so threading falls back to headers.
      ...(row.threadId ? { threadId: row.threadId } : {}),
      mailbox: folderId,
      subject: row.subject ?? '',
      from,
      to: parseAddressList(row.toAddress),
      cc: parseAddressList(row.ccAddress),
      receivedAt: epochToIso(row.receivedTime),
      ...(row.summary ? { snippet: row.summary } : {}),
      // "1" is unread. Confirmed by cross-checking ?status=read against the
      // field, because Zoho documents neither the name nor the polarity.
      isRead: row.status2 !== '1',
      hasAttachments: row.hasAttachment === '1',
    };
  }

  async getMessage(id: string): Promise<MailMessageDetail> {
    const { folderId, messageId } = ZohoProvider.decodeId(id);
    const base = `/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}`;

    // Three calls because Zoho splits one message across three endpoints:
    // /details is the envelope, /content is the body, /header is the only
    // place the RFC 5322 Message-ID appears — and without that, the reply we
    // eventually send cannot be threaded by the customer's mail client.
    const [details, content, header, attachments] = await Promise.all([
      this.account<ZohoSummary>(`${base}/details`),
      this.account<{ content?: string }>(`${base}/content`),
      // Optional: a message whose headers cannot be read is still worth
      // showing, it just cannot be threaded by header.
      this.account<{ headerContent?: string }>(`${base}/header`).catch(
        () => ({}) as { headerContent?: string },
      ),
      this.attachmentRefs(base).catch(() => [] as MailAttachmentRef[]),
    ]);

    const summary = this.toSummary({ ...details, messageId, folderId }, folderId);
    const headers = parseHeaders(header?.headerContent ?? '');
    const html = content?.content ?? '';

    return {
      ...summary,
      ...(normalizeMessageId(headers.get('message-id'))
        ? { messageIdHeader: normalizeMessageId(headers.get('message-id')) }
        : {}),
      ...(normalizeMessageId(headers.get('in-reply-to'))
        ? { inReplyTo: normalizeMessageId(headers.get('in-reply-to')) }
        : {}),
      references: parseReferences(headers.get('references')),
      html,
      text: htmlToText(html),
      hasAttachments: attachments.length > 0 || summary.hasAttachments,
      attachments,
    };
  }

  /**
   * Zoho's own threadId, filtered client-side.
   *
   * Not `/messages/search?searchKey=threadId:X` — that endpoint returns other
   * people's conversations alongside the one asked for, which in this app
   * would put one customer's mail into another customer's prompt.
   */
  async getThread(message: MailMessage): Promise<MailMessageDetail[]> {
    const [inbox, sent] = await Promise.all([
      this.listInbox({ limit: 200 }),
      this.listSent({ limit: 200 }),
    ]);

    const pool = [...inbox, ...sent];
    if (!pool.some(m => m.id === message.id)) pool.push(message);

    const members = message.threadId
      ? pool.filter(m => m.threadId === message.threadId)
      : // No thread id: fall back to the header/subject reconstruction the
        // IMAP provider uses, which is the best available answer.
        findThreadFor(message, pool);

    const ordered = (members.length > 0 ? members : [message]).sort(
      (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
    );

    const details: MailMessageDetail[] = [];
    for (const m of ordered) details.push(await this.getMessage(m.id));
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
    if (mail.attachments?.length) {
      // Sending one means uploading it to Zoho's store first and passing the
      // handles back. Not implemented, and failing loudly beats sending the
      // reply with the attachment silently missing.
      throw new MailError(PROVIDER_ID, 'The Zoho provider cannot send attachments yet');
    }

    const html = mail.html ?? textToHtml(mail.text ?? '');
    const payload = {
      fromAddress: this.config.from.address,
      toAddress: mail.to.map(a => a.address).join(','),
      ...(mail.cc?.length ? { ccAddress: mail.cc.map(a => a.address).join(',') } : {}),
      ...(mail.bcc?.length ? { bccAddress: mail.bcc.map(a => a.address).join(',') } : {}),
      subject: mail.subject,
      content: html,
      mailFormat: 'html',
    };

    // Replying by id lets Zoho set In-Reply-To and References itself, which is
    // the only way this thread survives in the customer's mail client — the
    // send endpoint takes no headers from us.
    const path = mail.inReplyToProviderId
      ? `/messages/${encodeURIComponent(ZohoProvider.decodeId(mail.inReplyToProviderId).messageId)}`
      : '/messages';
    const body = mail.inReplyToProviderId ? { ...payload, action: 'reply' } : payload;

    const sent = await this.account<{ messageId?: string; threadId?: string }>(path, {
      method: 'POST',
      body,
    });

    return {
      // Zoho's id, not an RFC 5322 Message-ID — it does not tell us the header
      // it generated. Good enough: this is only used to recognise our own
      // reply later, and both ends of that comparison come from Zoho.
      messageId: sent?.messageId ?? '',
      ...(sent?.threadId ? { threadId: sent.threadId } : {}),
    };
  }

  async markAsRead(id: string): Promise<void> {
    const { messageId } = ZohoProvider.decodeId(id);
    // The batch endpoint, because the per-message one 404s. Learned the hard
    // way in the portal this replaces.
    await this.account('/updatemessage', {
      method: 'PUT',
      body: { mode: 'markAsRead', messageId: [messageId] },
    });
  }

  private async attachmentRefs(base: string): Promise<MailAttachmentRef[]> {
    const info = await this.account<{ attachments?: ZohoAttachmentInfo[] }>(
      `${base}/attachmentinfo`,
    );

    return (info?.attachments ?? []).map(a => ({
      id: a.attachmentId,
      filename: a.attachmentName ?? a.attachmentId,
      contentType: a.contentType ?? 'application/octet-stream',
      size: Number(a.attachmentSize ?? 0) || 0,
      // Zoho's attachmentinfo does not distinguish inline images from real
      // attachments, so nothing is claimed to be inline rather than guessing.
      inline: false,
    }));
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
    const { folderId, messageId: mid } = ZohoProvider.decodeId(messageId);
    const path =
      `/accounts/${await this.resolveAccountId()}` +
      `/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(mid)}` +
      `/attachments/${encodeURIComponent(attachmentId)}`;

    // Raw bytes, so this cannot go through request() — that unwraps a JSON
    // envelope that is not there.
    const token = await this.auth.accessToken();
    const response = await fetch(`${this.apiBase}/api${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });

    if (!response.ok) {
      throw new MailError(
        PROVIDER_ID,
        `Zoho attachment ${attachmentId} of ${messageId} failed (${response.status})`,
        { transient: response.status === 429 || response.status >= 500 },
      );
    }

    const refs = await this.attachmentRefs(
      `/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(mid)}`,
    ).catch(() => [] as MailAttachmentRef[]);
    const ref = refs.find(r => r.id === attachmentId);

    return {
      filename: ref?.filename ?? attachmentId,
      contentType: response.headers.get('content-type') ?? ref?.contentType ?? 'application/octet-stream',
      content: Buffer.from(await response.arrayBuffer()),
    };
  }

  /** Stateless over HTTPS; nothing to release. */
  async close(): Promise<void> {}
}

// --- helpers --------------------------------------------------------------

function epochToIso(ms: string | undefined): string {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : new Date(0).toISOString();
}

/**
 * The headers we care about, out of a raw header block. Unfolds continuation
 * lines first — References in a long thread is always folded across several,
 * and reading only the first line would silently truncate the thread.
 */
function parseHeaders(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');

  for (const line of unfolded.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    // First wins: a Message-ID added by a relay comes after the original.
    if (!out.has(name)) out.set(name, line.slice(at + 1).trim());
  }
  return out;
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\r?\n/g, '<br>');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
