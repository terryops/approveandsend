# Design notes

A record of the decisions behind Approve & Send, mostly so that future-me stops
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

## Persona as configuration

This is the whole de-branding story. In the original, the company name, the
pricing, the refund window and the assistant's own name were written into six
prompt strings across four route handlers. Changing "we" meant a code change,
and publishing the code meant publishing the company's internal policy.

`config/workspace.ts` moves all of it into one JSON file with bland defaults,
so a fresh checkout produces a correct, boring support reply rather than
refusing to start. A malformed config file *is* an error, though — falling back
to defaults there would mean a deployment quietly losing its policy facts and
nobody noticing until a draft promised something it should not have.

`neverPromise` earns its place as a separate field rather than another fact:
"do not state this" and "this is true" are different instructions, and models
follow the negative one better when it is labelled as one.

## Drafting

**One call, not two.** The original ran an analysis pass and then a separate
drafting pass over the same email. That doubles the latency and the cost to
produce a draft that can contradict its own analysis. Analysis and draft come
back from one generation as one JSON object.

**The critic pass is a real second opinion, and is optional.** A second model
reads the draft against the same rules and either signs it off or rewrites it.
It is worth its cost because the failure it catches is the expensive one: a
reply that reads perfectly well and quietly breaks a policy. A critic that
approves *and* rewrites is contradicting itself, so the verdict wins and the
rewrite is dropped.

**A failing critic must not lose the draft.** The original failed the whole
task when the review step errored, so a transient blip threw away a generation
that had already taken a minute. A reviewer can judge an uncriticised draft
perfectly well.

**Rule telemetry is recorded when the draft exists, not when the prompt is
built.** Otherwise a failed generation inflates the usage counts that decide
which rules are pulling their weight.

**Ingestion is idempotent through a unique index on the provider's message id.**
The original kept a separate `deleted_emails` table so that dismissed mail did
not reappear on the next sync; a uniqueness constraint plus a `dismissed`
status says the same thing with one table instead of two.

**A retrying task goes back to `pending`, not `failed`.** The queue owns the
retry, and a routine 429 should not paint a row red for the thirty seconds
before the next attempt. It becomes `failed` only when the last attempt is
spent — which the handler knows because the job context tells it.

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

### The consolidation pass

Failing open is a decision to accumulate near-duplicates, and something has to
collect them. `rules/consolidate.ts` reads a category at a time and asks a
model to group rules that say the same thing, then rewrites each group's
survivor and retires the rest.

Two properties make it safe to run unattended:

- **Every rule lands in exactly one group.** The model is asked for a
  partition, but a model asked for a partition will occasionally repeat an id,
  invent one, or drop one. `salvageGroups` resolves what it can, gives a
  repeated id to whoever claimed it first, and appends an identity group for
  anything left over. A rule cannot vanish because a response was malformed.
- **A group of one is left byte-identical.** Models reflow text they were told
  to copy. The survivor is only written when the content actually differs, so a
  pass over a tidy rulebook is a no-op rather than a slow rewrite of everything.

Nothing is deleted — absorbed rules are disabled, and the survivor's previous
text is in `rule_revisions` with `reason = 'consolidation'`. Undoing a bad pass
is reading the revisions and flipping the flags back.

Large categories go out in batches of eighteen, then a second pass over the
resulting groups — chunked by stride, so batch neighbours are separated —
catches duplicates that landed in different batches. That pass runs with
`exactOnly`, because its synthetic ids (`g_1`, `g_12`) are prefixes of each
other and the usual id repair would confuse them.

**The gate is clock-free.** "Has anything changed since the last tidy?" was
first answered by comparing timestamps, which is wrong at millisecond
resolution: a rule written in the same millisecond as the stamp is
indistinguishable from one written before it. The watermark is a `rowid` plus
a count of non-consolidation revisions instead — both monotonic, neither
subject to ties. The pass's own rewrites are excluded, so it does not re-arm
itself.

It runs as a queue job rather than a script, so there is one code path, one
database handle and one config source; `POST /api/consolidate` checks the gate
and enqueues.

### What the rule block does about growth

Every enabled rule goes into every generation, so an unbounded rulebook
eventually becomes the prompt. `selectRules` caps it at ~20k characters and
drops by category when it bites — policy first, tone last, on the grounds that
a dropped tone rule reads slightly wrong while a dropped policy rule promises a
refund that does not exist. Drops are returned, not swallowed, so the caller
can log them.

The cap was 6k, on the reasoning that the mail being replied to should be the
bulk of the prompt. That was the wrong thing to protect. It is a stable prefix,
so it caches; a rule that never reaches the model is not a saving.

### Topics, and why the vocabulary is fixed

A budget alone only decides *which* rules to lose. Routing decides whether
they need to be lost at all: a classification names what the mail is about,
and only the rules filed under that name — plus the ones filed under nothing —
reach the prompt. On a rulebook of 136 that is roughly a tenfold cut.

Routing is what makes a larger budget affordable rather than a replacement for
one: the two together are what stopped the dropping. Routing alone still lost
64 of 88 eligible rules on a refund reply, because that desk's rules had grown
into 3000-character essays; a larger budget alone would have spent 20k
characters on rules about subtitle export in front of a refund request.

**The topic is decided before the rules are chosen, in its own call.** It has
to be: rules are selected by topic, and for a while the topic came out of the
drafting call that the selection fed. So the first draft of every task — the
one a reviewer actually reads — was routed by nothing, and only a
regeneration saw the right rules. On a real desk that was 84 of 354 rules
reaching a first draft, with every product rule among the 270 that did not.
Classifying first costs one small call on the utility model and takes the
number to 88 of 88.

This is not the analysis pass this codebase removed. That one re-read the
mail, formed its own view of intent and tone, and handed the drafter a second
opinion to contradict. This asks one question and answers with one word, and
it is the sole owner of the answer: where a desk has a vocabulary the drafter
is not asked for a topic at all, so there is nothing for the two to disagree
about. Where a desk has none, there is nothing to classify against and the
drafter's own label is kept, exactly as before.

Two more things make it work, and neither is optional.

**The names come from a list.** `topics` in the workspace config is a fixed
vocabulary, and the classifier is told to choose from it and checked against
it afterwards. Left to invent a label the model returns `refund`, then
`refunds`, then `refund-request`, and a rule filed under any one of them
matches almost nothing — which looks exactly like a correct scope on the task
page while routing the reply past every refund rule the desk has. An
unrecognised name is dropped rather than stored.

**No topics means every topic.** The rules that must never be dropped — which
language to reply in, how to open, what not to promise — are precisely the
ones that belong to no subject, so the absence of a tag is a real answer and
not an unclassified state. Roughly one rule in fourteen here.

Rules are tagged through a join table rather than the single `scope` column
this replaced. About one rule in six is genuinely about two subjects at once:
"check whether the subscription activated before offering money back" is read
as an access problem and answered out of the refund policy, and one column
forces a choice that is wrong half the time it is read. The mail, by
contrast, still carries one topic — a message that is genuinely two things is
rarer than a rule that is, and the always-applies set absorbs the miss.

Empty `topics` turns routing off entirely, which is the right behaviour for a
desk with thirty rules and the wrong one for a desk with three hundred.

Selection is by priority; *emission* is by insertion order. A rule block whose
order shifts between two runs makes their outputs impossible to compare.

**Ordering is by SQLite's rowid, not by `created_at` or id.** Ids are UUIDs and
timestamps have millisecond resolution, so neither orders two rules written in
the same tick. A test caught this immediately.

### Schema choices the original could not make later

`source_task_id`, `rationale`, `applied_count` and `last_applied_at` are all
cheap at schema-design time and impossible to backfill. Without provenance you
cannot answer "why does the drafter believe this?", which is the first question
asked when a rule produces a bad reply. Without usage counts there is no basis
on which a rule could ever be retired. Without a subject, a rule learned
handling one kind of mail steers every other kind.

The subject is the one that was got wrong first: a free-text `scope` column,
holding one label per rule, chosen by whoever typed it. Migration 11 replaces
it with `rule_topics` and carries the old values over — an empty join table
would have promoted every confined rule to applies-to-everything, which reads
as nothing breaking right up to the refund rules turning up in a reply about
the API. The column is left in place, unread, because this is the migration
most likely to be undone by hand.

Migrations are numbered against `PRAGMA user_version`, each in its own
transaction. The original ran `ALTER TABLE … ADD COLUMN` inside a try/catch on
every request and swallowed the error, which works until a change needs a
backfill or an ordering.

## The job queue

Learning is two or three LLM calls, which on a self-hosted model is a minute.
Nobody should watch a spinner after clicking Send — the mail has already gone,
and whether we learn from it is not the reviewer's problem. So approval
enqueues, and a worker does the rest.

The whole queue is one SQLite table. Adding Redis to run a handful of
background jobs would be the largest operational cost in the project, and this
is software people are expected to self-host. Everything below exists so that
one file is enough.

**Claiming is one statement.** `UPDATE … WHERE id = (SELECT … LIMIT 1)
RETURNING *`. The original selected a job and then claimed it separately; that
is safe, because the second query re-checks the status, but the worker that
loses the race gets nothing back and concludes the queue is empty while work is
sitting in it.

**A claim is a lease, not a flag.** If a worker dies mid-job the lease expires
and the job is claimable again, with no sweeper anyone has to remember to run.

**`attempts` increments at claim time, not on failure.** This is the bug worth
naming: the original reset stuck jobs to pending *without* touching the
counter, so a job that reliably hung the worker was an infinite loop with an
LLM call inside it. Charging the attempt up front means a job that never
reports back still runs out of attempts.

**Failures are classified, not counted.** A handler throwing `PermanentJobError`
— a malformed payload, an unregistered job type — fails immediately. Retrying a
payload with a missing field burns three LLM calls to reach the same verdict.

**Dedupe is a unique index, not a check-then-insert**, which two workers can
both pass. The key for learning is the task id plus a hash of the sent text: a
double-clicked Approve learns once, while a reviewer who revises and sends
again has produced a genuinely different lesson.

**The payload is frozen at enqueue time.** The original stored a task id and
re-read the row when the job ran, so a job's meaning depended on how long the
queue was — a learning job running after a second edit compared the wrong pair
of drafts.

**Handlers are registered, not switched on.** The original had one 700-line
route with a `switch` over six job types, half of them specific to one
company's internal tooling. A registry is what makes the rest of it publishable
at all.

## JSON

Models fence their output in markdown and forget to escape quotes inside string
values. `extractJson` tries plain parse → outermost `{...}` → the same with
quotes repaired, and returns `null` rather than throwing. Given a generation
can take minutes, repairing a missing backslash beats re-running the call.

## The review UI

Six screens, no client-side state, no CSS framework. Every mutation is a plain
`<form action={serverAction}>`, which buys three things that a React form does
not: it works before the JavaScript has loaded, a half-written draft survives a
reload because it was posted rather than held in component state, and there is
no client copy of the draft that can disagree with the one on disk about what
is being sent.

The review screen puts the textarea and the Send button in the same form, so
what goes out is exactly what is on screen. Save, Redraft and Dismiss are
`formAction` buttons on that same form, which means they all see the reviewer's
current edits rather than the last saved version.

Approve does three things in a fixed order: write the edited text to the task,
send the mail, then enqueue the learning job. If the provider is down the edits
are still on disk and the task stays `awaiting_review` — the reviewer comes
back to their own words and an error message, not to a blank box. If enqueueing
the learning job fails, that is logged and swallowed: the mail has already gone,
and telling the reviewer the send failed would get the customer two copies.

## Auth

One password, one signed cookie, no user table.

The system this came from had a hardcoded array of plaintext credentials and a
session token of the form `user:timestamp:random` that nothing verified — so
anyone could mint one by typing it into the cookie jar. Both problems are
solved by removing the thing that caused them. There are no accounts, so there
is nothing to store; the cookie is an expiry plus an HMAC over it, and the key
is derived from the password, so changing the password logs everyone out
without a session table to clear.

The check lives in a function that pages and route handlers call, not in
middleware. Middleware runs on the edge runtime and this needs `node:crypto`,
but the real reason is that a security check which depends on keeping a matcher
pattern up to date is a security check that will eventually miss a route.

An unset `ADMIN_PASSWORD` disables auth rather than bricking the app, because
the first thing anyone does is `npm run dev` on loopback and a login wall with
no credentials to type helps nobody. Every page renders a red banner in that
state.

## Licensing

MIT. The AGPL case was that it keeps a hosted-SaaS fork honest, and it was
rejected: the moat here is not the code, it is a rulebook that only exists
after a few hundred real corrections, which a fork does not get by copying
files. Meanwhile AGPL is on the banned-dependency list at a large share of the
companies whose support inboxes this is for, so it costs adoption to protect
something that was not at risk.

MIT also makes the code reusable inside other projects without a lawyer in the
loop, which is most of what a small open-source project has going for it. The
tradeoff is real and accepted: this is relicensable in one direction only, and
the direction has now been chosen.

## Open questions

- Is the learning loop portable, or does its quality depend on the volume of
  one specific inbox? Unknown until someone else runs it.
- Custom data lookups (the original scrapes an internal admin panel to enrich a
  customer record) are planned as configurable HTTP calls rather than a plugin
  system. Simpler, and no code execution surface. Not yet built.
