import type { OutgoingAttachment } from './types';

/**
 * Files a reviewer picked, on their way out through the reply.
 *
 * They are read from the request and handed to the provider, and that is the
 * whole of their life here. Nothing is written to disk and no row is added:
 * the copy that matters is the one in the Sent folder, which is the same place
 * every other record of what went out already lives. A blob store would be a
 * second copy of customer data to secure, back up and delete from, bought for
 * the ability to re-download something the mailbox is already holding.
 *
 * What is recorded is the filenames, on the `sent` event — because "why does
 * this customer have our invoice PDF" is a question about the desk's history,
 * and a history that says only "sent" cannot answer it.
 */

/**
 * Per request, not per file.
 *
 * Mail is the constraint, not us: most mailboxes bounce anything over about
 * 25 MB, and base64 inflates by a third on the way, so a message that leaves
 * here at 20 MB arrives at the gateway as 27 and is refused after the reviewer
 * has been told it went. Failing early, on our side, with a sentence naming
 * the size is the kinder end of that.
 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export class UploadTooLarge extends Error {
  constructor(bytes: number) {
    super(
      `Those files come to ${Math.round(bytes / 1024 / 1024)} MB, over the ${Math.round(
        MAX_UPLOAD_BYTES / 1024 / 1024,
      )} MB a reply can carry. Send a link instead.`,
    );
    this.name = 'UploadTooLarge';
  }
}

/**
 * The files posted under `name`, as attachments.
 *
 * An untouched file input still posts — as a zero-byte `File` with an empty
 * name — so emptiness is checked rather than assumed. Without that, every
 * reply from a form that has the input would carry one nameless empty
 * attachment, which most clients render as a broken paperclip.
 */
export async function readUploads(
  form: FormData,
  name = 'files',
): Promise<OutgoingAttachment[]> {
  const files = form.getAll(name).filter((value): value is File => value instanceof File);

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_UPLOAD_BYTES) throw new UploadTooLarge(total);

  const attachments: OutgoingAttachment[] = [];
  for (const file of files) {
    if (file.size === 0 || !file.name) continue;
    attachments.push({
      filename: file.name,
      content: Buffer.from(await file.arrayBuffer()),
      ...(file.type ? { contentType: file.type } : {}),
    });
  }

  return attachments;
}

/** For the audit line. Names only — the bytes are not ours to keep. */
export function describeUploads(attachments: OutgoingAttachment[]): string {
  if (attachments.length === 0) return '';
  return `attached ${attachments.map(a => a.filename).join(', ')}`;
}
