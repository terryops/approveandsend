/**
 * What went wrong with the queue, in a sentence, and where to go about it.
 *
 * Nobody opens this screen out of curiosity. It gets opened because something
 * did not happen — a draft never appeared, a reply never went — so the first
 * line has to answer that question. It currently opens with five counts and a
 * table of fifty rows, and the counts answer "how much", which is not what was
 * asked.
 *
 * The way out is the half that matters. `AI_MODEL is required` is fixed by
 * going to setup and picking a model; it is not fixed by pressing Retry, and
 * Retry is the only button on the screen. An error message whose only offered
 * action cannot work teaches the operator that the action does not work, not
 * where the fix lives.
 *
 * The matching is a closed, hardcoded list rather than anything clever, and
 * every entry corresponds to an error this codebase throws on purpose. Anything
 * unrecognised says so and puts the original text on screen unedited — a
 * confidently wrong signpost costs more than no signpost, because it sends
 * somebody to change a setting that was never the problem.
 */

import type { MessageKey } from '@/lib/i18n';

import type { Job } from './types';

export interface QueueVerdict {
  /** Whether anything is wrong. When false the block above the table is green,
      and short — "nothing is stuck" does not need a paragraph. */
  stuck: boolean;
  /** The job it is talking about, so the table below can mark the same row. */
  jobId?: string;
  /** The one sentence. */
  what: MessageKey;
  /** Where to go. Absent where there is nowhere honest to point. */
  fix?: { href: string; label: MessageKey };
}

/** The failures this desk raises itself, and what each one actually needs. */
const KNOWN: { match: RegExp; what: MessageKey; fix?: QueueVerdict['fix'] }[] = [
  {
    match: /AI_MODEL is required|no model configured/i,
    what: 'queue.verdict.noModel',
    fix: { href: '/setup/model', label: 'queue.verdict.goConfigureModel' },
  },
  {
    match: /invalid api key|\b401\b|unauthorized/i,
    what: 'queue.verdict.badKey',
    fix: { href: '/setup/model', label: 'queue.verdict.goConfigureModel' },
  },
  {
    match: /IMAP|SMTP|ECONNREFUSED|ENOTFOUND|login failed/i,
    what: 'queue.verdict.mailbox',
    fix: { href: '/setup/mailbox', label: 'queue.verdict.goConfigureMailbox' },
  },
  {
    match: /re-?sync required|UIDVALIDITY/i,
    what: 'queue.verdict.resync',
  },
  {
    // The one class where trying again might genuinely work, so it is also the
    // one that offers no way out: the Retry button on the row below already is
    // the right answer, and a second one here would be the same button twice.
    match: /timed out|ETIMEDOUT|headersTimeout/i,
    what: 'queue.verdict.timeout',
  },
];

/**
 * Reads a page of jobs and comes back with the one thing worth saying.
 *
 * The most recent failure rather than the oldest: `listJobs` hands them back
 * newest-first, and an error that was fixed yesterday sitting at the top of the
 * screen sends somebody to investigate a problem that no longer exists.
 */
export function readQueue(jobs: readonly Job[]): QueueVerdict {
  const failed = jobs.find(job => job.status === 'failed');
  if (!failed) return { stuck: false, what: 'queue.verdict.clear' };

  const known = KNOWN.find(entry => entry.match.test(failed.error ?? ''));

  return {
    stuck: true,
    jobId: failed.id,
    // Unrecognised stays unrecognised. The original text is put on the page by
    // the caller rather than paraphrased here.
    what: known?.what ?? 'queue.verdict.unknown',
    ...(known?.fix ? { fix: known.fix } : {}),
  };
}
