import { callAI } from '../ai';
import { describeWorkspace } from '../config/workspace';
import { assemble, signOffRule, type DraftOptions } from './draft';
import { extractJson } from '../json-repair';
import { operatorLanguage } from '../i18n';
import type { Task } from '../tasks/types';
import { clip, htmlToText } from '../thread-context';

/**
 * Three ways this reply could have gone.
 *
 * Not a second draft. A reviewer who presses Redraft is saying the draft is
 * wrong; a reviewer who asks for options is saying they do not yet know what
 * right looks like, and handing them the same reply reworded is no help at
 * all. So the model is asked for approaches that genuinely differ in what the
 * desk commits to — refund it now, ask one diagnostic question first, hold the
 * line and explain the policy — and each carries the strategy in a few words
 * so the choice can be made without reading three replies in full.
 *
 * Generated on demand, never automatically. Most tasks are answered by the
 * first draft, and paying for three replies to every routine password reset
 * would triple the bill of the desk to serve the tenth of tasks that are
 * actually a judgement call.
 */

const MAX_BODY_CHARS = 12_000;

/**
 * How many choices end up in front of the reviewer, the draft included.
 *
 * The draft is one of them — tab A is the reply already on the table, and the
 * model is asked for `MAX_OPTIONS - 1` others. That is not bookkeeping: a strip
 * of three where none of them is what is in the box leaves the reviewer holding
 * a fourth text nobody described, no tab lit on arrival, and no way back to the
 * draft once they have clicked away from it.
 */
export const MAX_OPTIONS = 3;

/** How many genuinely new approaches the model is asked to invent. */
const NEW_APPROACHES = MAX_OPTIONS - 1;

export interface DraftOption {
  /** A few words on what this approach commits the desk to. */
  strategy: string;
  body: string;
}

function buildPrompt(task: Task, blocks: Awaited<ReturnType<typeof assemble>>, current: string): string {
  const { workspace, catalogueBlock, rulesBlock, contextBlock, threadBlock, filesBlock } = blocks;

  // The steer block is deliberately not here. A note saying what was wrong with
  // one draft is an instruction for a redraft; on a request for options it
  // would collapse the three into three shades of the same correction.
  return `You are helping a support reviewer decide how to answer this email.

${describeWorkspace(workspace)}${catalogueBlock}${rulesBlock}${contextBlock}${threadBlock}

## The customer's ${threadBlock ? 'latest message' : 'email'}
From: ${task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
Subject: ${task.subject}

${clip(htmlToText(task.body), MAX_BODY_CHARS)}${filesBlock}

## The reply already drafted
${clip(current, 4000)}

## What is wanted
Two things, and the first is not a rewrite.

First, name what the reply above already commits us to, in the same few words
you would use for any other approach. The reviewer sees it as one choice among
the others, so it needs a label in the same voice as theirs — not a review of
it, and not a suggestion for improving it.

Then ${NEW_APPROACHES} other ways this could be answered that differ in what we
actually do, not in how it is worded. Refunding, asking a diagnostic question
first, explaining why the answer is no, offering a workaround and offering an
escalation are different approaches; the same reply in a warmer tone is not, and
returning one is a wasted option. Neither of them may be the approach the draft
above already takes — that one is already on the table.

Every one of them has to obey the rules above and be ready to send as written.
An option nobody could send is not an option. If the case honestly admits fewer
than ${NEW_APPROACHES} further defensible approaches, return the ones that exist
rather than padding the list with an answer you would not stand behind.

## Two languages, and which is which
Every \`body\` goes to the customer, so it is written in the language they wrote
in — same as any other reply from this desk.

Every \`strategy\` is the opposite: it is the name of a button. The reviewer picks
between these three by reading three short labels side by side, and they read
${operatorLanguage()}, so that is what the labels are written in whatever
language the mail arrived in. A strip of options named in a language the person
choosing between them has to decode is a strip they open one at a time — which
is the entire cost the labels exist to save. Leave product names, error strings
and identifiers exactly as they appear.
${signOffRule(workspace.signature)}
JSON only, no prose around it:
{
  "current": "a few words in ${operatorLanguage()} on what the reply already drafted commits us to",
  "options": [
    {
      "strategy": "a few words in ${operatorLanguage()} on what this one commits us to, e.g. refund immediately, ask for the export id first",
      "body": "the reply itself, plain text, ready to send"
    }
  ]
}`;
}

/**
 * Ask for the choices, the draft included, in the order they will be shown.
 *
 * The first is always the reply that was already on the table — the model only
 * supplies its label. Returns [] rather than throwing on a bad response: the
 * reviewer still has their draft, and a missing tab strip is a smaller failure
 * than a screen that will not load.
 */
export async function suggestAlternatives(
  task: Task,
  current: string,
  options: DraftOptions = {},
): Promise<DraftOption[]> {
  // The same assembly the drafter uses — a set of options routed by a
  // different rulebook than the draft they sit beside would be three replies
  // to a slightly different email.
  const blocks = await assemble(task, options);

  const parsed = extractJson<Record<string, unknown>>(
    await callAI(buildPrompt(task, blocks, current), { role: 'drafter' }),
  );
  if (!parsed || !Array.isArray(parsed.options)) return [];

  const signature = blocks.workspace.signature;

  const others = parsed.options
    .flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const option = value as Record<string, unknown>;
      const body = typeof option.body === 'string' ? option.body.trim() : '';
      if (!body) return [];
      return [
        {
          // A missing strategy is a usable option with an unhelpful label, not
          // a discard: the reply is the part the reviewer sends.
          strategy: typeof option.strategy === 'string' ? option.strategy.trim() : '',
          body: signature ? `${body}\n\n${signature}` : body,
        } satisfies DraftOption,
      ];
    })
    .slice(0, NEW_APPROACHES);

  // Nothing new to offer, so there is no choice to present — one tab is not a
  // strip, and a strip with the draft alone in it implies the model looked and
  // found nothing, which is not distinguishable here from the call failing.
  if (others.length === 0) return [];

  // The draft first, exactly as it stands. No signature appended: whatever is
  // in the box already went through that when it was drafted, and doing it
  // again is how tab A grows a second sign-off.
  return [
    {
      strategy: typeof parsed.current === 'string' ? parsed.current.trim() : '',
      body: current.trim(),
    },
    ...others,
  ];
}
