import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES, describeUploads, readUploads } from './uploads';

function form(...files: File[]): FormData {
  const data = new FormData();
  for (const file of files) data.append('files', file);
  return data;
}

describe('readUploads', () => {
  it('reads what the reviewer picked', async () => {
    const data = form(new File(['hello'], 'note.txt', { type: 'text/plain' }));

    const [attachment, ...rest] = await readUploads(data);

    expect(rest).toEqual([]);
    expect(attachment).toMatchObject({ filename: 'note.txt', contentType: 'text/plain' });
    expect(attachment!.content.toString()).toBe('hello');
  });

  it('ignores the empty file an untouched input posts', async () => {
    // Every browser posts one of these for a file input nobody clicked.
    // Passed through, every reply from this form carries a nameless empty
    // attachment, which most mail clients draw as a broken paperclip.
    expect(await readUploads(form(new File([], '')))).toEqual([]);
    expect(await readUploads(new FormData())).toEqual([]);
  });

  it('refuses more than a mail server will carry, before anything is sent', async () => {
    const huge = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'dump.bin');

    await expect(readUploads(form(huge))).rejects.toThrow(/MB/);
  });

  it('measures the whole request, not each file', async () => {
    // Ten files under the limit each are still one message over it.
    const half = () => new File([new Uint8Array(MAX_UPLOAD_BYTES * 0.6)], 'half.bin');

    await expect(readUploads(form(half(), half()))).rejects.toThrow(/MB/);
  });

  it('takes several, in the order they were given', async () => {
    const data = form(new File(['a'], 'a.png'), new File(['b'], 'b.pdf'));

    expect((await readUploads(data)).map(a => a.filename)).toEqual(['a.png', 'b.pdf']);
  });
});

describe('describeUploads', () => {
  it('names them, because the names are all that is kept', () => {
    expect(describeUploads([{ filename: 'invoice.pdf', content: Buffer.from('') }])).toBe(
      'attached invoice.pdf',
    );
  });

  it('says nothing when there was nothing', () => {
    expect(describeUploads([])).toBe('');
  });
});
