import { type MessageKey } from '../i18n';

/**
 * The mail services somebody is likely to already have, by name.
 *
 * The mailbox form asked for four facts — an IMAP host, its port, an SMTP host,
 * its port — of somebody who wants to connect the Gmail account they have been
 * reading support mail in for two years. All four are the same four for every
 * Gmail on earth, they are written down in a help centre article, and getting
 * one of them wrong fails as "could not connect", which is indistinguishable
 * from a bad password. Four lookups and an afternoon, for facts this file can
 * simply hold.
 *
 * So the form grows a menu of services and this table holds what each one
 * implies. Nothing in `.env` changed shape — the id below is a fact about the
 * menu and is never written — and `hostFor` reads it back off `IMAP_HOST`, so a
 * file written by hand or by an older version still opens on the right line.
 *
 * Every entry here is a service that can be reached with a **password**, which
 * is the only thing the form collects. That rules out two obvious names:
 *
 * - **Outlook.com and Microsoft 365.** Exchange Online turned basic auth off
 *   for IMAP in 2022 and finished retiring SMTP client submission in March
 *   2026; a personal Outlook.com account lost third-party password access in
 *   September 2024. There is no host and port pair that makes those work, so
 *   offering one would be a menu line whose only outcome is "invalid
 *   credentials" and a lost afternoon. OAuth is the route, and this app does
 *   not have it for Microsoft yet.
 * - **Proton Mail.** Its Bridge does speak IMAP, on `127.0.0.1` with a
 *   self-signed certificate and no implicit TLS — which needs `IMAP_SECURE` and
 *   `SMTP_SECURE`, two variables this form deliberately does not have. A preset
 *   that fills in four boxes and still fails on a fifth is worse than no preset.
 *
 * The list is short on purpose and cannot be complete, which is why the last
 * line is a way to type the hosts yourself and the Test button is what says
 * whether they were right.
 *
 * The menu has one more line than this table does — see `ZOHO_API_SERVICE`,
 * which is a way of reaching a mailbox rather than a place to reach it, and so
 * has none of the four facts every entry below carries.
 */

export interface MailHost {
  /** The menu's own value. A fact about this screen; never written to `.env`. */
  id: string;
  /** What the service calls itself — a proper noun, so not in the dictionary. */
  name: string;
  /** For the one entry that is a sentence rather than a name. */
  label?: MessageKey;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  /** 465 is implicit TLS, 587 is STARTTLS; `loadImapSmtpConfig` reads the mode
   *  off the number, so a service that only takes one of them says so here. */
  smtpPort: number;
  /**
   * The address domains this line serves, lowercased.
   *
   * Autofill only: typing `support@qq.com` is a clearer answer to "which
   * service" than the menu is, so the menu follows it. Business mail lives on a
   * company's own domain and will match nothing here, which is why the menu
   * exists as well.
   */
  domains: string[];
}

/** The menu's last line: not on the list, so type it. */
export const OTHER_HOST = 'other';

/**
 * The one menu line that is not a host at all.
 *
 * Zoho is on this menu twice on purpose, and this is the line to pick. The
 * entry below — `imap.zoho.com` and a password — is the route that costs an
 * afternoon: IMAP is off until an admin turns it on (Mail Settings → Mail
 * Accounts → IMAP) and the account password is refused in favour of an
 * application-specific one. Both failures read as `Invalid credentials`, which
 * is also what a typo reads as. The REST API needs neither, and it hands us
 * real server-side threads instead of ones reconstructed from headers.
 *
 * It is deliberately not in `MAIL_HOSTS`: every line of that table is four
 * facts about a host, and this one has no host, no port and no password. What
 * it has is an OAuth client, which is why picking it swaps the form rather than
 * filling it in. See `saveMailbox`, which branches on this value.
 */
export const ZOHO_API_SERVICE = 'zoho-api';

export const MAIL_HOSTS: MailHost[] = [
  {
    id: 'gmail',
    // Google Workspace on a company domain answers on exactly these hosts, so
    // it is this line and not a second one that would differ in nothing.
    name: 'Gmail / Google Workspace',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    domains: ['gmail.com', 'googlemail.com'],
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    // Apple's SMTP is STARTTLS on 587 only; 465 is refused.
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    domains: ['icloud.com', 'me.com', 'mac.com'],
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    domains: ['yahoo.com', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com'],
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 465,
    domains: ['fastmail.com', 'fastmail.fm', 'messagingengine.com'],
  },
  {
    id: 'zoho',
    // The `.com` data centre. Zoho's regions are separate installations on
    // their own hostnames — `imap.zoho.eu`, `.in`, `.com.au`, `.jp` — and a
    // desk on one of those edits the two boxes. Same fact as `ZOHO_REGION` in
    // config.ts, arrived at for the same reason.
    //
    // Kept for a desk that already has an app password working, but the line
    // above it in the menu is the better answer: see `ZOHO_API_SERVICE`.
    name: 'Zoho Mail',
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    domains: ['zoho.com', 'zohomail.com'],
  },
  {
    id: 'yandex',
    name: 'Yandex Mail',
    imapHost: 'imap.yandex.com',
    imapPort: 993,
    smtpHost: 'smtp.yandex.com',
    smtpPort: 465,
    domains: ['yandex.com', 'yandex.ru', 'ya.ru'],
  },
  {
    id: 'qq',
    name: 'QQ Mail',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    domains: ['qq.com', 'vip.qq.com', 'foxmail.com'],
  },
  {
    id: 'exmail',
    // Tencent's business mail, which is a different installation from the QQ
    // above and does not share its hosts.
    name: 'Tencent Exmail',
    imapHost: 'imap.exmail.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.exmail.qq.com',
    smtpPort: 465,
    domains: [],
  },
  {
    id: 'netease-163',
    name: 'NetEase 163',
    imapHost: 'imap.163.com',
    imapPort: 993,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    domains: ['163.com', 'vip.163.com'],
  },
  {
    id: 'netease-126',
    name: 'NetEase 126',
    imapHost: 'imap.126.com',
    imapPort: 993,
    smtpHost: 'smtp.126.com',
    smtpPort: 465,
    domains: ['126.com'],
  },
  {
    id: 'aliyun',
    name: 'Alibaba Mail',
    imapHost: 'imap.qiye.aliyun.com',
    imapPort: 993,
    smtpHost: 'smtp.qiye.aliyun.com',
    smtpPort: 465,
    domains: ['aliyun.com'],
  },
  {
    id: 'sina',
    name: 'Sina Mail',
    imapHost: 'imap.sina.com',
    imapPort: 993,
    smtpHost: 'smtp.sina.com',
    smtpPort: 465,
    domains: ['sina.com', 'sina.cn'],
  },
  {
    // The escape hatch, and the reason none of the above has to be complete: a
    // company's own server, a region this table does not name, a host somebody
    // was handed by their IT department.
    id: OTHER_HOST,
    name: 'Other',
    label: 'setup.mailbox.providerOther',
    imapHost: '',
    imapPort: 0,
    smtpHost: '',
    smtpPort: 0,
    domains: [],
  },
];

/** The menu line with this id, if it is one we still offer. */
export function mailHost(id: string): MailHost | undefined {
  return MAIL_HOSTS.find(entry => entry.id === id);
}

/** Casing is not a difference between two hostnames. */
function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Which line of the menu an existing `.env` is already on.
 *
 * Read off `IMAP_HOST` alone. A desk that reads Gmail over IMAP and sends
 * through a relay — SES, Postmark — is still on the Gmail line as far as the
 * menu is concerned, and its own SMTP host stays in the box beside it, because
 * the alternative is throwing somebody's deliberate arrangement onto "other"
 * and blanking nothing they can see. A host we do not recognise is not an
 * error; it is a company's own server, and it lands on the last line with both
 * hosts still in front of it.
 */
export function hostFor(imapHost: string): string {
  if (!imapHost.trim()) return OTHER_HOST;
  return MAIL_HOSTS.find(entry => entry.imapHost && sameHost(entry.imapHost, imapHost))?.id ?? OTHER_HOST;
}

/**
 * Which line the desk is on, from both halves of what decides it.
 *
 * `hostFor` alone is the right question for every line but one. A desk on the
 * Zoho API has no `IMAP_HOST` to read it off, so it would open on "something
 * else" above four empty boxes — the menu disowning a mailbox that is working.
 * `MAIL_PROVIDER` is asked first because it is the more specific fact: hosts
 * left behind by a desk that has since switched are history, not configuration,
 * and they stay in the file exactly so that switching back costs nothing.
 */
export function serviceFor(provider: string, imapHost: string): string {
  if (provider.trim().toLowerCase() === 'zoho') return ZOHO_API_SERVICE;
  return hostFor(imapHost);
}

/**
 * Which line a typed address implies, or null when its domain is nobody's.
 *
 * The overwhelmingly common case for a support desk is the second one — mail
 * for `support@yourcompany.com` — so this answers for the personal-domain
 * mailboxes where it can and stays out of the way where it cannot.
 */
export function hostForAddress(address: string): string | null {
  const domain = address.trim().toLowerCase().split('@')[1];
  if (!domain) return null;
  return MAIL_HOSTS.find(entry => entry.domains.includes(domain))?.id ?? null;
}

/** The four boxes, as a form holds them: text, because that is what a box is. */
export interface MailFields {
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
}

/** Everything this menu is capable of having written, one bag per box. */
const bag = (pick: (entry: MailHost) => string | number) =>
  new Set(
    MAIL_HOSTS.map(entry => String(pick(entry)).toLowerCase()).filter(
      value => value && value !== '0',
    ),
  );
const IMAP_HOSTS = bag(entry => entry.imapHost);
const SMTP_HOSTS = bag(entry => entry.smtpHost);
const PORTS = new Set([...bag(entry => entry.imapPort), ...bag(entry => entry.smtpPort)]);

/** True while a box is still the menu's to fill: empty, or its own last answer. */
function ours(value: string, known: Set<string>): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' || known.has(trimmed);
}

/**
 * Whether the menu still owns all four boxes.
 *
 * What gates the address autofill. Somebody who typed their company's own IMAP
 * host and then fixed a typo in the address beside it is not asking for those
 * hosts to be replaced by Gmail's — and a menu reading "Gmail" over hosts that
 * are not Gmail's is a worse lie than a menu that simply did not move.
 */
export function menuOwns(fields: MailFields): boolean {
  return (
    ours(fields.imapHost, IMAP_HOSTS) &&
    ours(fields.smtpHost, SMTP_HOSTS) &&
    ours(fields.imapPort, PORTS) &&
    ours(fields.smtpPort, PORTS)
  );
}

/**
 * The four boxes after picking a service, given what they hold now.
 *
 * The blunt rule the model screen arrived at, one step later in the wizard: a
 * field is rewritten only when it is empty or still holds an answer this menu
 * itself put there. So a desk reading Gmail over IMAP and sending through a
 * relay keeps its relay when somebody opens the menu, changing your mind twice
 * follows you, and the last line — which knows no hosts — clears what the menu
 * filled in without touching what you typed.
 */
export function applyHost(fields: MailFields, id: string): MailFields {
  const line = mailHost(id);
  const port = (value: number | undefined) => (value ? String(value) : '');

  return {
    imapHost: ours(fields.imapHost, IMAP_HOSTS) ? (line?.imapHost ?? '') : fields.imapHost,
    smtpHost: ours(fields.smtpHost, SMTP_HOSTS) ? (line?.smtpHost ?? '') : fields.smtpHost,
    imapPort: ours(fields.imapPort, PORTS) ? port(line?.imapPort) : fields.imapPort,
    smtpPort: ours(fields.smtpPort, PORTS) ? port(line?.smtpPort) : fields.smtpPort,
  };
}
