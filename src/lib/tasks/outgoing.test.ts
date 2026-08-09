import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { MAX_UPLOAD_BYTES } from '../mail/uploads';
import {
  attachToTask,
  clearPending,
  detachFromTask,
  listPending,
  pendingAttachments,
  pendingBytes,
} from './outgoing';
import { createTask } from './store';

let db: Db;
let taskId: string;

function file(name: string, bytes: number, contentType = 'application/pdf') {
  return { filename: name, content: Buffer.alloc(bytes, 1), contentType };
}

beforeEach(() => {
  db = openDb(':memory:');
  taskId = createTask({ subject: 'Invoice?', fromAddress: 'sam@example.com' }, db).task.id;
});

afterEach(() => {
  db.close();
});

describe('attachToTask', () => {
  it('keeps the bytes, because nothing else is holding them', () => {
    attachToTask(taskId, [file('invoice.pdf', 2048)], db);

    // The whole reason this table exists: a browser will not refill a file
    // input, so between picking and sending this is the only copy.
    expect(pendingAttachments(taskId, db)).toEqual([
      { filename: 'invoice.pdf', content: Buffer.alloc(2048, 1), contentType: 'application/pdf' },
    ]);
  });

  it('lists names and sizes without reading the blob back', () => {
    attachToTask(taskId, [file('invoice.pdf', 2048), file('terms.pdf', 1024)], db);

    expect(listPending(taskId, db).map(f => [f.filename, f.size])).toEqual([
      ['invoice.pdf', 2048],
      ['terms.pdf', 1024],
    ]);
    expect(listPending(taskId, db)[0]).not.toHaveProperty('content');
  });

  it('replaces a file picked again rather than sending both copies', () => {
    attachToTask(taskId, [file('invoice.pdf', 2048)], db);
    attachToTask(taskId, [{ ...file('invoice.pdf', 4096), content: Buffer.alloc(4096, 2) }], db);

    const kept = listPending(taskId, db);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.size).toBe(4096);
    expect(pendingAttachments(taskId, db)[0]?.content).toEqual(Buffer.alloc(4096, 2));
  });

  it('measures the ceiling against what the reply is already carrying', () => {
    const half = Math.floor(MAX_UPLOAD_BYTES * 0.6);
    attachToTask(taskId, [file('first.bin', half)], db);

    // Each of these passes `readUploads` on its own. Only the total is over,
    // and only this call can see the total.
    expect(() => attachToTask(taskId, [file('second.bin', half)], db)).toThrow(/MB/);
  });

  it('stores none of a batch that would go over, rather than half of it', () => {
    const big = Math.floor(MAX_UPLOAD_BYTES * 0.9);
    expect(() => attachToTask(taskId, [file('a.bin', big), file('b.bin', big)], db)).toThrow(/MB/);

    expect(listPending(taskId, db)).toEqual([]);
  });

  it('does not count a file against itself when it is being replaced', () => {
    const most = Math.floor(MAX_UPLOAD_BYTES * 0.9);
    attachToTask(taskId, [file('draft.pdf', most)], db);

    // The corrected copy of a 13 MB file is not 26 MB.
    expect(() => attachToTask(taskId, [file('draft.pdf', most)], db)).not.toThrow();
    expect(pendingBytes(taskId, db)).toBe(most);
  });
});

describe('taking one back off', () => {
  it('removes only the one asked for', () => {
    attachToTask(taskId, [file('invoice.pdf', 512), file('terms.pdf', 512)], db);
    const [invoice] = listPending(taskId, db);

    expect(detachFromTask(taskId, invoice!.id, db)).toBe(true);
    expect(listPending(taskId, db).map(f => f.filename)).toEqual(['terms.pdf']);
  });

  it('refuses an id that belongs to another task', () => {
    attachToTask(taskId, [file('invoice.pdf', 512)], db);
    const [mine] = listPending(taskId, db);
    const other = createTask({ subject: 'Other', fromAddress: 'b@example.com' }, db).task.id;

    // The id in a form is a value somebody can edit, so the task is part of the
    // delete rather than checked after it.
    expect(detachFromTask(other, mine!.id, db)).toBe(false);
    expect(listPending(taskId, db)).toHaveLength(1);
  });
});

describe('clearPending', () => {
  it('leaves nothing behind', () => {
    attachToTask(taskId, [file('invoice.pdf', 512), file('terms.pdf', 512)], db);

    clearPending(taskId, db);

    expect(listPending(taskId, db)).toEqual([]);
    expect(pendingBytes(taskId, db)).toBe(0);
  });
});
