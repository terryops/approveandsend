# Context sources

A support reply is only as good as what the writer knows. "Have you tried
logging out?" to someone whose subscription lapsed yesterday is worse than no
reply at all — and the model cannot know that from the email, because the fact
lives in Stripe, or a billing admin, or a CRM.

A context source is a read-only lookup that turns an email address into a small
block of facts. Each block goes two places: a card on the review screen, and a
paragraph in the drafting prompt.

## Two rules

**A source cannot act.** There is no `refund()`, no `cancel()`, no
`issueCredit()`, and there will not be one. The whole claim of this product is
that a human approves what goes out. A model that could quietly cancel a
subscription while drafting a sentence about it would make that claim false.
Actions belong to buttons a person presses.

**A source writes its own prose.** The obvious implementation hands back a blob
and lets the prompt `JSON.stringify` it. That makes the model spend tokens
guessing whether `"level": 2` is good news. Your source knows; say it in a
sentence.

## Stripe, which is built in

Set `STRIPE_API_KEY` and it turns on. Leave it unset and it stays out of the
way entirely — it is not registered, not called, and not shown.

Make it a **restricted** key with read on customers, subscriptions and charges.
Nothing here writes, so nothing here needs write. It uses `/v1/customers?email=`
rather than `/v1/customers/search`, so the narrowest key Stripe will issue is
enough.

What the model gets is a paragraph, not a record:

```
Customer since 2024-03-11. Has an active subscription (Pro — 19 USD/month),
renews 2026-03-31. Has paid 418 USD across 22 charge(s); the most recent was
2026-03-01.
```

And when they have lapsed, it says so in the words that matter:

```
No active subscription — the most recent one is canceled, last period ended
2026-01-14. Do not talk to them as a current subscriber.
```

## Earlier conversations, which is always on

The one lookup that needs no credentials, because it reads the database this
product already keeps. It says how many times you have replied to this person,
when, and what about:

```
We have replied to them 3 times before, most recently 9 days ago. That
exchange was about "Export finishes but the file is empty".
```

It also watches how those replies were sent. When the drafts for one person
have usually been rewritten before going out, it says so, and the drafter aims
closer to the sent version than to its own instincts.

This is the fact a human reviewer reliably has and a model reliably lacks.
Answering "sorry you're having trouble, could you tell me more" to someone on
their fourth email about the same thing is the most common way support writing
goes wrong, and it is invisible from the message in front of you.

## Declaring a lookup instead of writing one

Most lookups are one endpoint that already answers to an email address, and the
only real work is saying which fields matter and what they mean. That does not
need a JavaScript file. Put an object in `contextSources`:

```json
{
  "contextSources": [
    {
      "id": "product",
      "label": "Product account",
      "url": "https://admin.example.com/api/support/lookup?email={email}",
      "headers": { "Authorization": "Bearer ${PRODUCT_TOKEN}" },

      "root": "user",
      "requires": "id",

      "title": "Product account",
      "href": "https://admin.example.com/users/{id}",
      "fields": [
        { "label": "Plan", "path": "level", "map": { "0": "Free", "1": "Pro", "2": "Unlimited" } },
        { "label": "Credits", "path": "credits", "suffix": "left" },
        { "label": "Files", "path": "files" }
      ],
      "prompt": [
        "They are on the Unlimited plan and have used it for {files} files since {joined}.",
        "They have {credits} credits left."
      ]
    }
  ]
}
```

A few of those keys are load-bearing:

- **`{path}`** is a dotted path into the response, and `{email}`, `{name}` and
  `{subject}` always resolve to the sender. A path that is not there is not an
  error; see the next two points.
- **`map`** is how a declared source obeys the second rule. `level: 2` becomes
  `Unlimited` on the card, so nobody — human or model — has to know the code.
- **`prefix`** and **`suffix`** put the unit where a person would write it, and
  both space themselves the same way: a word gets a space, punctuation does
  not. `Lv.2`, `$40`, `95%`, but `40 credits`. Reach for `prefix` rather than a
  `map` enumerating every plan level you might ever have.
- **`prompt`** is a list of sentences, and **a sentence with a missing value is
  dropped whole**. That is why there is no `if` in this format: the sentence
  about expiring credits simply is not there for someone who has none, and you
  never get "They have  credits left."
- **`{?path}`** requires a value and prints nothing, which is how a flag gates
  a sentence: `"{?isLifetime}They hold a lifetime licence, so never quote them
  a renewal date."` disappears for everyone who does not. A `false` counts as
  missing everywhere — on a card, `AppSumo: no` is noise, and the absent row
  says the same thing.
- **`requires`** handles the usual shape of "no such user": a `200` with an
  empty record. A card reading `Plan: —` is worse than no card.
- **`${VAR}`** in a header reads the environment, so the token stays out of the
  config file and the config file stays committable.
- **`404`** is an answer — this person is not in that system — and any other
  error status is a failure, reported against that source by name.

`method`, `body` and `timeoutMs` are there for the POST-only internal endpoint
you will eventually meet.

### When it isn't an HTTP API

Give `command` instead of `url`. The command is run with the substituted
arguments, its stdout is parsed as JSON, and everything downstream is
identical:

```json
{
  "id": "admin",
  "label": "Admin",
  "command": ["node", "/srv/lookups/admin-lookup.js", "{email}", "--json"],
  "requires": "found",
  "title": "Admin",
  "fields": [{ "label": "Plan", "path": "plan" }],
  "prompt": "They are on {plan} and have {credits} credits."
}
```

Anything that prints JSON qualifies, which in practice means the scraper
somebody already wrote for the admin panel that has no API. Progress on stderr
is ignored; only stdout is read.

The command is **argv, never a shell string**. The system this was extracted
from built it by concatenation — `execSync('node lookup.js "' + email + '"')` —
so an address containing a quote ran whatever came after it. An array of
arguments cannot do that and costs nothing.

Pretty-printed output is fine, including objects nested inside it. The first
`{` to the last `}` is what gets parsed, so a script that prints a banner, or a
stats blob with a map in the middle of it, needs no cooperation.

### The two lookups this replaced

Worth reading as a pair, because they are the whole argument for this format.
Both were job handlers in the system this came from — a hundred lines of
`execSync`, JSON hunting, and a bespoke card component each. Neither needed to
be code.

An admin-panel scraper that answers with an account:

```json
{
  "id": "product",
  "label": "Product account",
  "command": ["node", "/srv/lookups/account.js", "{email}"],
  "requires": "found",

  "title": "Product account",
  "fields": [
    { "label": "Plan", "path": "plan" },
    { "label": "Level", "path": "level", "prefix": "Lv." },
    { "label": "AppSumo", "path": "isAppSumo" },
    { "label": "Credits", "path": "credits" },
    { "label": "Files", "path": "totalFiles" },
    { "label": "Joined", "path": "createdAt" }
  ],
  "prompt": [
    "They are on the {plan} plan with {credits} credits and have run {totalFiles} files since {createdAt}.",
    "{?isAppSumo}They came in on a lifetime deal, so never quote them a renewal price.",
    "Their credits start expiring {creditNextExpiry}."
  ]
}
```

Three things in there are doing real work. `requires: "found"` is what stops an
unknown address producing a card of dashes. `{?isAppSumo}` is a sentence that
exists only for the people it is true of, and the `AppSumo` row disappears for
everyone else rather than reading `no`. And the last sentence is absent for an
account with nothing expiring, which is the reason there is no `if` in this
format.

And a usage scraper, which is the same shape with none of the credentials:

```json
{
  "id": "usage",
  "label": "Usage",
  "command": ["node", "/srv/lookups/usage.js", "{email}", "--json"],
  "requires": "lastUsedAt",
  "timeoutMs": 60000,

  "title": "Usage",
  "fields": [
    { "label": "Transcribed", "path": "transcription" },
    { "label": "Translated", "path": "translation" },
    { "label": "Minutes", "path": "totalMinutes" },
    { "label": "Success rate", "path": "successRate", "suffix": "%" },
    { "label": "Last used", "path": "lastUsedAt" }
  ],
  "prompt": [
    "They have processed {totalFiles} files ({totalMinutes} minutes), most recently {lastUsedAt}, mostly in {primaryLanguage}.",
    "Their success rate is {successRate}% — anything much below 100 means they have hit real failures."
  ]
}
```

It requires `lastUsedAt` rather than `totalFiles`, and that is the only subtle
line in either spec: a zero is a fact, so `totalFiles: 0` passes `requires` and
produces a card of zeros for somebody who has never used the product. The date
they last did something is absent for exactly those people.

A slow scraper gets `timeoutMs` and nothing else. It is one of several lookups
running in parallel, it cannot delay a mail past its own timeout, and if it
gives up it is a red row on the queue page rather than a failed draft.

## Writing your own

When the mapping is not enough — the response needs two calls, or a date needs
arithmetic, or the sentence depends on a comparison — a source is a module that
default-exports an object with an `id`, a `label` and a `lookup`. Plain ESM; no
build step, no manifest, no registration.

```js
// /srv/approveandsend/sources/crm.mjs
export default {
  id: 'crm',
  label: 'Account (CRM)',

  // Optional. Return false and the source is skipped silently — this is how a
  // source stays out of the way when its credentials are not set.
  configured: () => !!process.env.CRM_TOKEN,

  async lookup({ email, name, subject, taskId }) {
    const account = await findAccount(email);
    if (!account) return null;          // nothing to say is not an error

    return {
      title: 'Account',
      href: `https://crm.example/accounts/${account.id}`,
      fields: [
        { label: 'Tier', value: account.tier },
        { label: 'Owner', value: account.owner, href: `https://crm.example/u/${account.owner}` },
        { label: 'Open tickets', value: String(account.openTickets) },
      ],
      // Interpreted, not dumped. Return '' to show the reviewer something
      // without spending any prompt on it.
      prompt: `Enterprise account with ${account.openTickets} open tickets; their account manager is ${account.owner}.`,
    };
  },
};
```

Point at it from `aas.config.json`. Paths and declared specs mix freely in the
same list:

```json
{
  "organization": "Acme",
  "contextSources": [
    "/srv/approveandsend/sources/crm.mjs",
    { "id": "product", "url": "https://admin.example.com/api/support/lookup?email={email}", "title": "Product" }
  ]
}
```

Module paths can also come from the environment, comma-separated:

```bash
AAS_CONTEXT_SOURCES=/srv/approveandsend/sources/crm.mjs,/srv/approveandsend/sources/billing.mjs
```

### Paths, not packages

Deliberately. The sources that actually earn their keep are the ones that
cannot be published — they hold a tenant id, an internal admin URL, a scraped
session cookie, a CRM database id. Keep them next to the deployment. A package
registry before there is a second author would be building the wrong half.

## What happens at runtime

Ingestion queues an `enrich-context` job before `draft-reply`, at a higher
priority so the lookups finish first. That job runs every source in parallel and
writes one row per source.

It is a separate job from drafting because the two fail differently and want
different retries. A model call fails slowly and expensively; a billing API
fails fast, usually because a key expired. Splitting them also means a source
that has started timing out shows up as its own red row in the queue, instead of
being reported as "drafting failed" — which is the wrong place to go looking.

Everything after that is designed around the same idea: **extra information must
never be able to stop the mail.**

- A source that throws is recorded in the job result and otherwise ignored.
- A source that returns a malformed block is discarded rather than stored.
- A module that will not import is logged and skipped.
- Drafting is queued even when every single source failed.

A reply written with less information is the product working slightly worse. A
support queue that stops because a CRM is down is the product not working.

The critic sees the context too, and needs it more than the drafter does:
"claims not supported by the facts above" is how a reply that cheerfully tells a
lapsed customer their subscription renews next month gets caught before a human
has to notice it.

## What the reviewer sees

Each block renders as a card above the draft — fields first, then the sentence
the model was given. Above, not beside: someone deciding whether a reply is
right needs to know what it was working from before they read it.

The card is stored, not re-queried on page load. If the sidebar re-queried
Stripe every time, a subscription cancelled after the draft was written would
make the draft look like a mistake nobody made. The row is the evidence of what
the model actually saw.

## Learning from the archive ignores all of this

The backfill (see the Archive screen) drafts counterfactually against mail from
years ago. It passes an empty context block on purpose: a subscription as it
stands today says nothing true about the account as it stood when that reply was
written, and a rule learned from a fact the writer never had is a rule learned
from fiction.
