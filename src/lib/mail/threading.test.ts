import { describe, expect, it } from 'vitest';

import { buildReferences, findThreadFor, groupIntoThreads, normalizeSubject } from './threading';
import type { MailMessage } from './types';

let seq = 0;
function msg(over: Partial<MailMessage> & { id: string }): MailMessage {
  seq += 1;
  return {
    subject: 'Subject',
    from: { address: 'customer@example.com' },
    to: [{ address: 'support@us.com' }],
    receivedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
    isRead: false,
    hasAttachments: false,
    ...over,
  };
}

describe('normalizeSubject', () => {
  it('strips reply and forward prefixes, including stacked ones', () => {
    expect(normalizeSubject('Re: Fwd: RE: Invoice')).toBe('invoice');
    expect(normalizeSubject('Re[2]: Invoice')).toBe('invoice');
    expect(normalizeSubject('回复: Invoice')).toBe('invoice');
  });

  it('strips a list tag', () => {
    expect(normalizeSubject('[support] Re: Invoice')).toBe('invoice');
  });

  it('collapses whitespace and lowercases', () => {
    expect(normalizeSubject('  Big   Question  ')).toBe('big question');
  });

  it('survives an empty subject', () => {
    expect(normalizeSubject('')).toBe('');
    expect(normalizeSubject(undefined)).toBe('');
  });
});

describe('groupIntoThreads', () => {
  it('returns [] for no messages', () => {
    expect(groupIntoThreads([])).toEqual([]);
  });

  // The header tests below all give each message its own subject. Sharing one
  // would let the subject fallback join them on its own, and the test would
  // then pass with the header passes deleted.
  it('links a reply to its parent by In-Reply-To', () => {
    const a = msg({ id: 'a', subject: 'Broken invoice', messageIdHeader: 'a@m' });
    const b = msg({ id: 'b', subject: 'A different line entirely', messageIdHeader: 'b@m', inReplyTo: 'a@m' });

    const groups = groupIntoThreads([b, a]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('links a whole chain through References even with a missing middle', () => {
    const a = msg({ id: 'a', subject: 'Broken invoice', messageIdHeader: 'a@m' });
    const c = msg({
      id: 'c',
      subject: 'A different line entirely',
      messageIdHeader: 'c@m',
      references: ['a@m', 'b@m'],
    });

    const groups = groupIntoThreads([a, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map(m => m.id)).toEqual(['a', 'c']);
  });

  it('tolerates angle brackets in headers', () => {
    const a = msg({ id: 'a', subject: 'Broken invoice', messageIdHeader: '<a@m>' });
    const b = msg({ id: 'b', subject: 'A different line entirely', inReplyTo: '<a@m>' });
    expect(groupIntoThreads([a, b])).toHaveLength(1);
  });

  it('honours a server-side threadId', () => {
    const a = msg({ id: 'a', threadId: 't1', subject: 'One' });
    const b = msg({ id: 'b', threadId: 't1', subject: 'Totally different' });
    expect(groupIntoThreads([a, b])).toHaveLength(1);
  });

  it('falls back to subject when the participants overlap', () => {
    const a = msg({ id: 'a', subject: 'Refund please' });
    const b = msg({
      id: 'b',
      subject: 'Re: Refund please',
      from: { address: 'support@us.com' },
      to: [{ address: 'customer@example.com' }],
    });

    const groups = groupIntoThreads([a, b]);
    expect(groups).toHaveLength(1);
  });

  it('refuses to merge same-subject mail from unrelated people', () => {
    // The whole point of requiring a shared participant: two customers both
    // writing "Invoice" must not end up in one prompt.
    const a = msg({
      id: 'a',
      subject: 'Invoice',
      from: { address: 'alice@a.com' },
      to: [{ address: 'support@us.com' }],
    });
    const b = msg({
      id: 'b',
      subject: 'Invoice',
      from: { address: 'bob@b.com' },
      to: [{ address: 'help@other.com' }],
    });

    expect(groupIntoThreads([a, b])).toHaveLength(2);
  });

  it('sorts each thread oldest first and the threads newest first', () => {
    const old1 = msg({ id: 'old1', threadId: 'old', receivedAt: '2026-01-01T00:00:00.000Z' });
    const old2 = msg({ id: 'old2', threadId: 'old', receivedAt: '2026-01-02T00:00:00.000Z' });
    const recent = msg({ id: 'new', threadId: 'new', receivedAt: '2026-06-01T00:00:00.000Z' });

    const groups = groupIntoThreads([old2, recent, old1]);
    expect(groups.map(g => g.map(m => m.id))).toEqual([['new'], ['old1', 'old2']]);
  });

  it('keeps unrelated messages apart', () => {
    const a = msg({ id: 'a', subject: 'One', messageIdHeader: 'a@m' });
    const b = msg({ id: 'b', subject: 'Two', messageIdHeader: 'b@m' });
    expect(groupIntoThreads([a, b])).toHaveLength(2);
  });
});

describe('findThreadFor', () => {
  it('returns the conversation containing the target', () => {
    const a = msg({ id: 'a', subject: 'Broken invoice', messageIdHeader: 'a@m' });
    const b = msg({ id: 'b', subject: 'A different line entirely', inReplyTo: 'a@m' });
    const other = msg({ id: 'z', subject: 'Unrelated', messageIdHeader: 'z@m' });

    expect(findThreadFor(b, [a, b, other]).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('returns [] when the target is not in the pool', () => {
    expect(findThreadFor(msg({ id: 'ghost' }), [msg({ id: 'a' })])).toEqual([]);
  });
});

describe('buildReferences', () => {
  it('appends the parent to its own chain', () => {
    expect(buildReferences('c@m', ['a@m', 'b@m'])).toEqual(['a@m', 'b@m', 'c@m']);
  });

  it('does not duplicate a parent already in the chain', () => {
    expect(buildReferences('b@m', ['a@m', 'b@m'])).toEqual(['a@m', 'b@m']);
  });

  it('handles a first reply with no chain yet', () => {
    expect(buildReferences('a@m')).toEqual(['a@m']);
    expect(buildReferences(undefined)).toEqual([]);
  });

  it('caps long chains but keeps the root, so the thread root survives', () => {
    const chain = Array.from({ length: 50 }, (_, i) => `id${i}@m`);
    const refs = buildReferences('last@m', chain, 5);

    expect(refs).toHaveLength(5);
    expect(refs[0]).toBe('id0@m');
    expect(refs.at(-1)).toBe('last@m');
  });
});

describe('threadId beats the subject guess', () => {
  it('does not merge distinct server threads that share a subject', () => {
    // A customer reusing one subject line across separate tickets must not
    // collapse into a single unbounded thread.
    const jan = msg({ id: 'jan', threadId: 't1', subject: 'Invoice' });
    const jun = msg({ id: 'jun', threadId: 't2', subject: 'Invoice' });

    expect(groupIntoThreads([jan, jun])).toHaveLength(2);
  });

  it('still merges by subject when only one side has a threadId', () => {
    const a = msg({ id: 'a', threadId: 't1', subject: 'Invoice' });
    const b = msg({ id: 'b', subject: 'Re: Invoice' });

    expect(groupIntoThreads([a, b])).toHaveLength(1);
  });
});
