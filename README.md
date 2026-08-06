# ReplyLoop

**AI drafts your support replies. A human approves them. Every correction teaches it.**

Most "AI email assistant" projects stop at the draft. ReplyLoop's point is the
loop after it: when a human edits a draft before sending, the system compares
the two versions, extracts what changed and why, and turns that into a rule the
drafter follows next time.

The instance this was extracted from has processed **929 emails**, of which
**137 were revised by a human** — producing **213 learned rules, 135 currently
active**. The drafts get closer to sendable over time, and you can read exactly
why: every rule is inspectable, editable and switch-off-able.

> Status: v0.1. End to end and usable — fetch mail, draft, review, send, learn.
> Still to come before a release: a weekly pass that consolidates the rulebook,
> and demo seed data.

## Why it exists

Support inboxes are where a small team's time goes. Full automation is not
acceptable — a wrong refund answer costs more than the time it saved — but
"human writes every reply from scratch" doesn't scale either. Human-in-the-loop
with a learning curve is the middle path, and it needs to be self-hosted,
because this data is your customer correspondence.

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
switches to STARTTLS on its own. The Sent mailbox is discovered from the
server's `\Sent` flag rather than guessing between "Sent", "Sent Items" and
"[Gmail]/Sent Mail".

Gmail and Google Workspace can go through the Gmail API instead, which gets you
real threads and no app password:

```bash
MAIL_PROVIDER=gmail
MAIL_USER=support@yourcompany.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

For Workspace, a service account with domain-wide delegation works too — set
`GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_IMPERSONATE_USER`
instead. Which mode you get is inferred from the variables you set.

## Tell it who it is

Copy `replyloop.config.example.json` to `replyloop.config.json`. This is the
whole persona — no prompt files to edit:

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

`facts` are the things the model would otherwise invent. Keep the list short
and load-bearing — it goes into every draft. `replyLanguage: "match"` answers
in whatever language the customer wrote in.

A second model then reads each draft against the same rules and either signs it
off or rewrites it, before any human sees it. It catches the expensive failure:
a reply that reads perfectly well and quietly breaks a policy.

## How it learns

When you edit a draft before sending it, that edit is the lesson. ReplyLoop
diffs the two versions, asks a model what principle the change implies, and
stores it as a rule that goes into every future draft:

```
draft:  "I'm so sorry. Your refund will arrive within 3 days."
sent:   "We've escalated this and will update you shortly."
learned: "Never commit to a refund date that has not been confirmed."  [policy]
```

Rules are inspectable, editable and switch-off-able. Each one records which
conversation taught it, why, and how often it has been used — so when a rule
starts producing bad replies you can find out where it came from instead of
guessing. Near-duplicates are merged rather than accumulated, and every change
to a rule's text keeps the previous version.

Approving a draft unchanged usually teaches nothing, and the extractor is told
so. The rulebook is meant to stay small enough to read.

Extraction runs in the background — clicking Send never waits on a model — on a
job queue that is one SQLite table, because "self-hosted" should not mean
"also run Redis".

## Running it

```bash
npm install
cp .env.example .env            # model + mailbox
cp replyloop.config.example.json replyloop.config.json
npm run build && npm start      # http://localhost:3000
```

Set `ADMIN_PASSWORD` before you expose the port. There are no accounts — one
password, one signed cookie. Leaving it unset disables the login wall and every
page says so in red.

Two endpoints drive it from cron:

```cron
*/5 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sync
*/2 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/worker
```

`/api/sync` pulls the inbox into tasks, `/api/worker` drains a batch of jobs.
Both have buttons in the UI too, so you can run without a scheduler while you
are trying it out.

The whole UI is plain forms — it works with JavaScript off, and a half-written
draft survives a reload because it was posted rather than kept in component
state.

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
