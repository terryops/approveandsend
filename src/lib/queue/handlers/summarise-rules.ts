import { getDb, type Db } from '../../db';
import { listRules } from '../../rules/store';
import { attachSummary, summariseRules, SUMMARY_BATCH } from '../../rules/summarise';
import { enqueue, type EnqueueResult } from '../store';
import type { JobHandler } from '../types';

/**
 * Keeping the rulebook's index up to date, as a job.
 *
 * One job for the whole backlog rather than one job per rule. A rule is
 * summarised because somebody wrote it or changed it, and both of those happen
 * in bursts — a learning pass that extracts nine rules from one conversation
 * would otherwise put nine near-identical jobs in the queue and make nine
 * calls to summarise a paragraph each. Deduped on a fixed key, so the burst
 * collapses into one pass that picks up everything outstanding.
 *
 * Nothing waits on this. A rule with no summary is still injected in full and
 * still obeyed; it is only missing from the scannable list until the next
 * pass, which is why this sits at the back of the queue.
 */

export const SUMMARISE_RULES = 'summarise-rules';

/** Batches per run, before the job re-enqueues itself. */
const BATCHES_PER_RUN = 5;

export function enqueueSummariseRules(
  options: { priority?: number; delayMs?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    SUMMARISE_RULES,
    {
      dedupeKey: SUMMARISE_RULES,
      // Behind drafting and translation, ahead of the weekly tidy. Nothing
      // downstream blocks on it.
      priority: options.priority ?? 8,
      maxAttempts: 2,
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
    },
    options.db ?? getDb(),
  );
}

export const summariseRulesHandler: JobHandler = async (_payload, context) => {
  let summarised = 0;
  let skipped = 0;

  for (let batch = 0; batch < BATCHES_PER_RUN; batch += 1) {
    // Re-queried each time rather than paged: the rules just summarised have
    // dropped out of this set, so the next batch is always the next unsummarised
    // rules with no offset to keep in step. Disabled rules are included — a rule
    // somebody is about to turn back on should already be scannable.
    const pending = listRules({ unsummarisedOnly: true, limit: SUMMARY_BATCH }, context.db);
    if (pending.length === 0) break;

    const summaries = await summariseRules(pending);

    for (const rule of pending) {
      const summary = summaries.get(rule.id);
      // No summary, or the rule's text moved while the call was in flight.
      // Either way it stays in the queue for the next pass.
      if (!summary || !attachSummary(rule.id, summary, rule.content, context.db)) {
        skipped += 1;
        continue;
      }
      summarised += 1;
    }

    // Every rule in the batch came back unusable. Trying the next batch would
    // most likely burn the same call again, and the run is not urgent.
    if (summarised === 0) break;
  }

  const remaining = listRules({ unsummarisedOnly: true }, context.db).length;

  // The dedupe key is free again the moment this job finishes, so a backlog
  // larger than one run picks itself up. The delay keeps a rulebook of
  // thousands from monopolising the worker.
  if (remaining > 0 && summarised > 0) {
    enqueueSummariseRules({ delayMs: 5_000, db: context.db });
  }

  return { summarised, skipped, remaining };
};
