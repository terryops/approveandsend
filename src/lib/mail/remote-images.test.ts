import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, setDb, type Db } from '../db';
import { resetSessionSecret } from '../auth/secret';
import {
  isPrivateAddress,
  remoteImageUrl,
  remoteImagesAllowed,
  signedForFetching,
} from './remote-images';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  setDb(db);
  resetSessionSecret();
});

afterEach(() => {
  setDb(null);
  db.close();
  resetSessionSecret();
  delete process.env.MAIL_REMOTE_IMAGES;
});

describe('whether the desk fetches them at all', () => {
  it('does, unless somebody says otherwise', () => {
    expect(remoteImagesAllowed()).toBe(true);
    for (const off of ['false', 'FALSE', '0', 'no']) {
      process.env.MAIL_REMOTE_IMAGES = off;
      expect(remoteImagesAllowed(), off).toBe(false);
    }
    process.env.MAIL_REMOTE_IMAGES = 'true';
    expect(remoteImagesAllowed()).toBe(true);
  });
});

describe('the signature on a proxied address', () => {
  /*
   * Without this the route is a general-purpose fetcher wearing our origin. The
   * session says who may ask; only the signature says what they may ask for.
   */
  it('is what stops the route being asked to fetch anything else', () => {
    const url = 'https://cdn.example/logo.png';
    const signature = new URL(`http://x${remoteImageUrl(url)}`).searchParams.get('s')!;

    expect(signedForFetching(url, signature)).toBe(true);
    // A signature is for one address. Reusing it for another is the whole
    // attack, and it is the one thing this has to refuse.
    expect(signedForFetching('https://cdn.example/other.png', signature)).toBe(false);
    expect(signedForFetching('http://169.254.169.254/latest/meta-data/', signature)).toBe(false);
    expect(signedForFetching(url, '')).toBe(false);
    expect(signedForFetching(url, `${signature}x`)).toBe(false);
  });

  it('carries the address through the query string intact', () => {
    const url = 'https://cdn.example/a.png?w=2&h=3';
    const parsed = new URL(`http://x${remoteImageUrl(url)}`);
    expect(parsed.searchParams.get('u')).toBe(url);
    expect(signedForFetching(parsed.searchParams.get('u')!, parsed.searchParams.get('s')!)).toBe(true);
  });
});

/*
 * The signed URL came out of a letter, and a letter is written by whoever sent
 * it. `<img src="http://169.254.169.254/latest/meta-data/">` in an email is a
 * request that the desk read its own cloud credentials and hand back the bytes,
 * and the signature does not help — we signed it ourselves.
 */
describe('the addresses the desk refuses to fetch', () => {
  it('knows a private one when it resolves to one', () => {
    for (const address of [
      '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('leaves the public internet alone', () => {
    for (const address of [
      '1.1.1.1', '8.8.8.8', '13.107.42.14', '172.15.0.1', '172.32.0.1',
      '100.63.255.255', '100.128.0.1', '2606:4700::1111', '2a00:1450:4001::200e',
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
