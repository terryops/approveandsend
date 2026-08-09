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
the published port. Same endpoints, one less container — see below.

## Nothing runs on its own

There is no scheduler inside this app, deliberately: a timer in a web process
stops when the process is recycled and says nothing about it. Four endpoints do
everything that happens without a person, and something outside has to call
them.

```cron
CRON_TOKEN=your-token-here

*/5 * * * * curl -fsS -m 300 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sync
*/2 * * * * curl -fsS -m 300 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/worker
17  * * * * curl -fsS -m 300 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sweep
30 4 * * 1  curl -fsS -m 600 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/consolidate
```

The first line is not decoration. cron does not read `.env` — it runs each
command through a shell with the environment the crontab gives it, so without
that assignment `$CRON_TOKEN` expands to nothing and every call comes back 401.
`-f` matters for the same reason: curl exits 0 on a 401, so `-s` alone means
cron has nothing to mail you about and the desk goes quiet without a word.

The settings screen reports when each of the four was last called, so you can
tell a desk that was never wired up from one whose scheduler stopped last
Tuesday. It is under **Running it**, at `/setup?where=running`.

### systemd timers

Worth the extra file on a systemd host: the run is in the journal, and
`Persistent=true` catches up a tick the machine slept through.

```ini
# /etc/systemd/system/aas-sync.service
[Service]
Type=oneshot
EnvironmentFile=/srv/approveandsend/.env
ExecStart=/usr/bin/curl -fsS -m 300 -X POST \
  -H "Authorization: Bearer ${CRON_TOKEN}" http://127.0.0.1:3000/api/sync

# /etc/systemd/system/aas-sync.timer
[Timer]
OnCalendar=*:0/5
Persistent=true
[Install]
WantedBy=timers.target
```

`EnvironmentFile` is the part cron cannot do: the token comes from the same
`.env` the app reads, so there is one copy of it rather than two that drift.
Repeat for the other three with their own cadence.

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

## Bringing an archive with you

If you are replacing something, the answered mail in it is worth carrying over.
Not for the record — for the drafting. "We have replied to them three times
before" is the fact a reviewer most reliably has and a model most reliably
lacks, and on the morning of a cutover it is a fact the new database does not
have about anybody.

### The people first

Do this before the import, not after.

Create an operator on the operators page for each person who used the old
system, **named exactly as the old system named them**. The importer signs each
archived conversation with whoever approved it, by name, and matching names are
what turn that into a face on the page rather than a string.

Give them new passwords. Do not carry the old ones across — a system with a
hardcoded user table has those passwords in its git history, on every machine
that ever cloned it, which is the reason they are being left behind. This
project stores a scrypt hash and signs its session cookie; importing a
credential that has been sitting in a source file since February would keep the
one part worth replacing.

### Then the archive

Set `AAS_IMPORT_ROOT` to the directory the old database sits in and restart.
Until it is set the endpoint returns 403 and reads nothing, and once it is set
only paths under that directory are accepted — the alternative is a JSON field
that opens any file on the host as SQLite, on an endpoint that lives forever.
Remove it again when the import is done.

```bash
curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST localhost:3000/api/import/legacy \
  -d '{"path":"/srv/old/data/tasks.db","messagePrefix":"4243000000008002","limit":5}'
```

Start with the `limit` and read what comes back. It checks the path, snapshots,
reads the old file read-only, and brings across two things:

- **The mail**, every row as already sent, matched on message id so a second
  full run adds nothing.
- **The rulebook**, matched on what each rule says, keeping its category and
  keeping the ones somebody had turned off turned off. Summaries are left to
  the indexing job, which is queued once at the end. `"rules": false` skips
  this half.

The rules are the half people forget, and they are the more valuable one.
Answered mail is context. A rule is a decision somebody made after getting a
reply wrong, and there is no way to regenerate it from the mail.

`messagePrefix` is the folder id your mailbox uses. The old desk stored a bare
message id, which cannot be fetched — every read endpoint needs the folder — so
without the prefix nothing is addressable, and the next sync meets a year of
answered conversations it does not recognise and files them as new work. The
response says so when you leave it out.

Watch `addressable` in the response. It is not the same as `imported`: rows
from before the old desk recorded a message id at all go in under a `legacy:`
id, which keeps a re-run idempotent but will never match a synced mail. In the
archive this was written against that was 299 rows of 937.

If you are coming from something else, `src/lib/import/legacy.ts` is the shape
to copy: read rows, `createTask`, `updateTask` to `sent`, `addMessage` per
thread entry.

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
