import { hasSession } from '@/lib/auth/guard';
import { mailProvider } from '@/lib/mail/config';
import { getAttachment, isRenderableImage } from '@/lib/tasks/attachments';

export const dynamic = 'force-dynamic';

/**
 * The bytes of one attachment, fetched from the mailbox on demand.
 *
 * The route is keyed on our own row id *and* the task, and the provider ids
 * come out of that row rather than out of the URL. A route that took the
 * provider's message and attachment ids directly would be a reader for the
 * whole mailbox wearing a task's clothes: any signed-in operator could walk it
 * to mail that was never ingested, including their colleagues' own messages.
 *
 * Not cached anywhere on our side. A support desk's attachments are customer
 * data, and a disk cache is a second place to have to delete it from.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string; id: string }> },
): Promise<Response> {
  if (!(await hasSession())) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { taskId, id } = await params;
  const attachment = getAttachment(taskId, id);
  if (!attachment) {
    return Response.json({ error: 'No such attachment' }, { status: 404 });
  }

  const provider = mailProvider();
  try {
    const file = await provider.downloadAttachment(
      attachment.messageId,
      attachment.attachmentId,
    );

    const type = file.contentType || attachment.contentType;

    // Downloaded, unless it is a picture. A support desk runs on screenshots,
    // and a screenshot behind a download link is one nobody looks at — so the
    // narrowest possible exception is made for formats that decode to pixels
    // and cannot carry script. Anything else, HTML and SVG very much included,
    // is still served as a file: rendering one in our own origin would hand
    // whoever sent it the reviewer's session.
    //
    // `X-Content-Type-Options` is what makes the allowlist mean anything. A
    // browser left to sniff can decide our "image/png" is really HTML, and
    // then the check above was on a label rather than on the bytes.
    const renderable = isRenderableImage(type);
    const filename = file.filename || attachment.filename || 'attachment';

    return new Response(new Uint8Array(file.content), {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `${renderable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(
          filename,
        )}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    // Usually the mail is gone: deleted from the mailbox after we recorded it.
    // Worth saying so, because the row will still be listed on the task.
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
  // The provider is the shared cached one; closing it here would drop the
  // connection out from under the sync running alongside this download.
}
