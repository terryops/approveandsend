import { getDb, type Db } from '../../db';
import { snapshot } from '../../db/snapshot';
import { notify } from '../../notify';
import {
  applyConsolidation,
  consolidationGate,
  planConsolidation,
  type ConsolidationSummary,
} from '../../rules/consolidate';
import { enqueue, type EnqueueResult } from '../store';
import { enqueueSummariseRules } from './summarise-rules';
import type { JobHandler } from '../types';

/**
 * The weekly tidy of the rulebook, as a job.
 *
 * It belongs in the queue and not in a cron script for the same reason the
 * learning pass does: it is a dozen LLM calls that can take half an hour, and
 * a cron entry that shells out to a script is a second way to run the same
 * code, with its own database handle and its own idea of where the config
 * lives. Cron pokes `/api/consolidate`; the queue does the work.
 */

export const CONSOLIDATE_RULES = 'consolidate-rules';

export interface ConsolidateRulesPayload {
  /** Skip the gate. What the button on the rules page sends. */
  force?: boolean;
}

export function enqueueConsolidateRules(
  options: { force?: boolean; priority?: number; db?: Db } = {},
): EnqueueResult {
  return enqueue(
    CONSOLIDATE_RULES,
    {
      payload: { force: options.force ?? false } satisfies ConsolidateRulesPayload,
      // One at a time, always. Two passes planning against the same rules
      // would both propose merges, and the second would apply its plan on top
      // of a rulebook that no longer matches it.
      dedupeKey: CONSOLIDATE_RULES,
      // Last. Nothing about this is urgent, and it must not delay a draft.
      priority: 9,
      // Not retried: a failed pass has usually half-planned against rules that
      // have since moved, and the next weekly run is a better answer than an
      // immediate retry.
      maxAttempts: 1,
    },
    options.db ?? getDb(),
  );
}

export interface ConsolidateOutcome extends Partial<ConsolidationSummary> {
  ran: boolean;
  changed: number;
  before?: number;
  after?: number;
  /** Where the rulebook can be recovered from, when the pass changed one. */
  backup?: string;
}

export const consolidateRulesHandler: JobHandler = async (
  payload,
  context,
): Promise<ConsolidateOutcome> => {
  const force = Boolean((payload as ConsolidateRulesPayload | null)?.force);
  const gate = consolidationGate({ db: context.db });

  if (!force && !gate.shouldRun) {
    return { ran: false, changed: gate.changed };
  }

  const plan = await planConsolidation({ db: context.db });

  // After the planning and before the writing, which is the only window where
  // it is both worth taking and worth the wait: the plan is what says anything
  // is about to change, and by here the LLM calls are already paid for.
  const backup = plan.after < plan.before ? await snapshot('consolidate', context.db) : null;

  const summary = applyConsolidation(plan, { actor: context.job.id, db: context.db });

  // Every rule the tidy rewrote lost its summary along with the text it
  // described. Re-index before anybody scans the result of the merge.
  if (plan.after < plan.before) enqueueSummariseRules({ db: context.db });

  // Only when it actually did something. A weekly "nothing to tidy" is how a
  // notification channel teaches people to stop reading it, and this is the
  // one message in the product that has to be read.
  if (summary.merged > 0 || summary.rewritten > 0) {
    await notify(
      `Rulebook tidied: ${plan.before} rules are now ${plan.after}. ` +
        `${summary.merged} group(s) merged, ${summary.rewritten} rule(s) rewritten, ` +
        `${summary.disabled} disabled.` +
        (backup ? ` Copy of the rulebook as it stood: ${backup}` : ''),
    );
  }

  return {
    ran: true,
    changed: gate.changed,
    before: plan.before,
    after: plan.after,
    ...summary,
    ...(backup ? { backup } : {}),
  };
};
