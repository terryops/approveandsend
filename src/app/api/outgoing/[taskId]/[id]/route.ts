import { hasSession } from '@/lib/auth/guard';
import { isRenderableImage } from '@/lib/tasks/attachments';
import { getPending } from '@/lib/tasks/outgoing';

export const dynamic = 'force-dynamic';

/**
 * A file the reviewer has put on a reply, read back.
 *
 * The sibling of `/api/attachments`, and the difference is where the bytes come
 * from: those live in the mailbox and are fetched on demand, these are in our
 * own table because nothing else is holding them yet — see `outgoing.ts`. That
 * makes this route the only way to check what you attached, which is the whole
 * reason a thumbnail on the review screen can be clicked.
 *
 * Keyed on the task as well as the row, so a link cannot be edited into one for
 * somebody else's reply.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string; id: string }> },
): Promise<Response> {
  if (!(await hasSession())) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { taskId, id } = await params;
  const file = getPending(taskId, id);
  if (!file) {
    return Response.json({ error: 'No such attachment' }, { status: 404 });
  }

  // The same narrow exception the incoming route makes, for the same reason: a
  // picture is worth rendering and everything else is served as a file, because
  // HTML or SVG rendered in our own origin hands whoever wrote it the reviewer's
  // session. These came off the reviewer's own disk rather than out of a
  // stranger's email, which makes it likelier to be safe and no more provable —
  // and the thumbnail on the review screen is an `<img>` pointed at this route,
  // so the allowlist is what decides whether it can draw at all.
  const renderable = isRenderableImage(file.contentType);

  return new Response(new Uint8Array(file.content), {
    headers: {
      'Content-Type': file.contentType || 'application/octet-stream',
      'Content-Disposition': `${renderable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(
        file.filename || 'attachment',
      )}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
