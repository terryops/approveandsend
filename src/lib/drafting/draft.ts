import { callAI } from '../ai';
import { describeWorkspace, getWorkspaceConfig, type WorkspaceConfig } from '../config/workspace';
import type { Db } from '../db';
import { getDb } from '../db';
import { extractJson } from '../json-repair';
import { selectRules } from '../rules/prompt';
import { listRules, recordApplied } from '../rules/store';
import type { Analysis, Task } from '../tasks/types';
import { isSentiment } from '../tasks/types';
import { clip, htmlToText } from '../thread-context';

/**
 * Reading a customer's email and writing a reply to it.
 *
 * One call, not two. The predecessor ran an analysis pass and then a separate
 * drafting pass over the same email, which doubled the latency and the cost to
 * produce a draft that could contradict its own analysis. The critic pass
 * below is a genuinely independent second opinion; splitting analysis from
 * drafting was not.
 */

const MAX_BODY_CHARS = 12_000;

export interface DraftResult {
  analysis: Analysis;
  draft: string;
  /** Rules that went into the prompt, already counted against their telemetry. */
  appliedRuleIds: string[];
  /** Rules the character budget pushed out, so the caller can log it. */
  droppedRuleIds: string[];
  /** The critic's verdict, when a critic pass ran. */
  critique?: Critique;
}

export interface DraftOptions {
  /** Skip the second opinion. Halves the cost of a draft. */
  critic?: boolean;
  workspace?: WorkspaceConfig;
  db?: Db;
}

export interface Critique {
  /** False when the critic found something that must be fixed before sending. */
  approved: boolean;
  issues: string[];
  /** Present only when the critic rewrote the draft. */
  revised?: string;
}

function buildPrompt(task: Task, workspace: WorkspaceConfig, rulesBlock: string): string {
  const body = clip(htmlToText(task.body), MAX_BODY_CHARS);

  return `${describeWorkspace(workspace)}${rulesBlock}

## The customer's email
From: ${task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
Subject: ${task.subject}

${body}

## What to return
JSON only, no prose around it:
{
  "intent": "one specific sentence about what this person wants and why — 'wants a refund because the export was silent', not 'refund'",
  "language": "ISO 639-1 code of the language they wrote in",
  "sentiment": "positive | neutral | negative | angry",
  "scope": "a short lowercase slug for the kind of mail this is, e.g. refund, bug-report, sales, how-to",
  "keyPoints": ["what they actually said, in their terms"],
  "suggestedActions": ["what a human may need to do outside this reply, if anything"],
  "draft": "the reply itself, plain text, ready to send${workspace.signature ? '' : ' — no signature'}"
}`;
}

function parseDraft(raw: string): { analysis: Analysis; draft: string } | null {
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed) return null;

  const draft = typeof parsed.draft === 'string' ? parsed.draft.trim() : '';
  // A draft is the one field with no sensible default. Everything else can be
  // empty and the reviewer still has something to work with.
  if (!draft) return null;

  return {
    draft,
    analysis: {
      intent: typeof parsed.intent === 'string' ? parsed.intent.trim() : '',
      language: typeof parsed.language === 'string' ? parsed.language.trim().toLowerCase() : '',
      sentiment: isSentiment(parsed.sentiment) ? parsed.sentiment : 'neutral',
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.filter((p): p is string => typeof p === 'string')
        : [],
      suggestedActions: Array.isArray(parsed.suggestedActions)
        ? parsed.suggestedActions.filter((p): p is string => typeof p === 'string')
        : [],
      ...(typeof parsed.scope === 'string' && parsed.scope.trim()
        ? { scope: parsed.scope.trim().toLowerCase() }
        : {}),
    },
  };
}

export async function draftReply(task: Task, options: DraftOptions = {}): Promise<DraftResult> {
  const db = options.db ?? getDb();
  const workspace = options.workspace ?? getWorkspaceConfig();

  // Scope is not known until the analysis has run, so the first draft for a
  // task sees the unscoped rules plus whichever scope the task already
  // carries. A regeneration, which does know, sees the right set.
  const rules = listRules({ enabledOnly: true }, db);
  const block = selectRules(rules, { ...(task.scope ? { scope: task.scope } : {}) });

  const raw = await callAI(buildPrompt(task, workspace, block.text), { role: 'drafter' });
  const parsed = parseDraft(raw);
  if (!parsed) {
    throw new Error('The drafter returned no usable draft');
  }

  // Telemetry is recorded once the draft exists, not when the prompt is built:
  // a failed generation should not inflate a rule's usage count.
  recordApplied(block.includedIds, db);

  const signed = workspace.signature ? `${parsed.draft}\n\n${workspace.signature}` : parsed.draft;

  const result: DraftResult = {
    analysis: parsed.analysis,
    draft: signed,
    appliedRuleIds: block.includedIds,
    droppedRuleIds: block.droppedIds,
  };

  if (options.critic) {
    const critique = await criticise(task, signed, workspace, block.text);
    if (critique) {
      result.critique = critique;
      if (critique.revised) result.draft = critique.revised;
    }
  }

  return result;
}

/**
 * A second model reads the draft against the same rules and either signs it
 * off or rewrites it.
 *
 * Worth its cost because the failure it catches is the expensive one: a draft
 * that reads perfectly well and quietly breaks a policy. It is optional, and a
 * critic that itself fails is not allowed to lose the draft — the reviewer can
 * judge an uncriticised draft perfectly well, and the original's habit of
 * failing the whole task when the review step errored meant a transient blip
 * threw away a good generation.
 */
async function criticise(
  task: Task,
  draft: string,
  workspace: WorkspaceConfig,
  rulesBlock: string,
): Promise<Critique | undefined> {
  const prompt = `You are reviewing a support reply before a human sees it. You did not write it.

${describeWorkspace(workspace)}${rulesBlock}

## The customer's email
Subject: ${task.subject}

${clip(htmlToText(task.body), MAX_BODY_CHARS)}

## The proposed reply
${draft}

Check it for: claims that are not supported by the facts above, anything on the
never-promise list, breaches of the rules, the wrong language, and tone that
does not match. Ignore matters of taste — a reply you would have phrased
differently is not a problem.

JSON only:
{
  "approved": true or false,
  "issues": ["what is wrong, specifically; empty when approved"],
  "revised": "the corrected reply in full — include this ONLY if approved is false"
}`;

  try {
    const parsed = extractJson<Record<string, unknown>>(await callAI(prompt, { role: 'critic' }));
    if (!parsed) return undefined;

    const approved = parsed.approved !== false;
    const revised = typeof parsed.revised === 'string' ? parsed.revised.trim() : '';

    return {
      approved,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === 'string') : [],
      // A rewrite that comes back with an approval is the critic contradicting
      // itself; trust the verdict and keep the draft we already had.
      ...(!approved && revised ? { revised } : {}),
    };
  } catch (error) {
    console.warn('[drafting] critic pass failed, keeping the draft as written:', error);
    return undefined;
  }
}
