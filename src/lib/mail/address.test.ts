import { describe, expect, it } from 'vitest';

import {
  extractEmail,
  formatAddress,
  formatAddressList,
  isValidEmail,
  normalizeMessageId,
  parseAddress,
  parseAddressList,
  parseReferences,
} from './address';

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const a of ['v@example.com', 'first.last+tag@sub.example.co.uk', 'x@y.io']) {
      expect(isValidEmail(a)).toBe(true);
    }
  });

  it('rejects the usual garbage', () => {
    for (const a of ['', '   ', 'nope', 'a@b', '@example.com', 'a b@example.com', 'a@example', null]) {
      expect(isValidEmail(a)).toBe(false);
    }
  });
});

describe('extractEmail', () => {
  it('handles every shape mail servers actually send', () => {
    expect(extractEmail('"Vincent Li" <v@example.com>')).toBe('v@example.com');
    expect(extractEmail('Vincent Li <v@example.com>')).toBe('v@example.com');
    expect(extractEmail('<v@example.com>')).toBe('v@example.com');
    expect(extractEmail('v@example.com')).toBe('v@example.com');
    expect(extractEmail('  V@Example.COM  ')).toBe('v@example.com');
  });

  it('digs an address out of a malformed header rather than giving up', () => {
    expect(extractEmail('Vincent Li v@example.com (support)')).toBe('v@example.com');
  });

  it('returns empty string when there is nothing there', () => {
    expect(extractEmail('Undisclosed recipients')).toBe('');
    expect(extractEmail(null)).toBe('');
  });
});

describe('parseAddress', () => {
  it('keeps the display name and unquotes it', () => {
    expect(parseAddress('"Li, Vincent" <v@example.com>')).toEqual({
      name: 'Li, Vincent',
      address: 'v@example.com',
    });
    expect(parseAddress('Vincent <v@example.com>')).toEqual({
      name: 'Vincent',
      address: 'v@example.com',
    });
  });

  it('omits the name when there is none', () => {
    expect(parseAddress('v@example.com')).toEqual({ address: 'v@example.com' });
  });

  it('returns null for unusable input', () => {
    expect(parseAddress('nobody')).toBeNull();
  });
});

describe('parseAddressList', () => {
  it('splits on commas', () => {
    expect(parseAddressList('a@x.com, b@y.com')).toEqual([
      { address: 'a@x.com' },
      { address: 'b@y.com' },
    ]);
  });

  it('does not split on a comma inside a quoted display name', () => {
    const list = parseAddressList('"Li, Vincent" <v@example.com>, b@y.com');
    expect(list).toEqual([
      { name: 'Li, Vincent', address: 'v@example.com' },
      { address: 'b@y.com' },
    ]);
  });

  it('deduplicates, because Reply-All produces duplicates constantly', () => {
    const list = parseAddressList('a@x.com, "A" <a@x.com>, b@y.com');
    expect(list.map(a => a.address)).toEqual(['a@x.com', 'b@y.com']);
  });

  it('skips unparseable entries instead of failing the whole header', () => {
    expect(parseAddressList('a@x.com, garbage, b@y.com').map(a => a.address)).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('formatAddress', () => {
  it('round-trips through parseAddress', () => {
    const original = '"Li, Vincent" <v@example.com>';
    expect(formatAddress(parseAddress(original)!)).toBe(original);
  });

  it('leaves a simple name unquoted', () => {
    expect(formatAddress({ name: 'Vincent', address: 'v@example.com' })).toBe(
      'Vincent <v@example.com>',
    );
  });

  it('escapes quotes inside a name', () => {
    expect(formatAddress({ name: 'He said "hi"', address: 'v@example.com' })).toBe(
      '"He said \\"hi\\"" <v@example.com>',
    );
  });

  it('emits a bare address when there is no name', () => {
    expect(formatAddressList([{ address: 'a@x.com' }, { address: 'b@y.com' }])).toBe(
      'a@x.com, b@y.com',
    );
  });
});

describe('message id helpers', () => {
  it('strips angle brackets so ids compare equal', () => {
    expect(normalizeMessageId('<abc@mail>')).toBe('abc@mail');
    expect(normalizeMessageId('  abc@mail ')).toBe('abc@mail');
    expect(normalizeMessageId(undefined)).toBe('');
  });

  it('parses a References header into bare ids', () => {
    expect(parseReferences('<a@m>\r\n <b@m>\t<c@m>')).toEqual(['a@m', 'b@m', 'c@m']);
  });

  it('copes with a References header missing its brackets', () => {
    expect(parseReferences('a@m b@m')).toEqual(['a@m', 'b@m']);
  });

  it('returns [] for nothing', () => {
    expect(parseReferences('')).toEqual([]);
  });
});
