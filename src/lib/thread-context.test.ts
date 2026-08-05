import { describe, expect, it } from 'vitest';

import { buildThreadContext, htmlToText, trimEmailBody } from './thread-context';

describe('htmlToText', () => {
  it('leaves plain text alone', () => {
    expect(htmlToText('Hi there\nthanks')).toBe('Hi there\nthanks');
  });

  it('drops script and style content entirely', () => {
    const html = '<div>Hello<style>.a{color:red}</style><script>alert(1)</script>World</div>';
    const text = htmlToText(html);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('alert');
  });

  it('turns block tags into newlines and decodes entities', () => {
    expect(htmlToText('<p>A&nbsp;&amp;&nbsp;B</p><p>C</p>')).toBe('A & B\nC');
    expect(htmlToText('one<br>two')).toBe('one\ntwo');
  });

  it('is a real size reduction on marked-up mail', () => {
    const html = `<div style="${'x'.repeat(5000)}">Actual content</div>`;
    expect(htmlToText(html)).toBe('Actual content');
  });
});

describe('trimEmailBody', () => {
  it('keeps short bodies untouched', () => {
    expect(trimEmailBody('short')).toBe('short');
  });

  it('keeps the tail, because the newest content is at the end', () => {
    const body = 'OLD'.repeat(100) + 'NEWEST';
    const trimmed = trimEmailBody(body, 20);
    expect(trimmed).toMatch(/^…\(\d+ characters omitted\)\n/);
    expect(trimmed.endsWith('NEWEST')).toBe(true);
  });
});

const at = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

describe('buildThreadContext', () => {
  it('returns empty string when there is no history', () => {
    expect(buildThreadContext([], [], {})).toBe('');
    expect(buildThreadContext(undefined, undefined)).toBe('');
  });

  it('interleaves inbound and outbound by timestamp, oldest first', () => {
    const out = buildThreadContext(
      [
        { body: 'first question', receivedAt: at(1) },
        { body: 'third message', receivedAt: at(3) },
      ],
      [{ body: 'our answer', receivedAt: at(2) }],
    );

    const order = ['first question', 'our answer', 'third message'].map(s => out.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toContain('[Customer]');
    expect(out).toContain('[Support]');
  });

  it('keeps only the newest N messages and says how many it dropped', () => {
    const inbound = Array.from({ length: 10 }, (_, i) => ({
      body: `message-${i}`,
      receivedAt: at(i + 1),
    }));

    const out = buildThreadContext(inbound, [], { maxMessages: 3 });

    expect(out).toContain('7 older messages omitted');
    expect(out).toContain('message-9');
    expect(out).toContain('message-7');
    expect(out).not.toContain('message-6');
  });

  it('caps the total size even when every message is huge', () => {
    const inbound = Array.from({ length: 10 }, (_, i) => ({
      body: '<div>' + 'x'.repeat(200_000) + `end-${i}</div>`,
      receivedAt: at(i + 1),
    }));

    const out = buildThreadContext(inbound, []);

    // The unbounded version of this produced ~1.4 MB and killed the request.
    expect(out.length).toBeLessThan(45_000);
    expect(out).toContain('end-9');
  });

  it('honours custom labels and footer', () => {
    const out = buildThreadContext([{ body: 'hi', receivedAt: at(1) }], [], {
      inboundLabel: 'Guest',
      footer: 'THE-END',
    });
    expect(out).toContain('[Guest]');
    expect(out).toContain('THE-END');
  });
});
