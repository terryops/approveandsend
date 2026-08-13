import { getWorkspaceConfig } from '../config/workspace';
import { enqueueContextThenCompose } from '../queue/handlers/enrich-context';
import { DISPUTE_SOURCE } from '../tasks/categories';
import { createTask } from '../tasks/store';
import { analyseDisputes } from './disputes';
import {
  day,
  getCharge,
  listOpenDisputes,
  money,
  payerEmail,
  stripeConfigured,
  type StripeDispute,
} from './stripe';

/**
 * A chargeback, as a piece of work somebody has to do this week.
 *
 * Everything else in this app waits to be written to. A dispute is the one
 * thing on a support desk that arrives without a message: the customer told
 * their bank, the bank told Stripe, and the first anybody here hears of it is
 * an email from Stripe that goes to whoever set up the account. Meanwhile there
 * is a date — usually three weeks out — after which the money is simply gone,
 * decided by nobody.
 *
 * So this is the reverse of the mailbox sync. It reads the account rather than
 * an inbox, and for every open dispute it opens a task addressed to the person
 * who filed it, with the letter's instructions already in the brief. The desk
 * then sees it where it sees everything else, in a queue, with a deadline on
 * it, instead of in a notification email nobody owns.
 *
 * ## Idempotent by external id
 *
 * `stripe-dispute:<id>`, so running this every hour re-finds the same disputes
 * and creates nothing. That matters more here than at the mail intake: a
 * dispute stays open for weeks, so every run after the first sees the whole set
 * again, and a duplicate would be a second draft of a letter somebody is
 * halfway through editing.
 */

export interface DisputeSyncResult {
  /** Open disputes Stripe reported. */
  found: number;
  /** Tasks opened by this run. */
  created: number;
  /** Already had a task, which is the ordinary outcome of every run but the first. */
  existed: number;
  /** Open disputes with no address to write to; see `skipped` for why. */
  unaddressed: number;
  /** Why each unaddressed one was left, for the log rather than the screen. */
  skipped: string[];
  /** Set when Stripe is off or refused, instead of throwing at a cron job. */
  error?: string;
}

/** The heading a reviewer reads on the row, which is never sent anywhere. */
export function disputeTitle(dispute: StripeDispute): string {
  const due = dispute.evidence_details?.due_by;
  return [
    money(dispute.amount, dispute.currency),
    // The bare code, made readable — not `reasonOf`, which is a full sentence
    // written for the model to read inside the brief. A row heading has about
    // four words before it starts pushing the date off the end of the line, and
    // the sentence is thirteen.
    dispute.reason.replace(/_/g, ' '),
    due ? `due ${day(due)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Opens a task for every open dispute that does not have one.
 *
 * Never throws. It is called by a cron endpoint, and a Stripe outage at 3am
 * should be a line in a log rather than a 500 that some monitor pages somebody
 * about.
 */
export async function syncDisputeTasks(): Promise<DisputeSyncResult> {
  const empty: DisputeSyncResult = { found: 0, created: 0, existed: 0, unaddressed: 0, skipped: [] };

  if (!stripeConfigured()) return { ...empty, error: 'Stripe is not configured' };

  let disputes: StripeDispute[];
  try {
    disputes = await listOpenDisputes();
  } catch (error) {
    // The ordinary cause is a restricted key without the `disputes` permission,
    // which is most keys — this feature asks for one more than the billing card
    // does. Reported, not thrown, and not retried: the next run is an hour away
    // and the permission will not have appeared by itself.
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }

  const result: DisputeSyncResult = { ...empty, found: disputes.length, skipped: [] };
  const { refundOnDisputeWithdrawal } = getWorkspaceConfig();

  for (const dispute of disputes) {
    let charge;
    let to: string | null;
    try {
      charge = await getCharge(dispute.charge);
      to = await payerEmail(charge);
    } catch (error) {
      result.unaddressed += 1;
      result.skipped.push(`${dispute.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    // A payment taken through a channel that kept no address. There is nothing
    // to write to and inventing a task with an empty recipient would put a row
    // on the queue that cannot be finished — so it is counted and named, and
    // the deadline stays in Stripe where somebody has to go anyway.
    if (!to) {
      result.unaddressed += 1;
      result.skipped.push(`${dispute.id}: no email on the charge or the customer`);
      continue;
    }

    // The brief is the analysis, verbatim. It is already written as
    // instructions — what the payment was, what the bank was told, what this
    // reply may not say, and the letter to write instead — so summarising it
    // here would be a second, worse copy of the same paragraphs, kept in step
    // by hand.
    const analysis = analyseDisputes([charge], [dispute], {
      offerRefundOnWithdrawal: refundOnDisputeWithdrawal,
    });

    const { task, existed } = createTask({
      origin: 'composed',
      source: DISPUTE_SOURCE,
      externalId: `stripe-dispute:${dispute.id}`,
      fromAddress: to,
      subject: charge.description ?? 'Your payment',
      title: disputeTitle(dispute),
      body: analysis.lines.join('\n\n'),
      // Ahead of everything a person typed, which is a thing this desk does
      // almost nowhere else. It is not that a chargeback matters more than a
      // customer — it is that this one expires. Every other row on the queue is
      // still there tomorrow.
      priority: 1,
    });

    if (existed) {
      result.existed += 1;
      continue;
    }

    result.created += 1;
    // The same pair of jobs the intake endpoint enqueues: look the customer up
    // first, then write. The context lookup is what puts their usage and their
    // payment history in front of the model, and a chargeback letter with no
    // specifics in it is a form letter.
    await enqueueContextThenCompose(task.id);
  }

  return result;
}
