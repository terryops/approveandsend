import { callAI } from '../ai';
import type { WorkspaceConfig } from '../config/workspace';
import type { Task } from '../tasks/types';
import { clip, htmlToText } from '../thread-context';

/**
 * Deciding whether an email is for us at all, before spending anything on it.
 *
 * A public support address gets a lot of mail that is not support: guest-post
 * and backlink pitches, cold SaaS outreach, launch-directory spam, newsletters
 * nobody signed up for, autoresponders. Every one of them was costing a
 * context lookup, a drafting call and a critic pass to produce a polite reply
 * to a robot — and then a reviewer's attention to notice it and dismiss it.
 *
 * So one cheap call goes first. It answers one question and the safe answer is
 * always "reply": a spam pitch that gets a draft is a wasted call, and a
 * customer that gets auto-dismissed is a customer who never hears back. The
 * prompt is written around that asymmetry, and everything that goes wrong here
 * — a failed call, an answer in an unexpected shape — comes out as "reply".
 *
 * Nothing is deleted. An auto-dismissal lands in the archive with its reason
 * on it and reopens like any other, which is what makes it safe to be wrong.
 */

/** Enough to tell a pitch from a customer. The rest never changes the answer. */
const TRIAGE_CHARS = 1_500;

export interface TriageVerdict {
  /** True when nobody needs to write back. */
  ignore: boolean;
  /** Why, in a few words, for the archive. Empty when replying. */
  reason: string;
}

const REPLY: TriageVerdict = { ignore: false, reason: '' };

function buildPrompt(task: Task, workspace: WorkspaceConfig): string {
  return `You are sorting the inbox of the support address at ${workspace.organization}${
    workspace.product ? `, which makes ${workspace.product}` : ''
  }.

Answer one question: does a human at this company need to write back?

Answer IGNORE only for mail sent to us rather than written to us:
- Cold sales outreach, agency pitches, SEO or backlink or guest-post offers
- Directory, leaderboard and "get featured" solicitations
- Marketing newsletters and promotional blasts
- Automated notifications, autoresponders and delivery receipts that ask
  nothing and expect no answer

Answer REPLY for everything else, and in particular for:
- Anyone who uses the product, pays for it, or is trying to
- A question, a complaint, a bug report or a refund request, however rude
- A named person proposing something specific to this company, even if what
  they want is a partnership rather than support — a real approach is not spam
- Anything you are not sure about

That last line is the important one. A pitch that gets answered costs a few
seconds of somebody's time. A customer that gets ignored costs the customer.

Reply with IGNORE followed by a short reason, or with the single word REPLY.
Examples:
IGNORE: guest-post backlink pitch
REPLY

Subject: ${task.subject}
From: ${task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}

${clip(htmlToText(task.body), TRIAGE_CHARS)}`;
}

/**
 * Whether this one can be dismissed unanswered.
 *
 * Never throws. Every unhappy path returns "reply", because the cost of this
 * step being unavailable should be the cost of not having it — a draft for a
 * piece of spam — and not a customer email disappearing into the archive.
 */
export async function triage(task: Task, workspace: WorkspaceConfig): Promise<TriageVerdict> {
  let answer: string;
  try {
    answer = await callAI(buildPrompt(task, workspace), {
      role: 'utility',
      // A verdict and a few words. Tight enough that a model inclined to
      // reason out loud runs out of room before it reaches a conclusion,
      // which the parsing below reads as "reply".
      maxTokens: 32,
      temperature: 0,
    });
  } catch (error) {
    console.warn('[drafting] triage failed, drafting anyway:', error);
    return REPLY;
  }

  const trimmed = answer.trim();
  // Anchored at the start, so a model that says "this is not IGNORE, reply"
  // is not read as a dismissal by a substring match.
  if (!/^ignore\b/i.test(trimmed)) return REPLY;

  const reason = trimmed.replace(/^ignore\b[:\-\s]*/i, '').trim();
  // A reason always, because the archive row is the only explanation anybody
  // gets for an email they never saw.
  return { ignore: true, reason: reason || 'not a support email' };
}
