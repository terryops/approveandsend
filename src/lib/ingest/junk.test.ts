import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../mail/types';
import { junkVerdict } from './junk';

function mail(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1',
    subject: 'Where has my export gone',
    from: { address: 'sam@example.com' },
    to: [{ address: 'support@example.com' }],
    receivedAt: '2026-01-01T00:00:00.000Z',
    isRead: false,
    hasAttachments: false,
    ...overrides,
  };
}

describe('junkVerdict', () => {
  it('lets an ordinary customer through', () => {
    expect(junkVerdict(mail())).toBeNull();
  });

  it('lets a customer through even when the headers are missing entirely', () => {
    const message = mail();
    delete message.headers;
    expect(junkVerdict(message)).toBeNull();
  });

  it('catches mail sent to a list', () => {
    const verdict = junkVerdict(
      mail({ headers: { 'list-unsubscribe': '<https://example.com/unsub?id=9>' } }),
    );
    expect(verdict?.reason).toContain('List-Unsubscribe');
  });

  it('catches mail that says a machine wrote it', () => {
    expect(junkVerdict(mail({ headers: { 'auto-submitted': 'auto-replied' } }))?.reason)
      .toContain('auto-replied');
  });

  it('does not treat Auto-Submitted: no as automated', () => {
    // RFC 3834's own way of saying "a person wrote this". Reading it as a
    // machine signal would drop every customer whose client is careful.
    expect(junkVerdict(mail({ headers: { 'auto-submitted': 'no' } }))).toBeNull();
  });

  it('catches bulk precedence', () => {
    expect(junkVerdict(mail({ headers: { precedence: 'bulk' } }))?.reason).toContain('bulk');
  });

  it('leaves ordinary precedence alone', () => {
    expect(junkVerdict(mail({ headers: { precedence: 'urgent' } }))).toBeNull();
  });

  it('honours a request for no automatic response', () => {
    expect(junkVerdict(mail({ headers: { 'x-auto-response-suppress': 'OOF, AutoReply' } })))
      .not.toBeNull();
  });

  it('catches a bounce', () => {
    expect(junkVerdict(mail({ headers: { 'return-path': '<>' } }))?.reason).toContain('bounce');
  });

  it('does not read an ordinary Return-Path as a bounce', () => {
    // The empty-envelope check is `<>` exactly. A header that is simply absent
    // is every normal message, and matching it would empty the queue.
    expect(junkVerdict(mail({ headers: { 'return-path': '<sam@example.com>' } }))).toBeNull();
  });

  it('catches an address that does not read replies', () => {
    for (const address of [
      'no-reply@example.com',
      'noreply@example.com',
      'donotreply@example.com',
      'DO-NOT-REPLY@Example.com',
      'mailer-daemon@example.com',
      'bounces@example.com',
      'notifications@example.com',
    ]) {
      expect(junkVerdict(mail({ from: { address } })), address).not.toBeNull();
    }
  });

  it('does not mistake a person whose name starts like one', () => {
    // The regex is anchored to the start of the local part, and these are the
    // near misses that would cost a real customer their reply.
    for (const address of [
      'noreen@example.com',
      'bounce-tracking-team@example.com',
      'postmaster-general@example.com',
    ]) {
      const verdict = junkVerdict(mail({ from: { address } }));
      if (address === 'noreen@example.com') expect(verdict, address).toBeNull();
      // The other two do start with a listed word; asserted here so a later
      // change to the pattern has to say so out loud rather than drift.
      else expect(verdict, address).not.toBeNull();
    }
  });

  it('reads headers case-insensitively in their values', () => {
    expect(junkVerdict(mail({ headers: { precedence: 'BULK' } }))).not.toBeNull();
  });

  it('names the address in the reason so a dismissed row explains itself', () => {
    expect(junkVerdict(mail({ from: { address: 'no-reply@stripe.com' } }))?.reason)
      .toContain('no-reply@stripe.com');
  });
});
