import { BACKFILL_LEARN, BACKFILL_SCAN, backfillLearnHandler, backfillScanHandler } from './backfill';
import { COMPOSE_MESSAGE, composeMessageHandler } from './compose-message';
import { CONSOLIDATE_RULES, consolidateRulesHandler } from './consolidate-rules';
import { DRAFT_REPLY, draftReplyHandler } from './draft-reply';
import { ENRICH_CONTEXT, enrichContextHandler } from './enrich-context';
import { LEARN_FROM_REJECTION, learnFromRejectionHandler } from './learn-from-rejection';
import { LEARN_FROM_SENT, learnFromSentHandler } from './learn-from-sent';
import { SUGGEST_ALTERNATIVES, suggestAlternativesHandler } from './suggest-alternatives';
import { SUMMARISE_RULES, summariseRulesHandler } from './summarise-rules';
import { TRANSLATE_TASK, translateTaskHandler } from './translate-task';
import { TRIAGE, triageHandler } from './triage';
import type { JobHandler } from '../types';

/** The handlers a stock deployment runs. */
export const DEFAULT_HANDLERS: Record<string, JobHandler> = {
  [TRIAGE]: triageHandler,
  [ENRICH_CONTEXT]: enrichContextHandler,
  [DRAFT_REPLY]: draftReplyHandler,
  [COMPOSE_MESSAGE]: composeMessageHandler,
  [LEARN_FROM_SENT]: learnFromSentHandler,
  [LEARN_FROM_REJECTION]: learnFromRejectionHandler,
  [TRANSLATE_TASK]: translateTaskHandler,
  [SUGGEST_ALTERNATIVES]: suggestAlternativesHandler,
  [SUMMARISE_RULES]: summariseRulesHandler,
  [CONSOLIDATE_RULES]: consolidateRulesHandler,
  [BACKFILL_SCAN]: backfillScanHandler,
  [BACKFILL_LEARN]: backfillLearnHandler,
};

export * from './backfill';
export * from './compose-message';
export * from './consolidate-rules';
export * from './draft-reply';
export * from './enrich-context';
export * from './learn-from-rejection';
export * from './learn-from-sent';
export * from './suggest-alternatives';
export * from './summarise-rules';
export * from './translate-task';
export * from './triage';
