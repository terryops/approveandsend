import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadImapSmtpConfig } from './config';
import {
  MAIL_HOSTS,
  OTHER_HOST,
  ZOHO_API_SERVICE,
  applyHost,
  hostFor,
  hostForAddress,
  mailHost,
  menuOwns,
  serviceFor,
  type MailFields,
} from './hosts';

/**
 * The menu is a list of services; `.env` holds four hostnames and ports. These
 * are the tests for the trip between the two, and for the one property nothing
 * downstream can check: a preset that is wrong fails as "could not connect",
 * which is indistinguishable from a bad password and costs somebody an
 * afternoon. The same reasoning as `endpoints.test.ts`, one step later in the
 * wizard.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(IMAP|SMTP|MAIL)_/.test(key)) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('the mail service menu', () => {
  it('gives every line an id of its own', () => {
    const ids = MAIL_HOSTS.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Two lines on one IMAP host would be a line nobody can reach: `hostFor`
   * matches on that host, so the second could never be selected.
   */
  it('gives every line an IMAP host of its own', () => {
    const hosts = MAIL_HOSTS.filter(entry => entry.imapHost).map(entry => entry.imapHost);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('offers a complete line for every service it names', () => {
    for (const entry of MAIL_HOSTS) {
      if (entry.id === OTHER_HOST) continue;
      expect(entry.imapHost, entry.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(entry.smtpHost, entry.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      // 993 is the only IMAP port that works without `IMAP_SECURE`, which this
      // form does not collect; 465 and 587 are the two SMTP modes the loader
      // picks between on the number alone. A preset outside those needs a
      // fifth box before it needs a menu line.
      expect(entry.imapPort, entry.id).toBe(993);
      expect([465, 587], entry.id).toContain(entry.smtpPort);
    }
  });

  it('gives the last line no hosts, so picking it clears rather than fills', () => {
    expect(mailHost(OTHER_HOST)).toMatchObject({
      imapHost: '',
      smtpHost: '',
      imapPort: 0,
      smtpPort: 0,
    });
  });

  it('claims no domain twice, so a typed address has one answer', () => {
    const claimed = MAIL_HOSTS.flatMap(entry => entry.domains);
    expect(claimed).toEqual([...new Set(claimed)]);
  });

  it('leads every host back to the line it came from', () => {
    for (const entry of MAIL_HOSTS) {
      if (!entry.imapHost) continue;
      expect(hostFor(entry.imapHost), entry.id).toBe(entry.id);
    }
  });

  it('does not care about the case of the host or stray whitespace', () => {
    expect(hostFor('  IMAP.QQ.COM ')).toBe('qq');
  });

  /** Somebody's own server is not an error, and must not be overwritten. */
  it('lands a host it does not know on the last line', () => {
    expect(hostFor('mail.acme.internal')).toBe(OTHER_HOST);
    expect(hostFor('')).toBe(OTHER_HOST);
  });

  it('takes the service from the address when its domain says one', () => {
    expect(hostForAddress('support@163.com')).toBe('netease-163');
    expect(hostForAddress('Support@GoogleMail.com')).toBe('gmail');
  });

  it('says nothing about an address on a domain of somebody’s own', () => {
    // The overwhelmingly common case for a support desk, and the reason the
    // menu exists as well as the autofill.
    expect(hostForAddress('support@yourcompany.com')).toBeNull();
    expect(hostForAddress('half-typed')).toBeNull();
  });

  /**
   * The end of the trip: what the menu writes has to come back out of the
   * loader as a working connection, with the TLS mode the port implies. This is
   * what catches a preset changed to a port the loader reads the other way.
   */
  it('never claims a service for an .env that has no mailbox yet', () => {
    // The model menu opens an empty `.env` on OpenAI, because an empty address
    // there means "wherever that dialect answers". Here it means nothing is
    // configured, and this app's own audience is `support@theircompany.com` —
    // so opening on Gmail would put a wrong host in front of most of the
    // people who see this screen first.
    expect(hostFor('')).toBe(OTHER_HOST);
  });
  it('writes ports the loader reads back as the right TLS mode', () => {
    for (const entry of MAIL_HOSTS) {
      if (entry.id === OTHER_HOST) continue;

      process.env.MAIL_USER = 'support@us.com';
      process.env.MAIL_PASSWORD = 'secret';
      process.env.IMAP_HOST = entry.imapHost;
      process.env.IMAP_PORT = String(entry.imapPort);
      process.env.SMTP_HOST = entry.smtpHost;
      process.env.SMTP_PORT = String(entry.smtpPort);

      const cfg = loadImapSmtpConfig();
      expect(cfg.imap, entry.id).toMatchObject({ host: entry.imapHost, port: 993, secure: true });
      expect(cfg.smtp, entry.id).toMatchObject({
        host: entry.smtpHost,
        port: entry.smtpPort,
        secure: entry.smtpPort === 465,
      });
    }
  });
});

const EMPTY: MailFields = { imapHost: '', imapPort: '', smtpHost: '', smtpPort: '' };

/**
 * The one line of the menu that is a way of reaching a mailbox rather than a
 * place to reach it.
 *
 * Everything above reads the menu off `IMAP_HOST`, which is the right question
 * for every line but this one — a desk on the Zoho API has no IMAP host, and
 * would open on "something else" over four empty boxes while its mailbox worked
 * perfectly. That failure is quiet and it is the one these are here for: the
 * screen would be disowning a working configuration, and the obvious next move
 * — filling the boxes back in — is what actually breaks it.
 */
describe('the line that is not a host', () => {
  it('opens on the API whenever the provider says so, whatever the file kept', () => {
    // All three are real files. The second is a desk that has never been on
    // IMAP; the third has hosts left over from before it switched, which stay
    // in the file precisely so that switching back costs nothing.
    expect(serviceFor('zoho', '')).toBe(ZOHO_API_SERVICE);
    expect(serviceFor('zoho', 'imap.zoho.com')).toBe(ZOHO_API_SERVICE);
    expect(serviceFor('zoho', 'mail.acme.internal')).toBe(ZOHO_API_SERVICE);
  });

  it('reads the host for every other provider, including Zoho over IMAP', () => {
    expect(serviceFor('imap-smtp', 'imap.zoho.com')).toBe('zoho');
    // An empty `MAIL_PROVIDER` is the default, and the default is IMAP.
    expect(serviceFor('', 'imap.gmail.com')).toBe('gmail');
    expect(serviceFor('gmail', 'imap.gmail.com')).toBe('gmail');
    expect(serviceFor('', '')).toBe(OTHER_HOST);
  });

  it('does not care about the case of the provider or stray whitespace', () => {
    expect(serviceFor('  ZOHO ', '')).toBe(ZOHO_API_SERVICE);
  });

  /**
   * It has no host, no port and no password, so it cannot be a row of a table
   * whose every row is those four facts — and `mailHost` returning nothing for
   * it is what makes `chosenService` contribute nothing and `applyHost` clear
   * rather than fill.
   */
  it('is not in the host table, and so fills nothing in', () => {
    expect(mailHost(ZOHO_API_SERVICE)).toBeUndefined();
    expect(MAIL_HOSTS.map(entry => entry.id)).not.toContain(ZOHO_API_SERVICE);
    expect(applyHost(applyHost(EMPTY, 'zoho'), ZOHO_API_SERVICE)).toEqual(EMPTY);
  });
});

/**
 * What the menu may and may not overwrite.
 *
 * The whole reason the mailbox form has a menu is that four boxes get filled in
 * for you; the whole reason it is safe is that it will not take back a box you
 * filled in yourself. Both halves are here, because a bug in the second one is
 * silent — you look at the menu, look away, and the relay you set up last month
 * has become `smtp.gmail.com`.
 */
describe('filling the four boxes from the menu', () => {
  it('fills every box on an untouched form', () => {
    expect(applyHost(EMPTY, 'gmail')).toEqual({
      imapHost: 'imap.gmail.com',
      imapPort: '993',
      smtpHost: 'smtp.gmail.com',
      smtpPort: '465',
    });
  });

  it('replaces its own last answer, so changing your mind twice follows you', () => {
    const gmail = applyHost(EMPTY, 'gmail');
    expect(applyHost(gmail, 'icloud')).toEqual({
      imapHost: 'imap.mail.me.com',
      imapPort: '993',
      // The port that carries the other TLS mode, which is the one a stale
      // value would break: 465 left behind Apple's host is a hang.
      smtpHost: 'smtp.mail.me.com',
      smtpPort: '587',
    });
  });

  it('keeps a relay somebody set up, and fills in only the box beside it', () => {
    const relay: MailFields = {
      imapHost: '',
      imapPort: '',
      smtpHost: 'email-smtp.eu-west-1.amazonaws.com',
      smtpPort: '2587',
    };
    expect(applyHost(relay, 'gmail')).toEqual({
      imapHost: 'imap.gmail.com',
      imapPort: '993',
      smtpHost: 'email-smtp.eu-west-1.amazonaws.com',
      smtpPort: '2587',
    });
  });

  it('clears what it filled in when the answer is “something else”', () => {
    expect(applyHost(applyHost(EMPTY, 'qq'), OTHER_HOST)).toEqual(EMPTY);
  });

  it('leaves a company’s own server alone when the answer is “something else”', () => {
    const own: MailFields = {
      imapHost: 'mail.acme.internal',
      imapPort: '993',
      smtpHost: 'mail.acme.internal',
      smtpPort: '465',
    };
    // The ports go, because 993 and 465 are answers this menu gives; the two
    // hostnames are not, and stay. Blunt on purpose — see `applyHost`.
    expect(applyHost(own, OTHER_HOST)).toMatchObject({
      imapHost: 'mail.acme.internal',
      smtpHost: 'mail.acme.internal',
    });
  });

  it('lets the typed address move the menu only while the menu owns the boxes', () => {
    expect(menuOwns(EMPTY)).toBe(true);
    expect(menuOwns(applyHost(EMPTY, 'netease-163'))).toBe(true);
    expect(menuOwns({ ...EMPTY, imapHost: 'mail.acme.internal' })).toBe(false);
    expect(menuOwns({ ...EMPTY, smtpPort: '2587' })).toBe(false);
  });
});
