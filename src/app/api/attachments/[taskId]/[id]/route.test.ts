import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The guard and the mailbox, both stood in for. This file is about one
// decision — what the browser is told to do with the bytes — and neither
// signing in nor talking to Zoho is part of it.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth/guard', () => ({ hasSession: async () => true }));

const download = vi.fn();
vi.mock('@/lib/mail/config', () => ({ mailProvider: () => ({ downloadAttachment: download }) }));

import { openDb, setDb, type Db } from '@/lib/db';
import { addAttachment } from '@/lib/tasks/attachments';
import { createTask } from '@/lib/tasks/store';

import { GET } from './route';

let db: Db;
let taskId: string;

function get(attachmentId: string): Promise<Response> {
  return GET(new Request('http://localhost/api/attachments/x/y'), {
    params: Promise.resolve({ taskId, id: attachmentId }),
  });
}

function store(filename: string, contentType: string): string {
  const row = addAttachment(taskId, { messageId: 'm', attachmentId: 'a', filename, contentType }, db);
  download.mockResolvedValue({ filename, contentType, content: Buffer.from('bytes') });
  return row.id;
}

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  taskId = createTask({ messageId: 'one', fromAddress: 'lin@example.com' }, db).task.id;
  download.mockReset();
});

afterEach(() => {
  db.close();
});

describe('attachment download', () => {
  it('shows a screenshot rather than downloading it', async () => {
    // A support desk runs on screenshots, and a screenshot behind a download
    // link is one nobody looks at.
    const response = await get(store('shot.png', 'image/png'));

    expect(response.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('refuses to render an SVG in our own origin', async () => {
    // It is a document that can carry script. Rendered here it runs as us,
    // with the reviewer's session sitting right there.
    const response = await get(store('logo.svg', 'image/svg+xml'));

    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('still downloads everything that is not a picture', async () => {
    const response = await get(store('report.html', 'text/html'));

    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('forbids the browser from sniffing past the type we allowed', async () => {
    // Without this the allowlist is a check on a label rather than on bytes:
    // a browser left to sniff can decide our "image/png" is really HTML.
    const response = await get(store('shot.png', 'image/png'));

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('will not fetch an attachment belonging to another task', async () => {
    const other = createTask({ messageId: 'two', fromAddress: 'x@example.com' }, db).task.id;
    const mine = store('shot.png', 'image/png');

    const response = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ taskId: other, id: mine }),
    });

    expect(response.status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });
});
