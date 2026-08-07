# Approve & Send

**AI drafts it. You approve it. Every edit teaches it.**

Most "AI email assistant" projects stop at the draft. Approve & Send's point is
the loop after it: when you edit a draft before sending, the system compares the
two versions, works out what principle the change implies, and turns that into a
rule the drafter follows next time.

![The review screen: what the model understood, the draft you can edit, and the box that turns your edit into a rule](docs/images/review.png)

> **Status: v0.1.** Complete end to end — fetch, draft, review, send, learn —
> and running in production nowhere. The private tool it was extracted from has
> handled 929 emails and learned 213 rules; this rewrite has been run by nobody
> but its author.

## Why it exists

Support inboxes are where a small team's time goes. Full automation is not
acceptable — a wrong refund answer costs more than the time it saved — but
"human writes every reply from scratch" doesn't scale either. Human-in-the-loop
with a learning curve is the middle path, and it needs to be self-hosted,
because this data is your customer correspondence.

## How it learns

When you edit a draft before sending it, that edit is the lesson. Approve & Send
diffs the two versions, asks a model what principle the change implies, and
stores it as a rule that goes into every future draft:

```
draft:  "I'm so sorry. Your refund will arrive within 3 days."
sent:   "We've escalated this and will update you shortly."
learned: "Never commit to a refund date that has not been confirmed."  [policy]
```

![The rulebook: each rule shows the conversation that taught it and how often it has been used](docs/images/rules.png)

Rules are inspectable, editable and switch-off-able. Each one records which
conversation taught it, why, and how often it has been used — so when a rule
starts producing bad replies you can find out where it came from instead of
guessing. Near-duplicates are merged rather than accumulated, and every change
to a rule's text keeps the previous version.

Approving a draft unchanged usually teaches nothing, and the extractor is told
so. The rulebook is meant to stay small enough to read.

**Throwing a draft away also teaches**, if you say why. Dismissing a task with a
reason in the box learns from your sentence rather than from a diff — the model
is told to take you at your word and is explicitly *not* asked whether the
rejection was fair. Two guards keep this from filling the rulebook with noise: a
vague reason ("wrong tone") is told to propose nothing, and a routing decision
("this one needs a human") is not a rule. Amendments are common here, because a
draft that broke a rule the rulebook already contains means the rule was not
stated firmly enough. Bulk dismiss carries no reason, and so teaches nothing.

Extraction runs in the background — clicking Send never waits on a model — on a
job queue that is one SQLite table, because "self-hosted" should not mean "also
run Redis".

There is a second model in the path too: before any human sees a draft, a critic
reads it against the same rules and either signs it off or rewrites it. It
catches the expensive failure, which is a reply that reads perfectly well and
quietly breaks a policy.

## What reaches you, and what doesn't

Not every message deserves a draft, and a queue that shows you all of them is a
queue you stop reading.

**Bulk mail is filtered by its headers, not by a classifier.** Six checks, in
order: a `List-Unsubscribe` header, an `Auto-Submitted` that isn't `no`, a
`Precedence` of bulk/list/junk, an `X-Auto-Response-Suppress`, an empty
`Return-Path`, and finally a From address like `no-reply@` or `mailer-daemon@`.
No model call, no scoring, nothing to tune — the sender told us in the envelope.

Filtered mail still becomes a task. It arrives dismissed with the reason written
on it, because a desk that suspects the software is eating customer mail should
be able to go and look instead of taking our word for it. What it saves is the
thread fetch and the model calls, which is where the money was.

**A follow-up retires the draft it overtook.** When a second message lands on a
thread that already has an unanswered task, the older one is dismissed and
linked to the newer, with a banner at the top saying so. Sent tasks are never
touched: no later message unsends a mail already sitting in somebody's inbox.
Mail somebody on your team already replied to by hand is skipped on the way in.

**Every draft is graded before you see it.** Not by a model — by arithmetic over
things already known, so it costs nothing and can name its reasons: the critic
refused to sign it off, the customer is angry or unhappy, no rule covered this
one, the thread is four messages deep, or the drafter thinks this is a real bug
on our side. Any of the first two makes it *Needs care*; anything else makes it
*Worth a look*; nothing makes it *Routine* and it wears no badge at all. The
inbox shows only the highest tier, because a queue where every row has a badge
is a queue with no badges.

**A dot means you have not opened it.** Only on drafts waiting for review —
everything pending is unread by definition — and it comes back when the machine
rewrites the draft, because a task that stayed "read" through a rewrite is one
nobody is told to go back to.

## On the review screen

The draft is the middle of the page. Around it:

**What it understood** — language, sentiment, what the message is about, and
where the fault lies. That last one is a ladder the drafter is told to walk down
and stop at the first rung that fits: our bug, a limit we know about, easy to
get wrong, something they did, nothing broken. It is for whoever reads the
reply, never for the reply — the customer is never told whose fault it was — and
it exists because a desk that assumes user error is a desk where real bugs go
unreported for weeks.

**Other ways to answer** — press *Ask for options* and the drafter returns up to
three alternative replies, each with a one-line strategy. They are labelled A, B,
C positionally and carry no ranking. *Use this* moves one into the draft box and
keeps both versions in the history. Picking an option teaches nothing by itself;
what you then edit and send does.

**The history** — nine things get recorded against a task: received, drafted,
edited, redraft, dismissed, reopened, sent, failed, superseded. Who did it, when,
and what they said. Recording is best-effort and never fails the thing it is
recording; a history that can break a send is worse than no history.

**Everything from this address** — `/senders/someone@example.com`, one
correspondent's whole file, chronological, every status. The context card already
tells the model "we have replied to them 3 times before"; this is for the
reviewer who has read that and now needs to know *what we said*, which is usually
the moment before they catch a reply about to contradict one.

**Screenshots, shown.** "Here is what I'm seeing" is a whole genre of support
email and it arrives as an inline image. Pictures are rendered on the page — PNG,
JPEG, GIF and WebP, the formats that decode to pixels and nothing else.
Everything else, SVG very much included, stays a download: an SVG is a document
that can carry script, and displaying one a stranger sent inside your own origin
hands them the reviewer's session.

**A file picker**, in the same form as the draft and the Send button, so what
goes out is what is on screen. Nothing is stored on our side — the Sent folder is
already keeping the copy — but the filenames go on the task's history, because
"why does this customer have our invoice" is a question about the desk and only
the audit trail can answer it. 15 MB per reply, checked before the send.

## Starting from your Sent folder

A fresh install knows nothing, which means the first few weeks are the ones
where it is least useful. Your Sent folder already contains the answers, so
there is a screen — **Archive**, at `/backfill` — that reads them.

It cannot learn the way the review loop does, because an archived reply has no
draft to diff against. So it makes one: for each old reply it drafts what the
assistant *would* write today, compares that against what you actually sent, and
keeps only what the difference teaches. Where the current rulebook already gets
it right the two agree and nothing is learned, which means the run gets cheaper
and quieter as it goes.

```bash
# Archive → look back 12 months, at most 200 replies → Scan
```

Nothing is sent, nothing is written to your mailbox, and every rule it produces
appears in the rulebook with the conversation behind it, to keep or retire like
any other. It is a background job at the lowest priority, so it never delays
today's mail; budget two or three model calls per archived email. Stop halts what
has not started; work already in flight finishes.

## Moving in from something else

If you are replacing a desk you already had, `/api/import/legacy` reads its
SQLite file directly — answered conversations become tasks marked sent, with
their threads, and its rulebook comes across matched on rule text rather than on
ids, so running it twice imports nothing twice:

```bash
# In the environment, for the duration of the import and no longer:
#   AAS_IMPORT_ROOT=/srv/old/data
curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST localhost:3000/api/import/legacy \
  -d '{"path":"/srv/old/data/tasks.db","messagePrefix":"4243...0002"}'
```

The endpoint answers 403 until `AAS_IMPORT_ROOT` names a directory, and refuses
any path that resolves outside it. Without that, a body field would be a request
to open an arbitrary file on the host as SQLite; take it back out once the
import has run.

Two details that matter. The old reply is stored as the draft **only if** its
history shows nobody edited it — otherwise the learning loop would read a human's
rewrite as a machine draft nobody changed, and learn the opposite of the lesson.
And `messagePrefix` is what lets the importer reconstruct provider message ids;
without it the import still works, the response warns you, and your next sync
will re-ingest all that answered mail as new tasks.

A database snapshot is taken before the first write. The same mechanism guards
the weekly rules tidy, which keeps the last five.

## Writing mail nobody asked for

**Compose** — `/compose` — takes an address, an optional subject and a brief in
whatever words you have ("tell them the migration is done, apologise for the
week it took"), and drafts from it using the same rulebook, the same persona and
the same context lookups as a reply. It lands as an ordinary task at the review
screen.

There is no Send button on the compose page. Drafting and approving are separate
acts here, and a screen that could do both would make outbound mail the one thing
in this product that goes out without a second look.

The critic does not run on composed mail and the attention grade does not apply:
there is no customer sentiment to read and no thread to be long. A subject you
typed is never overruled; one you left blank is filled in by the model.

## What it doesn't do

Being clear about this early saves you an evening:

- **One mailbox.** Named operators can sign in separately and the history says
  who sent what, but there is one inbox and one rulebook, and the rulebook
  learns from everybody at once.
- **No routing, assignment, tagging or SLAs.** It is not a helpdesk and won't
  become one. If you need queues per agent, use a helpdesk.
- **No bulk send.** Dismiss, reopen and delete act on a selection; approving
  never will. A hundred replies approved without reading them is not a feature,
  it is the failure this product exists to prevent.
- **No mobile app.** The UI is plain server-rendered forms. They work on a
  phone; they are not designed for one.

## Running it

```bash
npm install
npm run build && npm start      # http://localhost:3000
```

![The inbox: everything waiting on a human, with what the model thinks each one is about](docs/images/inbox.png)

A fresh install opens the setup wizard: **lock the door, pick a model, connect
the mailbox, say who you are.** Only the model is required. Each step ends by
using what you typed — one completion against the model, one login to the
mailbox — and tells you what came back, so a wrong port or a stale key surfaces
there rather than in a failed job at 4am.

It writes `.env` and `aas.config.json`, the same two files you would edit by
hand, and only the keys it asked about; your comments and everything else stay
put. Values take effect immediately — no restart. On a read-only container the
write fails and the page hands you the lines to paste instead. Completion is
read back out of the config rather than from a "you finished the wizard" flag,
so a wizard you skipped and a wizard you did by hand look the same.

Lock the door before you expose the port: either set `ADMIN_PASSWORD` to a shared
password, or create named operators, whose replies then carry their names. Either
one raises the login wall. With neither, there is no wall and every page says so
in red.

Nothing to review yet? The empty inbox has a **Load sample data** button: five
fictional emails and a rulebook, including one reply that was edited before
sending and the two rules that edit taught. It refuses to touch a database that
already has anything in it.

Four endpoints drive it from cron:

```cron
*/5 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sync
*/2 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/worker
17  * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sweep
30 4 * * 1  curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/consolidate
```

`/api/sync` pulls the inbox into tasks, `/api/worker` drains a batch of jobs,
and `/api/consolidate` is the weekly tidy — it merges rules that have drifted
into saying the same thing. `/api/sweep` is the one you will forget you have:
it finds emails whose drafting job died without saying so, which otherwise sit
in the database looking like nothing at all. Twenty minutes of silence counts as
died; it either requeues the task or marks it failed with the error the job left
behind. All four have buttons in the UI too, so you can run without a scheduler
while you are trying it out.

There is also `/api/health`, which is unauthenticated on purpose so an
orchestrator can use it, and answers 503 when the database does not.

The **Queue** screen is the one to open when something has not happened. It lists
the last fifty jobs with their attempts and their errors, and gives each row the
one control its state deserves: retry a failed job, unstick one that has been
processing since a crash, delete one that should never have been queued. Deleting
asks for no confirmation — the job is a note to do something, not the something.

The whole UI is plain forms — it works with JavaScript off, and a half-written
draft survives a reload because it was posted rather than kept in component
state. That includes acting on several tasks at once: the checkboxes and the
bulk bar are one `<form>`, with no client-side JavaScript anywhere in them.

Reopening is the way back from any status except sent. If a draft is still there
you get it back with no model call; if not, it is queued for a fresh one. Sent is
the one door that does not open again, everywhere in the product.

## Bring your own model

One `AI_MODEL` line is the whole setup for the simple case:

```bash
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://localhost:11434/v1   # Ollama, LM Studio, vLLM, llama.cpp…
AI_API_KEY=                             # empty is fine locally
AI_MODEL=qwen2.5:14b
```

Anything speaking the OpenAI chat-completions API works — OpenAI, OpenRouter,
Groq, DeepSeek, Together, your own gateway. `AI_PROVIDER=anthropic` speaks
`/v1/messages` natively.

Four roles (`drafter`, `critic`, `translator`, `utility`) each fall back to
`AI_MODEL` but can point somewhere else. Putting the drafter on a strong model
and the utility work on a cheap one is where most of the cost saving is:

```bash
AI_MODEL=gpt-4o-mini
AI_MODEL_DRAFTER=claude-sonnet-5
```

See [`.env.example`](.env.example) for every variable the code actually reads.

## Bring your own mailbox

IMAP and SMTP, so any mailbox works — Gmail, Zoho, Fastmail, your own Dovecot:

```bash
MAIL_USER=support@yourcompany.com
MAIL_PASSWORD=an-app-password
IMAP_HOST=imap.yourcompany.com
SMTP_HOST=smtp.yourcompany.com
```

Ports default to 993/465 with implicit TLS, and setting `SMTP_PORT=587`
switches to STARTTLS on its own.

Gmail, Google Workspace and Zoho can go through their own APIs instead
(`MAIL_PROVIDER=gmail` or `zoho`), which gets you real threads and no app
password — worth it for Zoho in particular, where IMAP is off until an admin
turns it on. See [docs/mailboxes.md](docs/mailboxes.md).

## Tell it who it is

Copy `aas.config.example.json` to `aas.config.json`. This is the whole persona —
no prompt files to edit:

```json
{
  "organization": "Acme",
  "voice": "Warm, direct and specific. No filler apologies.",
  "facts": ["Refunds are processed within 5-10 business days."],
  "neverPromise": ["refund dates that have not been confirmed"],
  "signature": "— The Acme team",
  "replyLanguage": "match"
}
```

`facts` are the things the model would otherwise invent. Keep the list short and
load-bearing — it goes into every draft. `replyLanguage: "match"` answers in
whatever language the customer wrote in.

## Approving mail you can't read

Add `"reviewLanguage": "Chinese"` and every message and every draft is also
rendered into *your* language beside the original — never sent to anyone. The
whole claim of this product is that a person read it before it went out, and a
reviewer approving a Japanese reply they cannot read has not read it.

A translation is tied to a SHA-256 of the exact text it was made from, so a
redrafted reply shows **no** translation rather than the previous draft's — the
one failure a reviewer in this position could never catch themselves. Empty is
the default and turns the whole thing off: no job, no model call, nothing on
screen. [docs/review-language.md](docs/review-language.md).

## Three languages, and they are all different

`"language": "zh-CN"` translates the interface — the buttons, the labels, the
setup wizard. English, 简体中文, 日本語, Español, Français and Deutsch ship;
pick one on the last setup screen or set `AAS_LANGUAGE`.

That is the third language here, and none of the three implies the others. A
team in Tokyo can run the UI in Japanese, read drafts in Japanese, and still
answer a German customer in German:

```
language        zh-CN     what the buttons say
reviewLanguage  Japanese  what the reviewer reads beside each email
replyLanguage   match     what the customer gets
```

There is no i18n framework and no `Accept-Language` sniffing. A support desk is
a room of people who share a language, and a UI that reshapes per laptop makes
"the second field on the mailbox screen" impossible to say out loud to a
colleague. Adding a language is one file in `src/lib/i18n/`, and TypeScript
refuses to build if it misses a key.

## Tell it who it's writing to

"Have you tried logging out?" to someone whose subscription lapsed yesterday is
worse than no reply at all, and the model cannot know that from the email. A
**context source** is a read-only lookup that turns the sender's address into a
few facts — a card above the draft, and a sentence in the prompt.

Stripe is built in. Set `STRIPE_API_KEY` to a restricted read key and drafts
start knowing who is paying you:

```
No active subscription — the most recent one is canceled, last period ended
2026-01-14. Do not talk to them as a current subscriber.
```

The card links through to `/billing/someone@example.com`, which lists every
charge: what was taken, what came back, and what is left. That page exists
because the card is a summary and the question that follows a billing summary is
never the total — it is *which* payment and how much of it has already been
refunded. Answering that from a total is how a desk refunds the same charge
twice. A half-refunded charge is called partially refunded on the page and in the
prompt, because Stripe's own `refunded` flag only turns true on a full refund,
and reading it alone is how somebody gets told "we have not refunded you" while
holding half a refund. Nothing on that page can move money; the link to Stripe's
own dashboard is right at the top.

**Earlier conversations** are built in too, and need nothing at all: how many
times you have written to this person, when, what about, and whether your
drafts for them usually get rewritten before they go.

Anything else is config, not code — a URL or a command, plus which fields
matter and what they mean:

```json
{
  "contextSources": [
    {
      "id": "product",
      "url": "https://admin.example.com/api/support/lookup?email={email}",
      "headers": { "Authorization": "Bearer ${PRODUCT_TOKEN}" },
      "title": "Product account",
      "fields": [{ "label": "Plan", "path": "level", "map": { "0": "Free", "2": "Unlimited" } }],
      "prompt": ["They have {credits} credits left, expiring {expiry}."]
    }
  ]
}
```

A sentence whose facts are missing is dropped whole rather than rendered with a
hole in it, which is why that format needs no conditionals. When the mapping
isn't enough, a source can still be an ESM module you point at by path.

A lookup too slow to hold a job open — a scrape behind a login, a report that
takes four minutes, a colleague answering in Slack — can post its answer back
instead, and the card appears the next time the screen is loaded:

```bash
curl -H "Authorization: Bearer $CRON_TOKEN" -XPOST localhost:3000/api/tasks/$id/context \
  -d '{"sourceId":"crm","label":"CRM","title":"Account","prompt":"On the annual plan since 2024."}'
```

What that endpoint will not accept is a draft. Its predecessor had one that let
an outside process write the reply text directly, straight past the version
history and the audit trail. A machine token is for adding facts; deciding what
to say with them stays where it can be traced.

Two rules hold everywhere: a source **cannot act** — there is no `refund()` and
there will not be one — and a source writes its **own prose** rather than
handing back a blob for the prompt to `JSON.stringify`. A source that breaks
never stops the mail; drafting is queued even when every lookup failed. Full
interface and worked example in
[docs/context-sources.md](docs/context-sources.md).

## Deploying

```bash
cp .env.example .env
cp aas.config.example.json aas.config.json
docker compose up -d --build
```

That is the whole thing: the app on `127.0.0.1:3000`, and a second container
that pokes the endpoints on schedule so you do not need cron. The database
is `./data/aas.db` on the host — back up that directory and you have backed up
everything.

Approve & Send needs two things from a host: **a writable disk** and **a process
that stays running**. A $5 VPS has both; so do Fly with a volume, Railway,
Render, Coolify, or the spare machine under your desk. Vercel has neither, and
Postgres would not fix it — the long version is in
[docs/deploying.md](docs/deploying.md), along with the reverse-proxy note you
should read before this is reachable from anywhere but localhost.

## Design notes worth knowing

Three things in here were learned the expensive way:

- **`node:http`, not `fetch()`.** undici enforces a 300s `headersTimeout` that
  `AbortSignal` cannot extend. A local model taking six minutes surfaces as a
  bare `fetch failed` with no explanation. `src/lib/ai/http.ts` sidesteps it.
- **Thread trimming is not an optimisation.** One real 1.4 MB thread failed
  *every* generation at 60-80s. Stripping HTML and keeping the newest four
  messages took that prompt from 1237 KB to 26 KB and it succeeded in 30s.
  `src/lib/thread-context.ts`.
- **Repair the JSON, don't retry the call.** Models fence their output and
  forget to escape quotes inside strings. A three-minute regeneration to fix a
  missing backslash is a bad trade. `src/lib/json-repair.ts`.

## Development

```bash
npm install
npm run typecheck
npm test
```

The AI tests run against a real local HTTP server rather than a mocked client,
so wire format, headers, retry behaviour and timeouts are actually exercised.

## License

MIT. Use it, change it, ship it, sell it.
