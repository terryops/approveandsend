import { getDb, type Db } from '../db';
import { createRule, listRules } from '../rules/store';
import { createTask, listTasks, updateTask, type TaskUpdate } from '../tasks/store';
import type { Analysis, NewTask } from '../tasks/types';

/**
 * A believable inbox, for the five minutes before a real mailbox is connected.
 *
 * An empty install cannot show what this is for: the review screen is a blank
 * page, the rulebook is empty, and the loop between them — a human edits a
 * draft, the edit becomes a rule, the next draft obeys it — is invisible. So
 * the fixtures below are not filler. They are one worked example of that loop,
 * with a sent reply whose edit explains the rule sitting in the rulebook.
 *
 * Everything is fictional and matches `aas.config.example.json` (Acme Cloud),
 * so a demo install reads coherently without touching the real config.
 */

interface DemoTask {
  task: NewTask;
  update: TaskUpdate;
}

function analysis(intent: string, scope: string, extra: Partial<Analysis> = {}): Analysis {
  return {
    intent,
    language: 'en',
    sentiment: 'neutral',
    keyPoints: [],
    suggestedActions: [],
    scope,
    ...extra,
  };
}

/** Relative to now, so a fresh demo never looks like it has been sitting for months. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

const DEMO_TASKS: DemoTask[] = [
  {
    task: {
      messageId: 'demo-1',
      messageIdHeader: 'demo-1@mail.example.com',
      subject: 'Refund for the annual plan',
      fromAddress: 'priya@example.com',
      fromName: 'Priya Raman',
      receivedAt: hoursAgo(2),
      body: `Hi,

I upgraded to the annual plan on Tuesday and realised the same evening that my
team is moving to a different tool next month. I have not used any of it since.
Could you refund the upgrade? And roughly when would the money be back?

Priya`,
      priority: 3,
    },
    update: {
      status: 'awaiting_review',
      scope: 'refund',
      analysis: analysis('Wants the annual upgrade refunded and asks when the money arrives', 'refund', {
        sentiment: 'neutral',
        keyPoints: ['Upgraded on Tuesday', 'Unused', 'Team is switching tools'],
        suggestedActions: ['Confirm eligibility', 'Do not give a specific date'],
      }),
      draft: `Hi Priya,

Thanks for being straightforward about it — an upgrade you have not used is an
easy one. I have started the refund for the annual plan.

Refunds are processed within 5-10 business days, though the exact timing is
your bank's rather than ours. You will get a confirmation email as soon as it
leaves our side.

— The Acme team`,
    },
  },
  {
    task: {
      messageId: 'demo-2',
      messageIdHeader: 'demo-2@mail.example.com',
      subject: 'Export finishes but the file is empty',
      fromAddress: 'martin@example.com',
      fromName: 'Martin Oduya',
      receivedAt: hoursAgo(5),
      body: `Every export I run today produces a 0 byte file. The progress bar goes to
100% and says "Done", so it looks like it worked until you open it. Workspace
is "oduya-studio", I have tried it in Firefox and Chrome.

This is blocking a handover due Friday.`,
      priority: 2,
    },
    update: {
      status: 'awaiting_review',
      scope: 'bug',
      analysis: analysis('Exports complete successfully but produce a 0 byte file', 'bug', {
        sentiment: 'negative',
        keyPoints: ['Workspace oduya-studio', 'Both browsers', 'Blocking a Friday deadline'],
        suggestedActions: ['Acknowledge the deadline', 'Ask for one export id'],
      }),
      draft: `Hi Martin,

An export that reports success and hands you nothing is worse than one that
fails, and I am sorry it landed on a week with a handover in it.

I can see exports running on oduya-studio. To find yours: could you send me the
id from the top of any of today's export rows? That gets me straight to the
job rather than guessing which one.

I will come back to you today either way, even if the answer is only how far I
have got.

— The Acme team`,
    },
  },
  {
    task: {
      messageId: 'demo-3',
      messageIdHeader: 'demo-3@mail.example.com',
      subject: 'Does the free plan include the API?',
      fromAddress: 'sam@example.com',
      fromName: 'Sam Whitfield',
      receivedAt: hoursAgo(9),
      body: `Quick one before I put this in front of my team — is the API available on
the free plan, or do we need to be on a paid one to try it?`,
    },
    update: {
      status: 'awaiting_review',
      scope: 'presales',
      analysis: analysis('Asks whether API access is included on the free plan', 'presales', {
        keyPoints: ['Evaluating for a team'],
        suggestedActions: ['Answer plainly', 'Do not oversell'],
      }),
      draft: `Hi Sam,

It is not — API access starts on the paid plans. The free plan is the full app
otherwise, so it is a fair way to judge everything except the integration side.

If you want to test the API before committing, reply here and I will turn it on
for your workspace for a couple of weeks.

— The Acme team`,
    },
  },
  {
    task: {
      messageId: 'demo-4',
      messageIdHeader: 'demo-4@mail.example.com',
      subject: 'Invoice needs our VAT number on it',
      fromAddress: 'accounts@example.org',
      fromName: 'Lena Fischer',
      receivedAt: hoursAgo(26),
      body: `Our finance team cannot file invoice ACME-3391 without our VAT number
printed on it (DE811907980). Could you reissue it?`,
    },
    update: {
      status: 'pending',
    },
  },
  {
    task: {
      messageId: 'demo-5',
      messageIdHeader: 'demo-5@mail.example.com',
      subject: 'Cancelling — and why',
      fromAddress: 'tom@example.com',
      fromName: 'Tom Bright',
      receivedAt: hoursAgo(50),
      body: `I am cancelling at the end of the month. Nothing dramatic: we needed shared
folders and waited about six months for them. If that ever ships, tell me and I
will look again.`,
    },
    update: {
      status: 'sent',
      scope: 'churn',
      analysis: analysis('Cancelling because shared folders never shipped', 'churn', {
        sentiment: 'negative',
        keyPoints: ['Waited ~6 months for shared folders', 'Open to returning'],
        suggestedActions: ['Do not pitch', 'Do not promise a date'],
      }),
      // The draft and what actually went out differ, and the difference is
      // exactly what the rule below was learned from.
      draft: `Hi Tom,

I am really sorry to see you go! Shared folders are absolutely on our roadmap
and should be landing in the next quarter — I would love for you to stay and
see them. In the meantime, would you consider a discount on the next three
months while you wait?

If you do decide to leave, we would really appreciate a review.

— The Acme team`,
      finalReply: `Hi Tom,

That is a fair reason to leave, and six months is a long time to wait for
something you were counting on.

Shared folders are being worked on. I am not going to give you a date, because
the last one we gave was wrong. When they ship I will email you personally.

Your access runs to the end of the month and your data stays exportable
throughout.

— The Acme team`,
      reviewerNotes: 'No date, no discount pitch, no review ask from someone who just left.',
      sentAt: hoursAgo(49),
    },
  },
];

interface DemoRule {
  content: string;
  category: 'policy' | 'product' | 'tone' | 'general';
  rationale: string;
  scope: string | null;
  /** The demo message id this was learned from, when it was learned. */
  learnedFrom?: string;
}

const DEMO_RULES: DemoRule[] = [
  {
    content:
      'Never give a date for an unreleased feature, including vague ones like "next quarter".',
    category: 'policy' as const,
    rationale: 'A reviewer cut a roadmap date out of a cancellation reply.',
    scope: null,
    learnedFrom: 'demo-5',
  },
  {
    content:
      'Do not ask a customer for a review or referral in the same email where they are cancelling or complaining.',
    category: 'policy' as const,
    rationale: 'Removed from a churn reply as tone-deaf.',
    scope: null,
    learnedFrom: 'demo-5',
  },
  {
    content:
      'Refunds take 5-10 business days and the timing belongs to the customer bank — say that rather than naming a day.',
    category: 'product' as const,
    rationale: 'The only accurate thing we can say about refund timing.',
    scope: 'refund',
  },
  {
    content: 'Apologise at most once in a reply, and only for something we actually did.',
    category: 'tone' as const,
    rationale: 'Reviewers keep deleting the second and third apology.',
    scope: null,
  },
  {
    content:
      'When a customer names a deadline, say when they will next hear from you, even if the answer is not ready.',
    category: 'general' as const,
    rationale: 'Added by hand after a bug report went quiet for two days.',
    scope: null,
  },
];

export interface SeedResult {
  tasks: number;
  rules: number;
  /** True when there was already data and nothing was written. */
  skipped: boolean;
}

/**
 * Fills an empty install with the fixtures above.
 *
 * Refuses to do anything when the database already has tasks or rules. This is
 * reachable from a button in the UI, and the one unforgivable outcome would be
 * demo mail appearing in a real reviewer's queue.
 */
export function seedDemoData(db: Db = getDb()): SeedResult {
  // Proposals included, and this is the load-bearing case: a rulebook of
  // nothing but pending suggestions reads as empty to a query that hides them,
  // and this check is the only thing standing between a live desk and a queue
  // full of demo mail.
  if (
    listTasks({ limit: 1 }, db).length > 0 ||
    listRules({ proposed: 'include' }, db).length > 0
  ) {
    return { tasks: 0, rules: 0, skipped: true };
  }

  const write = db.transaction(() => {
    // Tasks first, so the rules learned from the cancellation reply can point
    // at it. "Which email taught this rule?" is a link in the UI, and a demo
    // where it goes nowhere is a demo of the wrong thing.
    const ids = new Map<string, string>();
    for (const { task, update } of DEMO_TASKS) {
      const { task: created } = createTask(task, db);
      updateTask(created.id, update, db);
      if (task.messageId) ids.set(task.messageId, created.id);
    }

    for (const { learnedFrom, ...rule } of DEMO_RULES) {
      createRule({ ...rule, sourceTaskId: learnedFrom ? ids.get(learnedFrom) ?? null : null }, db);
    }
  });
  write();

  return { tasks: DEMO_TASKS.length, rules: DEMO_RULES.length, skipped: false };
}
