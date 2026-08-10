# Review language

The whole product rests on one claim: a person read this before it went out. A
reviewer approving a Japanese reply they cannot read has not read it. They have
clicked a button, and the claim is now false.

Set a **review language** and every incoming message and every draft is also
rendered into it, side by side with the original, for whoever has to approve
the reply. It is never sent to anyone. It exists so that clicking **Approve &
send** is not an act of faith.

```json
{
  "replyLanguage": "match",
  "reviewLanguage": "Chinese"
}
```

Or `AAS_REVIEW_LANGUAGE=Chinese`, or the field on `/setup/voice`.

## The two languages are not the same setting

- **`replyLanguage`** — what the *customer* receives. `match` answers in
  whatever language they wrote in.
- **`reviewLanguage`** — what *you* read. Never leaves the building.

They are orthogonal on purpose. A team in Guangzhou answering the world in the
customer's own language sets `match` and `Chinese`, and both halves are true at
once: the customer gets French, the reviewer gets Chinese, and nobody is
approving a paragraph they are guessing at.

Leave `reviewLanguage` empty — the default — and the mail half is off end to
end: no column is read, no model is called for a message or a draft, and no
second panel appears on the review screen. This is the right setting for a team
that reads the mail it receives.

## The cards are the other half, and they follow the interface

Context sources write their own prose, in whatever language their author was
thinking in — English, for the built-in ones and for most config files. The same
job renders those cards, but into the **interface** language rather than this
one: a card is a piece of the interface that happens to have been written
somewhere else, and a desk that reads its own mail unaided still wants its own
furniture in its own words. So a desk with no `reviewLanguage` and a billing
lookup does queue the job, for the cards alone.

What the model was told is untouched — see
[Context sources](context-sources.md#in-the-language-the-desk-is-read-in).

## What it costs

One extra model call per translated part, so at most two per task: the
customer's message and the reply. A task with context cards on it costs one
more — one call for all the cards, however many sources you run, and only when
a lookup comes back with something a stored rendering does not cover. Point the
translator role at a cheap model — this is transcription, not judgement:

```bash
AI_MODEL_TRANSLATOR=gpt-5.6-luna
```

A message already in your review language costs one call and stores nothing.

## A stale translation is worse than none

A translation is stored with a SHA-256 of the exact text it was made from, and
shown only beside text that still hashes to it. Redraft the reply and the
translation panel **disappears** until the queue renders the new one, rather
than showing you the previous draft's.

This is the failure this feature exists to prevent, in miniature. A reviewer who
can read French would notice the two had drifted apart. The reviewer this is
built for is precisely the one who cannot. So the rule is: show the truth or
show nothing.

## It asks the model, and never counts characters

"Is this already in Chinese?" looks like a job for a regex over CJK code points.
It is not — that heuristic classifies kanji-heavy Japanese as Chinese, and the
first time it does, someone approves a reply in a language they do not read
while the screen tells them they are reading a translation.

So the translator is told: if the text is already in the target language, reply
with exactly `SAME`. That answer stores nothing and shows nothing. It costs one
call to be right instead of zero calls to be usually right.

## When it runs

The translation job is queued after a draft is written, so both halves of the
conversation exist by the time anything is rendered. It runs on the same worker
as everything else — `POST /api/worker`, or the ticker container from
`docker compose`. A failure to translate never blocks the mail; the task still
appears for review, just without the panel.
