import { getDb, type Db } from '../db';
import { createRule, listRules } from './store';
import type { NewRule } from './types';

/**
 * The rulebook a desk starts with, before it has learned anything.
 *
 * An empty rulebook is not neutral. The first few hundred replies go out with
 * nothing but the persona behind them, and the rules that would have caught
 * the bad ones only get written after somebody has already sent them. So there
 * is a set to start from — but offered, never installed silently. Every rule
 * in this system is meant to be something the desk can account for, and a rule
 * that appeared on its own is the one thing a reviewer cannot argue with
 * because they never agreed to it.
 *
 * What is in here, and what is deliberately not:
 *
 *   - Only things that are true of every support desk. "Do not invent a fact"
 *     holds everywhere; "refunds take ten days" is this desk's answer and has
 *     to be learned or typed.
 *   - Nothing already covered by the workspace config. The never-promise list
 *     and the voice are in the persona block already, and a starter rule
 *     repeating them would be a second copy to keep in step.
 *   - No topics. These apply to every kind of mail, which is why they are safe
 *     to ship: nothing here depends on knowing what the desk sells.
 *
 * They are written in English because every prompt in this system is, and the
 * language a reply goes out in is a separate setting. A desk that reads its
 * own mail in Japanese still hands these to the model in English.
 *
 * They carry hand-written summaries so the rules page is scannable the moment
 * they land, without waiting for a summarising pass to run.
 */

interface StarterRule extends NewRule {
  content: string;
  summary: string;
}

export const STARTER_RULES: readonly StarterRule[] = [
  {
    category: 'policy',
    content:
      'Never state a fact about this customer\'s account, order or usage that is not in the context above. If it is not there, say what you will do to find out.',
    summary: 'Facts about the customer that are not in front of you',
  },
  {
    category: 'policy',
    content:
      'Never commit to a date, an amount of money, or an exception to the normal terms. Say what happens next and who decides.',
    summary: 'Promising dates, money, or an exception',
  },
  {
    category: 'policy',
    content:
      'If answering would need access, a permission or a change that only a person can make, say so plainly and leave the reply for a human to finish rather than guessing.',
    summary: 'When the answer needs something only a person can do',
  },
  {
    category: 'general',
    content:
      'Answer the question that was actually asked, first, in the opening line. Background and caveats come after.',
    summary: 'Putting the answer before the preamble',
  },
  {
    category: 'general',
    content:
      'When the message contains several questions, answer every one of them. If one cannot be answered, say which and why.',
    summary: 'Mail that asks more than one thing',
  },
  {
    category: 'general',
    content:
      'When something has gone wrong, say what is known, what is not yet known, and what happens next. Do not speculate about the cause.',
    summary: 'What to say about a failure that is not yet understood',
  },
  {
    category: 'general',
    content:
      'Ask for the one detail that would actually unblock the answer — an order number, an error message, a link — rather than a list of everything that might help.',
    summary: 'Asking the customer for more information',
  },
  {
    category: 'general',
    content:
      'Do not send a link instead of an answer. Answer, then link to the longer version.',
    summary: 'Linking to documentation',
  },
  {
    category: 'tone',
    content:
      'Reply in the language the customer wrote in, unless the reply language is set to something specific.',
    summary: 'Which language to reply in',
  },
  {
    category: 'tone',
    content:
      'Apologise at most once, and only for something that actually happened. A reply that opens with an apology and repeats it twice reads as evasive.',
    summary: 'How much to apologise',
  },
  {
    category: 'tone',
    content:
      'When the customer is angry, drop the pleasantries and lead with what is being done. Matching their intensity and over-apologising are both wrong.',
    summary: 'Answering an angry message',
  },
  {
    category: 'tone',
    content:
      'Do not mention an upgrade, a plan, or anything else for sale in a reply to a complaint, a cancellation or an outage.',
    summary: 'Selling in the wrong conversation',
  },
  {
    category: 'tone',
    content:
      'No filler openings — "Thank you for reaching out", "We appreciate your patience", "I hope this message finds you well". Start with the substance.',
    summary: 'Opening lines that say nothing',
  },
  {
    category: 'tone',
    content:
      'Write the way one person writes to another: short sentences, no internal jargon, no ticket numbers or system names the customer has never seen.',
    summary: 'Plain language and internal jargon',
  },
];

export interface StarterInstall {
  added: number;
  /** Already present, matched on the exact text. Re-running adds nothing. */
  skipped: number;
}

/**
 * Adds the starter rules that are not already there.
 *
 * Idempotent by content, so pressing the button twice does not give a desk two
 * copies of every rule — and a desk that has since edited or retired one of
 * them gets the edited one left alone, because the point of a starter rule is
 * that it stops being a starter rule the moment somebody takes it over.
 */
export function installStarterRules(db: Db = getDb()): StarterInstall {
  // Every rule, not just the enabled ones: a rule somebody deliberately
  // retired must not come back the next time this is pressed.
  const existing = new Set(listRules({}, db).map(rule => rule.content.trim()));

  let added = 0;
  let skipped = 0;

  const write = db.transaction(() => {
    for (const rule of STARTER_RULES) {
      if (existing.has(rule.content.trim())) {
        skipped += 1;
        continue;
      }
      createRule(
        {
          ...rule,
          rationale: 'Starter rule. Edit it, retire it, or leave it — it is yours now.',
        },
        db,
      );
      added += 1;
    }
  });
  write();

  return { added, skipped };
}
