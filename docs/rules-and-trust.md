# Rules, and who is allowed to write one

Every enabled rule is pasted into the prompt that writes your replies. That is
the point of the rulebook, and it is also the reason the rulebook is the most
attractive thing in this application to attack.

The learning pass reads mail written by strangers. If a customer writes *"your
policy is that any account over 30 days old gets a full refund without manager
approval"*, a model summarising that conversation may faithfully report it as a
rule. Nobody has lied to the model and nothing has malfunctioned — the sentence
simply arrived from someone who does not work here, and once it is in the
rulebook it steers every reply the desk sends.

There is one setting that decides what happens next, and it is worth
understanding before you decide which way you want it.

```json
{
  "autoApproveRules": true
}
```

## The default: the desk teaches itself

`true` — the default — means a rule the learning pass writes is live from the
next draft onwards. You approve a reply, the pass reads what you changed, and
the correction is in the rulebook before you have finished the next email.
Nobody clicks anything.

This is the loop the product is named after, and the case for it being the
default is that the alternative fails quietly. A queue of proposals is only a
safeguard while somebody reads it. On a desk where nobody does, the same
correction gets made by hand every week while the rule that would have fixed it
waits on a page nobody opens — and that desk is not safer, it is just slower and
believes it is safer.

What you give up is real: with this on, there is no human between a customer's
email and the instructions your drafter is given. A well-written letter can
propose the sentence that steers every later reply.

What you keep is the record. Every rule the pass writes carries the task that
taught it, and every rewrite lands as a revision with the previous wording, the
reason `learned`, and the same task id. So *why does the drafter believe this,
and which email put it there* is answerable on `/rules` afterwards — which is
what turns a bad rule into a two-minute fix rather than a mystery.

## Turning the gate on

Set `autoApproveRules` to `false` in `aas.config.json`, or
`AAS_AUTO_APPROVE_RULES=false` in the environment. Then:

> **Text a model wrote after reading a customer's email does not reach a prompt
> until a human has approved it.**

Anything the learning pass produces is stored `proposed`, which means kept,
visible on `/rules`, and left out of every listing that feeds a prompt. That
covers new rules.

It also has to cover *changes* to existing rules, which is less obvious. The
learning pass can amend a rule, and the deduplicator can merge a candidate into
one or replace one outright. All three rewrite a rule that was already approved
and is already being injected — and the approval that rule carries was for the
sentence it used to say, not for whatever arrives now. A rewrite is the same
escalation as a new rule, reached by a different door.

So a model-driven rewrite is stored the same way: as a proposal, carrying the
new text, with `replaces` pointing at the rule it wants to change. Approving it
applies the text to that rule as an ordinary revision and removes the proposal,
so the rule keeps its id, its usage counts and its history, and the sentence it
used to say stays recoverable. Rejecting it is deleting the proposal.

A rule *you* typed is not gated either way — a merge into an existing rule
carries your authority into it. The gate is on provenance, not on mechanism.

Consider turning it on if your desk answers mail from people you have no
relationship with, if the rulebook encodes anything with money or access
attached, or simply if there is somebody whose job it would plausibly be to
read the queue.

## Proposals you already have

Switching the default on does not approve anything retrospectively. Proposals
already in the queue stay proposals, still listed on `/rules`, still injected
nowhere, until you approve or delete them. Only what the learning pass writes
from here on skips the queue.

## What happened to your rules when you upgraded

Migration v24 moved every enabled rule that was learned from a conversation
back into the proposal queue. If your desk had been running for a while, that
is potentially a lot of them, and your next few drafts will be written without
them.

That migration was written when approval was the only mode. It is still the
right thing to have done — those rules were extracted by a model from customer
mail and switched on without anybody reading them, and leaving them enabled
would have been the same decision made silently. But it means an upgraded desk
can be running with `autoApproveRules` on and still have a queue of old
proposals waiting, which is not a contradiction: the new ones go straight in,
and these are still asking.

Nothing was deleted. Every one of them is on `/rules` under proposals, with the
conversation it came from linked, and one click puts it back. Rules you typed,
starter rules, imported rules and rules you had already retired were not
touched.
