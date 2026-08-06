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

Extraction runs in the background — clicking Send never waits on a model — on a
job queue that is one SQLite table, because "self-hosted" should not mean "also
run Redis".

There is a second model in the path too: before any human sees a draft, a critic
reads it against the same rules and either signs it off or rewrites it. It
catches the expensive failure, which is a reply that reads perfectly well and
quietly breaks a policy.

## Starting from your Sent folder

A fresh install knows nothing, which means the first few weeks are the ones
where it is least useful. Your Sent folder already contains the answers, so
there is a screen — **Archive** — that reads them.

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
today's mail; budget two or three model calls per archived email.

## What it doesn't do

Being clear about this early saves you an evening:

- **One mailbox, one user.** One password, one signed cookie, no accounts. Two
  people can share the login; the rulebook cannot tell them apart.
- **No routing, assignment, tagging or SLAs.** It is not a helpdesk and won't
  become one. If you need queues per agent, use a helpdesk.
- **No inbound classification beyond drafting.** Every unanswered thread becomes
  a task; there is no spam triage layer in front of it.
- **No mobile app.** The UI is plain server-rendered forms. They work on a
  phone; they are not designed for one.

## Running it

```bash
npm install
npm run build && npm start      # http://localhost:3000
```

![The inbox: everything waiting on a human, with what the model thinks each one is about](docs/images/inbox.png)

A fresh install opens the setup wizard: password, model, mailbox, voice. Each
step ends by using what you typed — one completion against the model, one login
to the mailbox — and tells you what came back, so a wrong port or a stale key
surfaces there rather than in a failed job at 4am.

It writes `.env` and `aas.config.json`, the same two files you would edit by
hand, and only the keys it asked about; your comments and everything else stay
put. Values take effect immediately — no restart. On a read-only container the
write fails and the page hands you the lines to paste instead.

Set `ADMIN_PASSWORD` before you expose the port. Leaving it unset disables the
login wall and every page says so in red.

Nothing to review yet? The empty inbox has a **Load sample data** button: five
fictional emails and a rulebook, including one reply that was edited before
sending and the two rules that edit taught. It refuses to touch a database that
already has anything in it.

Three endpoints drive it from cron:

```cron
*/5 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sync
*/2 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/worker
30 4 * * 1  curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/consolidate
```

`/api/sync` pulls the inbox into tasks, `/api/worker` drains a batch of jobs,
and `/api/consolidate` is the weekly tidy — it merges rules that have drifted
into saying the same thing. All three have buttons in the UI too, so you can run
without a scheduler while you are trying it out.

The whole UI is plain forms — it works with JavaScript off, and a half-written
draft survives a reload because it was posted rather than kept in component
state.

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
switches to STARTTLS on its own. Gmail and Google Workspace can go through the
Gmail API instead, which gets you real threads and no app password — see
[docs/mailboxes.md](docs/mailboxes.md).

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
that pokes the three endpoints on schedule so you do not need cron. The database
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
