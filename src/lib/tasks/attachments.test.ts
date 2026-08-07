import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { addAttachment, attachmentSummary, getAttachment, isRenderableImage, listAttachments } from './attachments';
import { createTask } from './store';

let db: Db;
let taskId: string;

beforeEach(() => {
  db = openDb(':memory:');
  taskId = createTask({ subject: 'Help', fromAddress: 'a@example.com' }, db).task.id;
});

afterEach(() => {
  db.close();
});

describe('addAttachment', () => {
  it('keeps what is needed to fetch the bytes later', () => {
    const saved = addAttachment(
      taskId,
      {
        messageId: 'msg-1',
        attachmentId: 'att-1',
        filename: 'export.log',
        contentType: 'text/plain',
        size: 4096,
      },
      db,
    );

    expect(saved).toMatchObject({
      taskId,
      messageId: 'msg-1',
      attachmentId: 'att-1',
      filename: 'export.log',
      size: 4096,
      inline: false,
    });
  });

  it('updates rather than duplicates when a message is read again', () => {
    const first = addAttachment(taskId, { messageId: 'm', attachmentId: 'a', filename: 'old.log' }, db);
    const second = addAttachment(taskId, { messageId: 'm', attachmentId: 'a', filename: 'new.log' }, db);

    expect(second.id).toBe(first.id);
    expect(listAttachments(taskId, db)).toHaveLength(1);
    expect(listAttachments(taskId, db)[0]?.filename).toBe('new.log');
  });

  it('falls back to a content type rather than storing none', () => {
    // An empty one would end up in a Content-Type header, and a browser given
    // an empty type guesses — which for a customer's HTML is the wrong guess.
    const saved = addAttachment(taskId, { messageId: 'm', attachmentId: 'a', contentType: '' }, db);
    expect(saved.contentType).toBe('application/octet-stream');
  });
});

describe('getAttachment', () => {
  it('will not hand over an attachment belonging to another task', () => {
    const other = createTask({ subject: 'Other', fromAddress: 'b@example.com' }, db).task.id;
    const saved = addAttachment(other, { messageId: 'm', attachmentId: 'a', filename: 'theirs.pdf' }, db);

    // The download route passes the task from the URL. If the row could be
    // found without it, editing the URL would walk the whole table.
    expect(getAttachment(taskId, saved.id, db)).toBeNull();
    expect(getAttachment(other, saved.id, db)?.filename).toBe('theirs.pdf');
  });
});

describe('attachmentSummary', () => {
  it('names the files a person meant to send', () => {
    addAttachment(taskId, { messageId: 'm', attachmentId: '1', filename: 'export.log' }, db);
    addAttachment(taskId, { messageId: 'm', attachmentId: '2', filename: 'screenshot.png' }, db);

    expect(attachmentSummary(listAttachments(taskId, db))).toBe('export.log, screenshot.png');
  });

  it('leaves out signature logos and unnamed parts', () => {
    addAttachment(taskId, { messageId: 'm', attachmentId: '1', filename: 'logo.png', inline: true }, db);
    addAttachment(taskId, { messageId: 'm', attachmentId: '2', filename: '' }, db);

    expect(attachmentSummary(listAttachments(taskId, db))).toBe('');
  });

  it('names a file once when the same one is quoted down the thread', () => {
    addAttachment(taskId, { messageId: 'm1', attachmentId: '1', filename: 'export.log' }, db);
    addAttachment(taskId, { messageId: 'm2', attachmentId: '9', filename: 'export.log' }, db);

    expect(attachmentSummary(listAttachments(taskId, db))).toBe('export.log');
  });
});

describe('isRenderableImage', () => {
  it('says yes to the formats that decode to pixels', () => {
    expect(isRenderableImage('image/png')).toBe(true);
    expect(isRenderableImage('image/jpeg')).toBe(true);
    expect(isRenderableImage('IMAGE/GIF')).toBe(true);
    expect(isRenderableImage('image/webp; name=shot.webp')).toBe(true);
  });

  it('says no to SVG, which is a document that can carry script', () => {
    // Displayed in our own origin it would run as us, with the reviewer's
    // session sitting right there. It is an image only by file extension.
    expect(isRenderableImage('image/svg+xml')).toBe(false);
  });

  it('says no to everything that is not an image at all', () => {
    expect(isRenderableImage('text/html')).toBe(false);
    expect(isRenderableImage('application/pdf')).toBe(false);
    expect(isRenderableImage('')).toBe(false);
  });
});

