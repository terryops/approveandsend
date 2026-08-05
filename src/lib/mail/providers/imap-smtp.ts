import { ImapFlow, type FetchMessageObject, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer, { type Transporter } from 'nodemailer';

import { formatAddress, normalizeMessageId, parseAddressList, parseReferences } from '../address';
import { buildReferences, findThreadFor } from '../threading';
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
} from '../types';

const PROVIDER_ID = 'imap-smtp';

export interface ImapSmtpConfig {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    /** Mailbox holding incoming mail. */
    inbox?: string;
    /**
     * Mailbox holding sent mail. Servers disagree wildly on the name
     * ("Sent", "Sent Items", "[Gmail]/Sent Mail"), so when this is unset we
     * ask the server which mailbox has the \Sent special-use flag.
     */
    sentMailbox?: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  /** The address replies are sent from. */
  from: MailAddress;
}

/**
 * IMAP + SMTP, i.e. the backend that works everywhere.
 *
 * Two things make this more than a thin wrapper:
 *
 * 1. IDs. IMAP UIDs are only unique within a mailbox and are invalidated when
 *    UIDVALIDITY changes. Our ids are `mailbox:uidvalidity:uid`, so a stale id
 *    fails loudly instead of silently fetching the wrong message.
 * 2. Threads. IMAP has no thread id. We fetch the candidate set and rebuild
 *    conversations from References/In-Reply-To — see threading.ts.
 */
export class ImapSmtpProvider implements MailProvider {
  readonly id = PROVIDER_ID;
  readonly label: string;

  private readonly config: ImapSmtpConfig;
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private transporter: Transporter | null = null;
  private sentMailboxCache: string | null = null;

  constructor(config: ImapSmtpConfig) {
    this.config = config;
    this.label = `IMAP (${config.imap.host})`;
  }

  // --- connection ---------------------------------------------------------

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    // Concurrent callers must share one handshake; IMAP servers cap connections.
    if (this.connecting) return this.connecting;

    const options: ImapFlowOptions = {
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: { user: this.config.imap.user, pass: this.config.imap.pass },
      logger: false,
    };

    this.connecting = (async () => {
      const client = new ImapFlow(options);
      // Without this an idle-timeout disconnect becomes an unhandled 'error'
      // event and takes the whole process down.
      client.on('error', err => {
        console.error('[mail] IMAP connection error:', (err as Error).message);
      });
      try {
        await client.connect();
        this.client = client;
        return client;
      } catch (err) {
        throw new MailError(PROVIDER_ID, `IMAP connect failed: ${errText(err)}`, {
          transient: isTransient(err),
          cause: err,
        });
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  private inboxName(): string {
    return this.config.imap.inbox ?? 'INBOX';
  }

  private async sentMailboxName(): Promise<string> {
    if (this.config.imap.sentMailbox) return this.config.imap.sentMailbox;
    if (this.sentMailboxCache) return this.sentMailboxCache;

    const client = await this.connect();
    for (const box of await client.list()) {
      // \Sent is the standard special-use flag (RFC 6154). Trust it over
      // guessing at localized mailbox names.
      if (box.specialUse === '\\Sent') {
        this.sentMailboxCache = box.path;
        return box.path;
      }
    }
    this.sentMailboxCache = 'Sent';
    return 'Sent';
  }

  // --- reading ------------------------------------------------------------

  private async list(mailbox: string, options: ListOptions): Promise<MailMessage[]> {
    const limit = options.limit ?? 50;
    const client = await this.connect();
    const lock = await client.getMailboxLock(mailbox);

    try {
      const status = client.mailbox;
      if (!status || typeof status === 'boolean') {
        throw new MailError(PROVIDER_ID, `Mailbox ${mailbox} is not open`);
      }
      if (status.exists === 0) return [];

      const uids = options.since
        ? await client.search({ since: new Date(options.since) }, { uid: true })
        : null;

      // Newest first, then trim: fetching the whole mailbox to throw most of
      // it away is the difference between a snappy sync and a minute of waiting.
      const range = uids
        ? uids.slice(-limit).join(',')
        : `${Math.max(1, status.exists - limit + 1)}:*`;
      if (uids && uids.length === 0) return [];

      const out: MailMessage[] = [];
      for await (const message of client.fetch(
        range,
        { uid: true, flags: true, envelope: true, bodyStructure: true, size: true },
        { uid: Boolean(uids) },
      )) {
        out.push(this.toSummary(message, mailbox, status.uidValidity));
      }

      out.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
      return out.slice(0, limit);
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError(PROVIDER_ID, `Listing ${mailbox} failed: ${errText(err)}`, {
        transient: isTransient(err),
        cause: err,
      });
    } finally {
      lock.release();
    }
  }

  async listInbox(options: ListOptions = {}): Promise<MailMessage[]> {
    return this.list(this.inboxName(), options);
  }

  async listSent(options: ListOptions = {}): Promise<MailMessage[]> {
    return this.list(await this.sentMailboxName(), options);
  }

  private toSummary(
    message: FetchMessageObject,
    mailbox: string,
    uidValidity: bigint | number,
  ): MailMessage {
    const env = message.envelope;
    const from = env?.from?.[0];
    const attachments = collectAttachmentNodes(message.bodyStructure);

    return {
      id: encodeId(mailbox, uidValidity, message.uid),
      mailbox,
      messageIdHeader: normalizeMessageId(env?.messageId),
      inReplyTo: normalizeMessageId(env?.inReplyTo) || undefined,
      subject: env?.subject ?? '',
      from: from
        ? { name: from.name || undefined, address: (from.address ?? '').toLowerCase() }
        : { address: '' },
      to: (env?.to ?? []).map(a => ({
        name: a.name || undefined,
        address: (a.address ?? '').toLowerCase(),
      })),
      cc: (env?.cc ?? []).map(a => ({
        name: a.name || undefined,
        address: (a.address ?? '').toLowerCase(),
      })),
      receivedAt: (env?.date ?? new Date(0)).toISOString(),
      isRead: message.flags?.has('\\Seen') ?? false,
      hasAttachments: attachments.some(a => a.disposition === 'attachment'),
    };
  }

  async getMessage(id: string): Promise<MailMessageDetail> {
    const { mailbox, uidValidity, uid } = decodeId(id);
    const client = await this.connect();
    const lock = await client.getMailboxLock(mailbox);

    try {
      assertUidValidity(client, mailbox, uidValidity);

      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || !message.source) {
        throw new MailError(PROVIDER_ID, `Message ${id} not found`);
      }

      const parsed = await simpleParser(message.source);
      const from = parsed.from?.value?.[0];

      return {
        id,
        mailbox,
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
        receivedAt: (parsed.date ?? new Date(0)).toISOString(),
        isRead: true,
        hasAttachments: parsed.attachments.length > 0,
        html: typeof parsed.html === 'string' ? parsed.html : undefined,
        text: parsed.text ?? undefined,
        attachments: parsed.attachments.map((a, index) => ({
          // mailparser gives no stable id, so the index into the parsed list
          // is the id. Deterministic for a given message, which is enough.
          id: String(index),
          filename: a.filename ?? `attachment-${index}`,
          contentType: a.contentType ?? 'application/octet-stream',
          size: a.size ?? a.content?.length ?? 0,
          inline: a.contentDisposition === 'inline' || Boolean(a.cid),
          contentId: a.cid ? normalizeMessageId(a.cid) : undefined,
        })),
      };
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError(PROVIDER_ID, `Fetching ${id} failed: ${errText(err)}`, {
        transient: isTransient(err),
        cause: err,
      });
    } finally {
      lock.release();
    }
  }

  /**
   * IMAP has no threads, so: gather recent inbox + sent mail, rebuild the
   * conversation from headers, then fetch bodies for that conversation only.
   * The candidate window is bounded — a thread whose root is older than the
   * window will be partial rather than wrong.
   */
  async getThread(message: MailMessage): Promise<MailMessageDetail[]> {
    const [inbox, sent] = await Promise.all([
      this.listInbox({ limit: 200 }),
      this.listSent({ limit: 200 }),
    ]);

    const pool = [...inbox, ...sent];
    if (!pool.some(m => m.id === message.id)) pool.push(message);

    const thread = findThreadFor(message, pool);
    const members = thread.length > 0 ? thread : [message];

    // Sequential on purpose: one IMAP connection, and parallel fetches on it
    // deadlock behind the mailbox lock.
    const details: MailMessageDetail[] = [];
    for (const m of members) {
      details.push(await this.getMessage(m.id));
    }
    return details;
  }

  // --- writing ------------------------------------------------------------

  private smtp(): Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: { user: this.config.smtp.user, pass: this.config.smtp.pass },
    });
    return this.transporter;
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    if (mail.to.length === 0) {
      throw new MailError(PROVIDER_ID, 'Refusing to send with no recipients');
    }
    if (!mail.html && !mail.text) {
      throw new MailError(PROVIDER_ID, 'Refusing to send an empty body');
    }

    const references = buildReferences(mail.inReplyTo, mail.references ?? []);

    try {
      const info = await this.smtp().sendMail({
        from: formatAddress(this.config.from),
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

      const messageId = normalizeMessageId(info.messageId);
      await this.appendToSent(mail, info);
      return { messageId };
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError(PROVIDER_ID, `Send failed: ${errText(err)}`, {
        transient: isTransient(err),
        cause: err,
      });
    }
  }

  /**
   * SMTP does not put a copy in Sent — that is the client's job. Skipping it
   * would mean our own replies never appear in threads, so the model would
   * keep re-answering questions we already answered.
   *
   * A failure here is logged, not thrown: the mail is already delivered and
   * failing the call would invite a duplicate send.
   */
  private async appendToSent(mail: OutgoingMail, info: { messageId?: string }): Promise<void> {
    try {
      const raw = await buildRawMessage(this.config.from, mail, info.messageId);
      const client = await this.connect();
      await client.append(await this.sentMailboxName(), raw, ['\\Seen']);
    } catch (err) {
      console.error('[mail] could not append to Sent (message was sent):', errText(err));
    }
  }

  async markAsRead(id: string): Promise<void> {
    const { mailbox, uidValidity, uid } = decodeId(id);
    const client = await this.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      assertUidValidity(client, mailbox, uidValidity);
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError(PROVIDER_ID, `Marking ${id} read failed: ${errText(err)}`, {
        transient: isTransient(err),
        cause: err,
      });
    } finally {
      lock.release();
    }
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
    const { mailbox, uidValidity, uid } = decodeId(messageId);
    const client = await this.connect();
    const lock = await client.getMailboxLock(mailbox);

    try {
      assertUidValidity(client, mailbox, uidValidity);
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || !message.source) {
        throw new MailError(PROVIDER_ID, `Message ${messageId} not found`);
      }

      const parsed = await simpleParser(message.source);
      const index = Number(attachmentId);
      const attachment = Number.isInteger(index) ? parsed.attachments[index] : undefined;
      if (!attachment) {
        throw new MailError(PROVIDER_ID, `Attachment ${attachmentId} not in ${messageId}`);
      }

      return {
        filename: attachment.filename ?? `attachment-${attachmentId}`,
        contentType: attachment.contentType ?? 'application/octet-stream',
        content: attachment.content,
      };
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError(PROVIDER_ID, `Downloading attachment failed: ${errText(err)}`, {
        transient: isTransient(err),
        cause: err,
      });
    } finally {
      lock.release();
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client?.usable) {
      await client.logout().catch(() => client.close());
    }
    this.transporter?.close();
    this.transporter = null;
  }
}

// --- ids ------------------------------------------------------------------

/**
 * `mailbox:uidvalidity:uid`. UIDVALIDITY is in there because a server may
 * renumber a mailbox at any time; without it a stored id would silently start
 * pointing at a different message.
 */
export function encodeId(mailbox: string, uidValidity: bigint | number, uid: number): string {
  return `${encodeURIComponent(mailbox)}:${uidValidity}:${uid}`;
}

export function decodeId(id: string): { mailbox: string; uidValidity: string; uid: number } {
  const parts = id.split(':');
  if (parts.length !== 3) {
    throw new MailError(PROVIDER_ID, `Malformed message id: ${JSON.stringify(id)}`);
  }
  const [mailbox, uidValidity, uid] = parts as [string, string, string];
  const parsedUid = Number(uid);
  if (!Number.isInteger(parsedUid) || parsedUid <= 0) {
    throw new MailError(PROVIDER_ID, `Malformed uid in id: ${JSON.stringify(id)}`);
  }
  return { mailbox: decodeURIComponent(mailbox), uidValidity, uid: parsedUid };
}

function assertUidValidity(client: ImapFlow, mailbox: string, expected: string): void {
  const status = client.mailbox;
  if (!status || typeof status === 'boolean') return;
  if (String(status.uidValidity) !== expected) {
    throw new MailError(
      PROVIDER_ID,
      `${mailbox} was renumbered (UIDVALIDITY ${expected} → ${status.uidValidity}); re-sync required`,
    );
  }
}

// --- helpers --------------------------------------------------------------

interface BodyNode {
  disposition?: string | false | null;
  childNodes?: BodyNode[];
}

function collectAttachmentNodes(node: BodyNode | undefined): { disposition: string }[] {
  if (!node) return [];
  const out: { disposition: string }[] = [];
  if (typeof node.disposition === 'string') out.push({ disposition: node.disposition });
  for (const child of node.childNodes ?? []) out.push(...collectAttachmentNodes(child));
  return out;
}

/** Render the message we just sent, so it can be appended to Sent verbatim. */
async function buildRawMessage(
  from: MailAddress,
  mail: OutgoingMail,
  messageId: string | undefined,
): Promise<Buffer> {
  const references = buildReferences(mail.inReplyTo, mail.references ?? []);
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });

  const result = await composer.sendMail({
    from: formatAddress(from),
    to: mail.to.map(formatAddress),
    cc: mail.cc?.map(formatAddress),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    messageId,
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

/** mailparser hands back one AddressObject, or several, or nothing. */
function addressText(field: { text?: string } | { text?: string }[] | undefined): string {
  if (!field) return '';
  if (Array.isArray(field)) return field.map(f => f.text ?? '').filter(Boolean).join(', ');
  return field.text ?? '';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNECTION',
]);

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  // 4xx SMTP replies are "try again later"; 5xx are permanent rejections.
  const responseCode = (err as { responseCode?: number } | null)?.responseCode;
  if (typeof responseCode === 'number') return responseCode >= 400 && responseCode < 500;
  return false;
}
