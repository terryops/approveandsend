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

So there is exactly one rule about rules:

> **Text a model wrote after reading a customer's email does not reach a prompt
> until a human has approved it.**

## How that is enforced

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

A rule *you* typed is not gated — a merge into an existing rule carries your
authority into it. The gate is on provenance, not on mechanism.

## What happened to your rules when you upgraded

Migration v24 moved every enabled rule that was learned from a conversation
back into the proposal queue. If your desk had been running for a while, that
is potentially a lot of them, and your next few drafts will be written without
them.

This was a deliberate trade. Those rules were written by the learning pass
before any of the above existed: they were extracted by a model from customer
mail and switched on without anybody reading them. Leaving them enabled is not
a smaller decision than moving them — it is the same decision, made silently,
in the direction that keeps the hole open.

Nothing was deleted. Every one of them is on `/rules` under proposals, with the
conversation it came from linked, and one click puts it back. Rules you typed,
starter rules, imported rules and rules you had already retired were not
touched.
