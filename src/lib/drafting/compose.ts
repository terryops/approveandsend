import { callAI } from '../ai';
import { describeWorkspace } from '../config/workspace';
import { assemble, signOffRule, type DraftOptions } from './draft';
import { extractJson } from '../json-repair';
import type { Task } from '../tasks/types';
import { clip } from '../thread-context';

/**
 * Writing a mail nobody asked for.
 *
 * The desk exists to answer mail, but a support desk also starts
 * conversations: the apology to everybody caught by yesterday's outage, the
 * follow-up on a bug that has finally been fixed, the answer to a question
 * that came in over a phone call. Those got written in a mail client, outside
 * every rule the desk has, by whoever had the tab open.
 *
 * So they are written here instead, against the same rulebook, and land in the
 * same review queue as everything else — a composed mail is a task with a
 * brief where the customer's email would be, and from that point on nothing
 * downstream can tell the difference. It is reviewed, edited, translated for
 * the reviewer, versioned and sent by exactly the same code.
 */

/** A brief longer than this is a document, and the point was to write a mail. */
const MAX_BRIEF_CHARS = 4_000;

export interface Composed {
  /** What the model called it. Only used where the operator left it blank. */
  subject: string;
  body: string;
}

export async function composeMessage(
  task: Task,
  options: DraftOptions = {},
): Promise<Composed | null> {
  // The same rulebook the replies are written against. A first-contact mail is
  // where a desk is most likely to promise something it should not: there is
  // no customer question bounding what it can say.
  const {
    workspace, catalogueBlock, rulesBlock, contextBlock, steerBlock, previousBlock,
  } = await assemble(task, {
    ...options,
    // A brief is not a conversation, and there is nothing to classify: what
    // this mail is about is whatever the operator says it is about.
    thread: '',
    files: '',
    // The note and the draft on the table are not blanked, though they were.
    // A composed mail is reviewed on the same screen as a reply, with the same
    // box under it and the same Redraft button, and a button that throws away
    // both what the reviewer typed and what they had edited is a button that
    // does the wrong thing on half the queue.
  });

  const prompt = `You are writing an email on behalf of a support desk. This is not a
reply — nobody has written to us. Somebody here has decided to get in touch.

${describeWorkspace(workspace)}${catalogueBlock}${rulesBlock}${contextBlock}${previousBlock}${steerBlock}

## Who it is going to
${task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}

## What they want said
${clip(task.body, MAX_BRIEF_CHARS)}

Write what the brief asks for and nothing more. An unsolicited mail that
wanders is worse than one that is blunt, and every extra sentence is one the
recipient did not ask for. Do not invent a reason for writing, an apology
nobody authorised, or a commitment that is not in the brief — the rules above
still bind, and they bind harder here because there is no customer question
holding the reply to a subject.
${signOffRule(workspace.signature)}
JSON only, no prose around it:
{
  "subject": "a subject line that says what the mail is about — no Re:, this starts the conversation",
  "body": "the mail itself, plain text, ready to send"
}`;

  const parsed = extractJson<Record<string, unknown>>(await callAI(prompt, { role: 'drafter' }));
  if (!parsed) return null;

  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (!body) return null;

  return {
    subject: typeof parsed.subject === 'string' ? parsed.subject.trim() : '',
    body: workspace.signature ? `${body}\n\n${workspace.signature}` : body,
  };
}
