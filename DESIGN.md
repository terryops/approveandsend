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

## Mail layer

**IMAP + SMTP first, not a hosted API.** It works with every mailbox, including
the self-hosted ones that the people most interested in self-hosting this
already run. Gmail/Zoho/Outlook APIs are nicer to consume but each is a
separate OAuth setup, and shipping one of them first would bias the interface
toward whatever that one happens to do. (Gmail came second, deliberately — see
below.)

**The interface is shaped by what IMAP lacks, not by what an API provides.**
Hosted APIs hand you a `threadId`; IMAP does not. So `threadId` is optional,
every message carries `messageIdHeader` / `inReplyTo` / `references`, and
`threading.ts` rebuilds conversations from those when the server won't.

**The subject fallback is the dangerous part.** Matching on subject alone
merges two customers who both wrote "Invoice" into one thread — and one
customer's mail then ends up in a prompt about the other. Two guards: the
messages must share a participant, and a server-side `threadId` always wins
over a subject guess. The second guard was added after a test caught months of
separate tickets with one recurring subject collapsing into a single thread.

**IDs encode UIDVALIDITY.** An IMAP UID is unique only within a mailbox, and
the server may renumber a mailbox at any time. `mailbox:uidvalidity:uid` means
a stale id throws "re-sync required" instead of quietly fetching a different
customer's email.

**SMTP does not file a copy in Sent** — that has always been the client's job.
Without the explicit `APPEND`, our own replies never appear in threads and the
model happily re-answers questions we already answered. A failed append is
logged rather than thrown: the mail is already delivered at that point, and
raising would invite a duplicate send.

## Gmail, and what a second backend proved

Added straight after IMAP, on purpose: an abstraction with one implementation
is a guess. This one held — `MailProvider` needed no reshaping, and only two
optional fields were added (`OutgoingMail.threadId`, `SendResult.threadId`),
both of which IMAP correctly ignores.

Where the two genuinely differ:

- **Threads are one request.** Gmail knows its own conversations, so
  `getThread` is `GET /threads/{id}?format=raw` and the result is complete.
  The IMAP path fetches a bounded window and reconstructs from headers, which
  can miss an old message. This is the single best argument for the API.
- **Sent files itself.** `messages.send` puts the copy in Sent, so there is no
  `APPEND` and none of the "delivered but not filed" failure mode.
- **Gmail rewrites Message-ID on send.** We read it back from the stored
  message rather than trusting what we composed; a stale id silently breaks
  the threading of the *next* reply, which is the kind of bug that surfaces
  weeks later.
- **`threadId` on send is not optional in practice.** Correct
  `In-Reply-To`/`References` thread properly in every other client, but Gmail
  will still sometimes split the reply into its own conversation without it.

Bodies are fetched as `format=raw` and handed to the same mailparser path IMAP
uses, rather than walking Gmail's MIME-tree JSON. One parser means one set of
edge cases, and attachment ids stay index-based across both backends.

**Two auth modes, inferred not declared.** A refresh token is one mailbox
consented by its owner; a service account with domain-wide delegation can act
as any mailbox in a Workspace domain. A service-account key and a refresh token
look nothing alike, so making the user *also* declare which one they pasted
just adds a field that can disagree with reality. Setting both is an error
rather than a silent precedence rule.

No `googleapis` dependency — tens of megabytes for three endpoints, and the
token exchange is forty lines of `node:crypto`. A 400 from the token endpoint
is not transient: that is a revoked refresh token, and retrying makes it worse.
A 401 from the API *is* worth exactly one retry with a fresh token, because
tokens can be revoked mid-session.

## The learning loop

The part that makes this worth self-hosting. A human approves a reply; if they
edited it first, that edit is a correction, and the difference between the two
versions says what the model got wrong more precisely than any prompt tuning
would have found.

**Show the model both versions and the diff.** The original only ever saw the
final text plus whatever the reviewer typed in a notes box. That learns well
from reviewers who write good notes and learns nothing from the far more common
case — someone silently fixing a sentence and hitting send. `rules/diff.ts`
does a sentence-level LCS and feeds the model the changes alone; unchanged
sentences are already in the prompt as the sent reply, and repeating them
buries the signal. Sentence granularity, not word: a word diff of reflowed
prose is mostly noise about where the newlines moved.

**An unedited draft is usually not a lesson.** The prompt says so explicitly.
Otherwise every approval manufactures a rule and the rulebook fills with
restatements of things the model already does correctly.

**Every id the model returns is checked against what it was shown.** The
predecessor ran a bare `UPDATE … WHERE id = ?` on whatever the extractor
returned, so a hallucinated-but-real id silently overwrote an unrelated rule
with no record of the previous text. Here an unknown id is discarded, a `skip`
naming an unknown rule is downgraded to `add` (honouring it would throw away a
learned rule), and every content change writes a `rule_revisions` row.

### Deduplication

Rules are natural language, so "is this a duplicate?" is a semantic question
and a model answers it better than any distance metric. Two things constrain
it:

- **A local shortlist first.** The original put all 135 enabled rules into the
  dedup prompt for every candidate — an O(all rules) prompt that grows
  precisely because the system is working. `rules/similarity.ts` scores by
  IDF-weighted token overlap and sends the top twelve. It never decides
  anything; it only chooses whom the model considers. An empty shortlist means
  the candidate is genuinely novel and no call is made at all.
- **Scope partitions the comparison.** The same sentence about response times
  is not redundant across two different kinds of mail.

**Fail open.** A dedup call that times out adds the rule anyway. It was learned
from a real human correction; losing it costs more than a near-duplicate, which
a consolidation pass collapses later.

**The candidate pool is mutated in place** during a batch, so two rules
proposed from the same conversation dedupe against each other and not only
against what was in the database when the batch started.

### What the rule block does about growth

Every enabled rule goes into every generation, so an unbounded rulebook
eventually becomes the prompt. `selectRules` caps it at ~6k characters and
drops by category when it bites — policy first, tone last, on the grounds that
a dropped tone rule reads slightly wrong while a dropped policy rule promises a
refund that does not exist. Drops are returned, not swallowed, so the caller
can log them.

Selection is by priority; *emission* is by insertion order. A rule block whose
order shifts between two runs makes their outputs impossible to compare.

**Ordering is by SQLite's rowid, not by `created_at` or id.** Ids are UUIDs and
timestamps have millisecond resolution, so neither orders two rules written in
the same tick. A test caught this immediately.

### Schema choices the original could not make later

`source_task_id`, `rationale`, `applied_count`, `last_applied_at` and `scope`
are all cheap at schema-design time and impossible to backfill. Without
provenance you cannot answer "why does the drafter believe this?", which is the
first question asked when a rule produces a bad reply. Without usage counts
there is no basis on which a rule could ever be retired. Without scope, a rule
learned handling one kind of mail steers every other kind.

Migrations are numbered against `PRAGMA user_version`, each in its own
transaction. The original ran `ALTER TABLE … ADD COLUMN` inside a try/catch on
every request and swallowed the error, which works until a change needs a
backfill or an ordering.

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
