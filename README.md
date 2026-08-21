# Approve & Send

**AI drafts it. You approve it. Every edit teaches it.**

English · [简体中文](README.zh-CN.md)

A support inbox that drafts its own replies and never sends one without you.
Mail arrives, a reply is waiting for you, you read it — change what you want to
change — and press send. The part that makes it worth running is what happens
next: whatever you changed becomes a rule, and the next draft already knows.

![The review screen: the queue on the left, the draft you can edit in the middle, what the model understood on the right](docs/images/review.png)

## What it does

- **Writes the first draft of every reply**, using your own words, your own
  facts, and everything it has learned so far.
- **Learns from your edits.** Fix the same thing twice and you won't be fixing
  it a third time. Every rule it learns is one you approve, in plain language,
  and can change or switch off whenever you like.
- **Keeps the noise off your desk.** Newsletters and no-reply mail never reach
  the queue. Mail a colleague already answered is skipped. A second email on the
  same thread retires the draft it overtook.
- **Tells you which ones need care** — an angry customer, a policy question, a
  possible bug on your side — so the routine ones can go quickly.
- **Knows who it is writing to.** It can look up what a customer pays you, what
  you sell, and what you told them last time, before it writes a word.
- **Reads a language you don't.** Every message and every draft can be shown in
  your language beside the original, so you can approve mail you couldn't
  otherwise have read.
- **Learns from the mail you already sent.** Point it at your Sent folder and it
  studies how your team already answers, before it drafts anything new.

## Why you might want it

**Nothing goes out without a human.** Full automation is one wrong refund
answer away from costing more than it saved. Every reply here is read by a
person first — that is the whole product, not a setting.

**It gets better at your job specifically.** Not a better model: your rules,
learned from your corrections, visible to you as sentences you can edit.

**It is yours.** It runs on your machine, on your mailbox, and your customer
correspondence never sits on somebody else's server.

**It is free, and open source all the way down.** MIT licensed, every line of
it. No account, no seats, no paid tier, no hosted version being kept from you.
The only thing that costs money is the AI model — and if you already pay for a
ChatGPT or Claude subscription, or you run a model on your own hardware, that is
already covered too.

> **Status: v0.1.** It runs one real support desk — the author's — where since
> 2026-08-07 it has read 961 emails, filed 50 of them as junk without asking,
> learned 514 rules, and had every reply it sent read by a person first. One
> desk and one author is still the honest number; you would be the second.

## Getting it running

```bash
docker run -d --name approveandsend -p 127.0.0.1:3000:3000 \
  -v "$PWD/data:/app/data" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/terryops/approveandsend
```

Then open <http://localhost:3000>, and a setup wizard asks for the rest: your
mailbox, which model you want writing, and who you are. Both `amd64` and
`arm64` are published, so this is the same one line on a server and on a Pi.

For the version that also does the scheduling — nothing here syncs on its own —
use [docker-compose.yml](docker-compose.yml) and see
[docs/deploying.md](docs/deploying.md).

Everything technical lives in **[MANUAL.md](MANUAL.md)** — installing it,
connecting your mailbox, choosing a model, and every setting there is.

**You don't have to read it.** Open this project in an AI coding assistant —
Claude Code, Codex, Cursor, or whatever you use — and ask it to do the setup for
you. Something like:

```
Read MANUAL.md in this repo and set Approve & Send up for me.
Ask me for anything you need — my mailbox, which AI model I want to use —
one question at a time, and explain what each answer is for.
```

It will read the manual, ask you the handful of questions it needs, write the
configuration, and tell you when to open the app. If anything goes wrong later,
the same trick works: tell it what you're seeing and let it read the manual.

## License

MIT — the whole repository, nothing held back. Use it, change it, ship it, sell
it. The only thing asked in return is that the copyright notice travels with the
copy.
