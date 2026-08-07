# Security

## Reporting a vulnerability

Email **security@example.com** with what you found and how to reproduce it.
Please do not open a public issue first: this app holds mailbox credentials and
customer correspondence, and a filed issue is a disclosure.

> Replace the address above with a real inbox before this repository is public.
> A placeholder that nobody reads is worse than no policy at all, because a
> reporter who mails it believes they have told someone.

Expect an acknowledgement within a few working days. If you have not heard
back, assume the mail was lost rather than ignored and send it again.

## What is in scope

Anything that would let someone who is not the operator read a mailbox, send
mail as the operator, or reach the admin UI: authentication and session
handling, the machine-token routes under `/api`, the queue, and the SQLite
database and its backups.

## What is not

Findings that require an attacker who already has the deployment's environment
variables or filesystem. `AI_API_KEY`, `ADMIN_PASSWORD` and the mail
credentials are trusted inputs — anyone holding them is already the operator.

## Running it safely

Set `ADMIN_PASSWORD`. Without it the UI is unauthenticated by design, which is
convenient on a laptop and an open mailbox on a public address; the app says so
in a banner on every page.
