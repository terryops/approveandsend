# Mailboxes

Which mode you get is inferred from the variables you set. There is no mode
switch to remember beyond `MAIL_PROVIDER`.

## IMAP and SMTP (the default)

Any mailbox works — Zoho, Fastmail, Migadu, your own Dovecot:

```bash
MAIL_USER=support@yourcompany.com
MAIL_PASSWORD=an-app-password
IMAP_HOST=imap.yourcompany.com
SMTP_HOST=smtp.yourcompany.com
```

Ports default to 993 and 465 with implicit TLS. Setting `SMTP_PORT=587` switches
to STARTTLS on its own — you do not also have to say so.

Sent mail is filed by asking the server which mailbox carries the `\Sent`
special-use flag (RFC 6154), rather than guessing between `Sent`, `Sent Items`
and `[Gmail]/Sent Mail`. A server that publishes no such mailbox falls back to
the literal name `Sent`; set `IMAP_SENT_MAILBOX` if that is wrong for yours.

Use an app password, not your account password, anywhere the provider offers
one.

## Zoho Mail API

```bash
MAIL_PROVIDER=zoho
MAIL_USER=support@yourcompany.com
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
ZOHO_REGION=com          # com | eu | in | com.au | jp | ca
```

Preferred over IMAP for Zoho, because IMAP needs two settings changes that an
admin has to make and that both fail as `Invalid credentials` — IMAP access is
off by default (Mail Settings → Mail Accounts → IMAP), and the account password
is refused in favour of an application-specific one. The API needs neither.

Pick **Zoho Mail API** from the service menu on the mailbox step of the setup
wizard, or set the variables above by hand — they are the same six either way,
and the wizard writes this `.env` rather than a table of its own.

Get the refresh token from [Zoho's API console](https://api-console.zoho.com):
create a Self Client, request the scopes exported as `ZOHO_SCOPES` from
`src/lib/mail/providers/zoho/auth.ts`, and exchange the code once. That last
exchange is the one step no screen here can do for you — the code is valid for
minutes and is issued to a browser session on Zoho's own console. The refresh
token does not rotate, so it is never written back to disk.

`ZOHO_REGION` matters. Zoho's data centres are separate installations that
share no credentials, so a token minted in the wrong one is rejected exactly
like a bad secret. It is the first thing to check when auth fails.

The account id is discovered from `MAIL_USER`; set `ZOHO_ACCOUNT_ID` only if
this account owns several mailboxes and the wrong one is picked. Non-English
mailboxes can name their folders with `ZOHO_INBOX_FOLDER` / `ZOHO_SENT_FOLDER`.

Outgoing attachments are staged in Zoho's own file store first and the reply
carries the handles, so nothing large travels as JSON. The 20 MB per-message
ceiling is checked before anything is uploaded, and a failed upload fails the
send rather than letting the mail go out without its file. Inline images
(`cid:` references) are refused: Zoho embeds those by rewriting the body around
a URL of its own, so honouring them would mean delivering a broken image.

Inline images are the one limit worth knowing before you switch; everything
else this provider does, it does the way the IMAP one does.

## Unread flags

When a task leaves the review queue — sent, or dismissed — the message it came
from is marked read in the mailbox. That keeps unread meaning *nobody has dealt
with this*, which is the only reading under which the mailbox stays useful once
most replies go out from here.

It is best-effort. A mail that went out and a flag that did not clear is
cosmetic, so a failure is logged and otherwise ignored rather than reported to
the reviewer as a failed send.

Opening a task deliberately does not mark it read: reading something is not
handling it, and hiding it from the next person because a colleague glanced at
it is how mail gets dropped.

## Gmail API

For Gmail and Google Workspace this is the better path: replies land in the
right conversation because the API takes a real thread ID, and there is no app
password to create or rotate.

```bash
MAIL_PROVIDER=gmail
MAIL_USER=support@yourcompany.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

The refresh token comes from a one-time OAuth consent for the account in
`MAIL_USER`, over two scopes — `gmail.modify` to read and label, `gmail.send` to
reply. They are exported as `GMAIL_SCOPES` from
`src/lib/mail/providers/google/auth.ts`.

### Workspace service account

If you administer the domain, a service account with domain-wide delegation
avoids the per-mailbox consent dance entirely:

```bash
MAIL_PROVIDER=gmail
GOOGLE_CLIENT_EMAIL=aas@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_IMPERSONATE_USER=support@yourcompany.com
```

Authorise the client ID for both scopes in the Workspace admin console first, or
every call comes back `unauthorized_client`.

Newlines in `GOOGLE_PRIVATE_KEY` may be written as literal `\n`; they are
unescaped on read, so the key fits on one line of `.env`.
