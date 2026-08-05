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

> Status: v0.1 in progress. The AI layer, the mail layer, thread trimming and
> JSON recovery are done and tested. The review UI and the rules engine are
> still being ported from the private original. Not yet usable end to end.

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

AGPL-3.0-or-later. Self-host it freely, modify it freely; if you run a modified
version as a network service, share those modifications.
