import { CONSOLIDATE_RULES, consolidateRulesHandler } from './consolidate-rules';
import { DRAFT_REPLY, draftReplyHandler } from './draft-reply';
import { LEARN_FROM_SENT, learnFromSentHandler } from './learn-from-sent';
import type { JobHandler } from '../types';

/** The handlers a stock deployment runs. */
export const DEFAULT_HANDLERS: Record<string, JobHandler> = {
  [DRAFT_REPLY]: draftReplyHandler,
  [LEARN_FROM_SENT]: learnFromSentHandler,
  [CONSOLIDATE_RULES]: consolidateRulesHandler,
};

export * from './consolidate-rules';
export * from './draft-reply';
export * from './learn-from-sent';
