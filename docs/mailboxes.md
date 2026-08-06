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

### Zoho Mail

Zoho needs two things turned on before any of the above works, and neither
failure says so:

```bash
MAIL_USER=support@yourcompany.com
MAIL_PASSWORD=an-application-specific-password
IMAP_HOST=imappro.zoho.com     # imap.zoho.com for a free account
SMTP_HOST=smtp.zoho.com
```

1. **IMAP access is off by default.** Turn it on in Mail Settings → Mail
   Accounts → IMAP. Until you do, every login is rejected as
   `[AUTHENTICATIONFAILED] Invalid credentials`, which sends you hunting for a
   password problem you do not have.
2. **The account password will not work**; generate an application-specific
   password under My Account → Security → App Passwords and use that as
   `MAIL_PASSWORD`.

Zoho's OAuth tokens are for its REST API and are not accepted over IMAP, so
there is no XOAUTH2 shortcut around either step.

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
