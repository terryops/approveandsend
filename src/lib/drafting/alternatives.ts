import { callAI } from '../ai';
import { describeWorkspace } from '../config/workspace';
import { assemble, type DraftOptions } from './draft';
import { extractJson } from '../json-repair';
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

/** How many are asked for, and the hard ceiling on how many are kept. */
export const MAX_ALTERNATIVES = 3;

export interface DraftOption {
  /** A few words on what this approach commits the desk to. */
  strategy: string;
  body: string;
}

function buildPrompt(task: Task, blocks: Awaited<ReturnType<typeof assemble>>, current: string): string {
  const { workspace, rulesBlock, contextBlock, threadBlock, filesBlock } = blocks;

  // The steer block is deliberately not here. A note saying what was wrong with
  // one draft is an instruction for a redraft; on a request for options it
  // would collapse the three into three shades of the same correction.
  return `You are helping a support reviewer decide how to answer this email.

${describeWorkspace(workspace)}${rulesBlock}${contextBlock}${threadBlock}

## The customer's ${threadBlock ? 'latest message' : 'email'}
From: ${task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
Subject: ${task.subject}

${clip(htmlToText(task.body), MAX_BODY_CHARS)}${filesBlock}

## The reply already drafted
${clip(current, 4000)}

## What is wanted
${MAX_ALTERNATIVES} ways this could be answered that differ in what we actually
do, not in how it is worded. Refunding, asking a diagnostic question first,
explaining why the answer is no, offering a workaround and offering an
escalation are different approaches; the same reply in a warmer tone is not,
and returning one is a wasted option.

Every one of them has to obey the rules above and be ready to send as written.
An option nobody could send is not an option. If the case honestly admits fewer
than ${MAX_ALTERNATIVES} defensible approaches, return the ones that exist
rather than padding the list with an answer you would not stand behind.

JSON only, no prose around it:
{
  "options": [
    {
      "strategy": "a few words on what this one commits us to, e.g. refund immediately, ask for the export id first",
      "body": "the reply itself, plain text, ready to send${workspace.signature ? '' : ' — no signature'}"
    }
  ]
}`;
}

/**
 * Ask for the alternatives. Returns [] rather than throwing on a bad response:
 * the reviewer still has the draft they had before, and the button not working
 * is a smaller failure than the screen not loading.
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

  return parsed.options
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
    .slice(0, MAX_ALTERNATIVES);
}
