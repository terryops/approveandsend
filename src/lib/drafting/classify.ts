import { callAI } from '../ai';
import { normaliseTopicSlug, type WorkspaceConfig } from '../config/workspace';
import type { Task } from '../tasks/types';
import { clip, htmlToText } from '../thread-context';

/**
 * Deciding what an email is about, before deciding what to say back.
 *
 * This exists because of an ordering problem that had made topic routing
 * almost useless. Rules are chosen by topic, the topic came out of the
 * drafting call, and so the first draft of every task — the one a reviewer
 * actually reads — was routed by nothing. Measured on a real desk: 84 of 354
 * rules reached a first draft and 270 did not, including every product rule
 * the desk had. Only a regeneration, which already knew the topic, saw the
 * right set.
 *
 * So the topic is settled first, in its own call. Deliberately not the
 * "analysis pass" this codebase removed: that one re-read the mail, formed its
 * own opinion of intent and tone, and handed the drafter a second opinion to
 * contradict. This asks one question, answers with one word, and is the only
 * thing in the system that owns the topic — the drafter is no longer asked
 * for it, so there is nothing for the two to disagree about.
 *
 * It runs on the utility model with a tiny output, which is the whole reason
 * it is affordable: a few hundred tokens to make the difference between a
 * reply written against 84 rules and one written against all of them.
 */

/** Enough to classify. The rest of a long thread does not change the answer. */
const CLASSIFY_CHARS = 2_000;

function buildPrompt(task: Task, workspace: WorkspaceConfig): string {
  const lines = workspace.topics.map(topic =>
    topic.description ? `- ${topic.slug}: ${topic.description}` : `- ${topic.slug}`,
  );

  return `Classify a customer support email so the right guidance can be pulled up before it is answered.

The kinds of mail this desk gets:
${lines.join('\n')}

Reply with exactly one name from that list, copied exactly, and nothing else.
If the mail is about more than one, pick the one the customer most needs
answered. If none of them fits, reply with: none

Subject: ${task.subject}
From: ${task.fromAddress}

${clip(htmlToText(task.body), CLASSIFY_CHARS)}`;
}

/**
 * The topic, or undefined.
 *
 * Undefined for every unhappy path — no vocabulary configured, a name that is
 * not in it, the call failing — and all of them land on the same behaviour as
 * before this existed: the reply is written against the rules that apply to
 * everything. A misrouted draft is worse than an unrouted one, so a name that
 * does not match is dropped rather than guessed at.
 */
export async function classifyTopic(
  task: Task,
  workspace: WorkspaceConfig,
): Promise<string | undefined> {
  if (workspace.topics.length === 0) return undefined;

  let answer: string;
  try {
    answer = await callAI(buildPrompt(task, workspace), {
      role: 'utility',
      // One slug. A limit this tight also stops a chatty model from
      // explaining itself, which is what the parsing below would trip over.
      maxTokens: 24,
      temperature: 0,
    });
  } catch (error) {
    // Never fatal. A draft written against the always-on rules is the status
    // quo; no draft at all is a regression.
    console.warn('[drafting] topic classification failed, routing on nothing:', error);
    return undefined;
  }

  const slug = normaliseTopicSlug(answer.trim().split(/\s+/)[0] ?? '');
  if (!slug || slug === 'none') return undefined;
  return workspace.topics.some(topic => topic.slug === slug) ? slug : undefined;
}
