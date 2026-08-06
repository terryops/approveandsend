# Deploying

Approve & Send needs two things from a host: a writable disk and a process that
stays running. Everything below follows from that.

## Docker

```bash
cp .env.example .env
cp aas.config.example.json aas.config.json
docker compose up -d --build
```

Two containers. `app` listens on `127.0.0.1:3000` and keeps its database at
`./data/aas.db` on the host — back up that directory and you have backed up
everything, rules and correspondence included. `ticker` is a shell loop that
POSTs the three endpoints on schedule, so a host without cron still syncs.

`aas.config.json` is mounted read-only, because a write inside the container
would land on a layer that disappears at the next `docker compose up --build`.
The setup wizard notices, fails cleanly, and hands you the lines to paste into
the file on the host instead.

If your host already runs cron, delete the `ticker` service and point crontab at
the published port. Same endpoints, one less container.

## Put a certificate in front of it

The compose file binds to `127.0.0.1` on purpose. Before this is reachable from
anywhere else, put a reverse proxy with TLS in front — Caddy, nginx, Traefik,
whatever you already run. It will be holding your customer mail and a mailbox
password.

Session cookies are marked `Secure` based on the `X-Forwarded-Proto` header
rather than `NODE_ENV`, so a proxy that sets it correctly gets secure cookies
without any further configuration, and a plain-HTTP LAN install still works.

## Without Docker

```bash
npm ci
npm run build
npm start
```

Run it under whatever supervisor you have — systemd, pm2, a Synology task.
Set `DATABASE_PATH` somewhere durable and back that file up. `npm start` runs a
normal Next.js server; the standalone build the Docker image uses is opt-in
behind `NEXT_STANDALONE=1` and is not what you want here.

## Being told when it changes something by itself

Set `NOTIFY_WEBHOOK_URL` to a Discord or Slack incoming webhook. The text goes
under both `content` and `text`, which is what those two read respectively, so
there is nothing to declare about which one you pointed at.

It is used for exactly one thing today: the weekly tidy, when it actually
merged or rewrote something. That pass runs while nobody is watching and edits
rules a human wrote, and without a message the first anyone knows of a merge is
a reply quoting a policy in words they do not recognise. A "nothing to tidy"
every Sunday would teach people to stop reading the channel, so it does not
send one.

Leave it unset and nothing is posted anywhere.

## Snapshots

The tidy copies the database before it writes, into `snapshots/` next to
`DATABASE_PATH`, keeping the last five. `rule_revisions` already makes any one
rule recoverable; the copy is what makes the *pass* recoverable, which is not
forty button presses but a file.

They are a restore point for one operation, not a backup — the file the tidy
copies is the file you should already be backing up.

## It does not fit Vercel

Worth stating plainly, because it is the first thing people try.

- **Cron.** Vercel Hobby allows *one invocation per day*. `*/5 * * * *` is not
  throttled there, it fails at deploy time. Per-minute schedules need Pro.
- **Disk.** The filesystem is read-only apart from an ephemeral `/tmp` that
  instances do not share. Vercel's own docs say SQLite can't be used.
- **Time.** `AI_TIMEOUT_MS` defaults to fifteen minutes because a self-hosted
  model on modest hardware genuinely takes that long. Vercel caps a function at
  300s on Hobby and 800s on Pro — so bring-your-own-local-model, which is half
  the point of this project, is off the table.
- **The setup wizard** writes `.env`, which cannot work on a read-only
  filesystem, and mirrors values into `process.env`, which does not survive
  across instances. You would configure by dashboard and redeploy.
- **IMAP** over raw TCP to port 993 is undocumented on Vercel. The Gmail API
  path is plain HTTPS and would be fine.

Postgres is sometimes proposed as the fix. It addresses the second bullet and
none of the others, which is why this ships SQLite.

If you want it there anyway, the shape is: Vercel Pro, a hosted Postgres, the
Gmail API rather than IMAP, a hosted model, and configuration by environment
variable only. That is a real deployment. It is just not one this repo goes out
of its way to support.
