# Design notes

A record of the decisions behind ReplyLoop, mostly so that future-me stops
re-litigating them. Written while extracting a working private system into a
public one.

## Where this came from

The original is a single-tenant support-review portal built for one company.
It works — 929 emails processed, 137 human revisions, 213 learned rules — but
it is welded to that company: 35 of its 77 source files carry hardcoded
business facts, 52 contain Chinese-only UI text, and the AI personas, the
pricing knowledge and an admin-panel scraper are all inline.

Sanitising that in place was considered and rejected. Every commit in its
history contains customer email, plaintext passwords and a live API token, so
the repo could never be published as-is anyway; a fresh repo with selected,
rewritten files is both safer and less work.

## Scope for v0.1

Deliberately narrow. Not "an AI email platform" — *AI-drafted customer support
replies with a human approving each one and the system learning from the edit*.

In:

- Bring-your-own model, per role
- Project/persona configuration instead of hardcoded business facts
- IMAP + SMTP
- The review UI and the learning loop

Out, for now:

- Multi-tenant anything. Single team, self-hosted.
- A user-management admin backend. `ADMIN_PASSWORD` in the environment is
  enough for one team, and the wrong auth model is expensive to undo.
- Localisation. English only; translation of *drafts* is a feature, but the UI
  stays in one language until someone asks.

## AI layer

**One interface, two wire formats.** `AiProvider` has a single `complete()`
method. `openai-compatible` covers OpenAI, OpenRouter, Groq, DeepSeek,
Together, vLLM, Ollama, LM Studio and llama.cpp; `anthropic` exists because
`/v1/messages` differs enough (`x-api-key`, top-level `system`, mandatory
`max_tokens`, 529-means-overloaded) that faking it through a shim is worse than
writing forty lines.

**Roles, not call sites.** `drafter`, `critic`, `translator`, `utility`. Each
resolves `AI_MODEL_<ROLE>` then falls back to `AI_MODEL`, with per-role
temperature and token defaults. This is the cheapest lever there is: a strong
drafter and a cheap utility model is most of the cost difference, and it takes
one env line.

**`node:http`, not `fetch()`.** undici enforces a 300s `headersTimeout` that no
`AbortSignal` can extend. Long generations therefore die at exactly five
minutes with a bare `fetch failed` and no cause. This cost a day to diagnose in
the original; `src/lib/ai/http.ts` exists solely to avoid it.

**The provider decides what is transient.** Only the provider knows what its
own 4xx bodies mean, so `AiError.transient` is set there rather than sniffed by
a shared retry helper. Retried: 429, 5xx, network failures, unparseable bodies,
and a 200 carrying an empty completion. Not retried: 400 — that means our
request is malformed and three more attempts will not fix it.

**Empty completions are failures.** The original had a provider-specific check
for a particular gateway's "No response from …" string. Generalised: an empty
or whitespace-only completion is a transient error regardless of provider.
Silently returning `''` produces an empty draft that looks like a model
opinion.

## Prompt size

The 1.4 MB thread deserves its own note. Every generation on it failed at
60-80s with `fetch failed`, reproducibly, while a 25 KB email succeeded in 35s.
The cause was the naive thread builder concatenating raw HTML for all ten
messages.

`thread-context.ts` strips HTML to text, keeps the newest four messages, and
caps per-message and total length. On that thread: 1237 KB → 26 KB, and the
generation completed in 30s. Worst case across the whole database: 1237 KB →
44 KB.

`clip()` keeps the **tail**, not the head. In quoted email the newest content
is at the bottom; truncating from the end throws away the part that matters.

## JSON

Models fence their output in markdown and forget to escape quotes inside string
values. `extractJson` tries plain parse → outermost `{...}` → the same with
quotes repaired, and returns `null` rather than throwing. Given a generation
can take minutes, repairing a missing backslash beats re-running the call.

## Licensing

AGPL-3.0-or-later. Self-hosting, modification and internal use are unrestricted;
running a modified version as a public service requires publishing those
modifications. This keeps a hosted-SaaS fork honest while leaving the door open
to sell exceptions later. Relicensing to something more permissive later is
easy; the reverse is not, once there are outside contributors.

## Open questions

- Is the learning loop portable, or does its quality depend on the volume of
  one specific inbox? Unknown until someone else runs it.
- Custom data lookups (the original scrapes an internal admin panel to enrich a
  customer record) are planned as configurable HTTP calls rather than a plugin
  system. Simpler, and no code execution surface. Not yet built.
