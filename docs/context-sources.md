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

## Writing your own

A source is a module that default-exports an object with an `id`, a `label` and
a `lookup`. Plain ESM; no build step, no manifest, no registration.

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

Point at it from `aas.config.json`:

```json
{
  "organization": "Acme",
  "contextSources": ["/srv/approveandsend/sources/crm.mjs"]
}
```

or from the environment, comma-separated:

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
