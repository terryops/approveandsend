/**
 * The mail abstraction.
 *
 * Two shapes of backend have to fit through here and they disagree on one
 * important thing: hosted APIs (Gmail, Zoho, Outlook) hand you a server-side
 * `threadId`, IMAP does not. So `threadId` is optional and every message also
 * carries its RFC 5322 `messageIdHeader` / `inReplyTo` / `references`, which
 * is what `threading.ts` uses to reconstruct conversations when the server
 * won't. Providers that *do* have real threads should still populate the
 * headers — they cost nothing and make the two paths behave the same.
 */

export interface MailAddress {
  /** Display name, when the server gave us one. */
  name?: string;
  /** Bare address, lowercased. Always present. */
  address: string;
}

export interface MailAttachmentRef {
  /** Opaque, provider-scoped. Pass back to downloadAttachment(). */
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** True for images referenced by a cid: URL in the HTML body. */
  inline: boolean;
  contentId?: string;
}

export interface MailMessage {
  /** Opaque, provider-scoped, stable. For IMAP this encodes the mailbox. */
  id: string;
  /** Server-side thread id, when the backend has such a concept. */
  threadId?: string;
  /** RFC 5322 Message-ID, angle brackets stripped. */
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string[];
  mailbox?: string;

  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  /** ISO 8601. */
  receivedAt: string;

  /** Short preview, when the backend provides one cheaply. */
  snippet?: string;
  isRead: boolean;
  hasAttachments: boolean;
}

export interface MailMessageDetail extends MailMessage {
  html?: string;
  text?: string;
  attachments: MailAttachmentRef[];
}

export interface OutgoingAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Set to embed as a cid: reference rather than attach. */
  contentId?: string;
}

export interface OutgoingMail {
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  html?: string;
  text?: string;
  /** Message-ID being replied to; sets In-Reply-To and extends References. */
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
  /**
   * Server-side thread to file the reply under. Ignored by backends without
   * threads — those rely on In-Reply-To/References alone, which Gmail honours
   * for other clients but not reliably for its own conversation grouping.
   */
  threadId?: string;
}

export interface SendResult {
  /** Message-ID of what we sent, so the reply can be threaded later. */
  messageId: string;
  /** Present when the backend has server-side threads. */
  threadId?: string;
}

export interface ListOptions {
  limit?: number;
  /** Only messages received at or after this ISO timestamp. */
  since?: string;
}

export interface DownloadedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailProvider {
  readonly id: string;
  readonly label: string;

  /** Messages awaiting a reply. */
  listInbox(options?: ListOptions): Promise<MailMessage[]>;
  /** What we have already sent — used to tell "needs a reply" from "handled". */
  listSent(options?: ListOptions): Promise<MailMessage[]>;

  getMessage(id: string): Promise<MailMessageDetail>;

  /**
   * Every message in the conversation containing `message`, oldest first,
   * including `message` itself.
   */
  getThread(message: MailMessage): Promise<MailMessageDetail[]>;

  send(mail: OutgoingMail): Promise<SendResult>;

  markAsRead(id: string): Promise<void>;

  downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment>;

  /** Release connections. Safe to call more than once. */
  close(): Promise<void>;
}

export class MailError extends Error {
  readonly providerId: string;
  /** Worth retrying: timeouts, dropped connections, 4xx rate limits, 5xx. */
  readonly transient: boolean;
  override readonly cause?: unknown;

  constructor(
    providerId: string,
    message: string,
    options: { transient?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'MailError';
    this.providerId = providerId;
    this.transient = options.transient ?? false;
    this.cause = options.cause;
  }
}
