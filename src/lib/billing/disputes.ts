import { day, money, type StripeCharge, type StripeDispute } from './stripe';

/**
 * What a chargeback means for the reply being written.
 *
 * The rest of the billing code answers questions about money that has moved.
 * This one answers a question about money that is moving *now*, against us,
 * through somebody else's process — and that changes what a support desk is
 * allowed to say in a way no other billing fact does.
 *
 * The sentence this file exists to stop is "no problem, I've refunded you".
 * Written to somebody with an open dispute it costs the payment twice: Stripe
 * takes the refund out today, the bank takes the same amount out again when the
 * dispute resolves, and the dispute fee stays gone either way. Written to
 * somebody who has already *won* one it is worse than wrong — they have had the
 * money for a fortnight, and a desk offering to send it again reads as a desk
 * that does not know where its money is.
 *
 * So the analysis is not a summary of the dispute records. It is the short list
 * of things a reply must not do, derived from them.
 */

/** Where a dispute is in the bank's process, in words that imply an action. */
export type DisputeState =
  /** Evidence is owed, and a clock is running. */
  | 'needs_response'
  /** Submitted, or the bank is deciding. Nothing to do but wait. */
  | 'under_review'
  /** An early fraud warning: no money moved yet, and a refund can still pre-empt it. */
  | 'warning'
  /** The bank sided with us. They do not have the money. */
  | 'won'
  /** The bank sided with them. They have the money, and we paid a fee for it. */
  | 'lost'
  /** Refunded before it resolved, which closes it. */
  | 'refunded';

export function disputeState(dispute: StripeDispute): DisputeState {
  switch (dispute.status) {
    case 'needs_response':
      return 'needs_response';
    case 'won':
      return 'won';
    case 'lost':
      return 'lost';
    case 'charge_refunded':
      return 'refunded';
    // `warning_closed` is a warning that came to nothing, and it is grouped
    // with the live ones on purpose: a customer who triggered a fraud alert
    // last month is a customer to be careful with this month, and the card
    // saying nothing about it is how the second one is a surprise.
    case 'warning_needs_response':
    case 'warning_under_review':
    case 'warning_closed':
      return 'warning';
    default:
      // `under_review`, and anything Stripe adds later. Unknown statuses read
      // as open rather than as closed, which is the direction that fails safe:
      // the cost of over-cautioning a reply is a sentence that was not needed.
      return 'under_review';
  }
}

/** Is the money still in play? */
export function disputeOpen(dispute: StripeDispute): boolean {
  const state = disputeState(dispute);
  if (state === 'won' || state === 'lost' || state === 'refunded') return false;
  // A closed warning took no money and needs no evidence. It is history, and
  // history worth mentioning, but it is not something to hold a refund over.
  return !(state === 'warning' && dispute.status === 'warning_closed');
}

/**
 * Stripe's reason code, as a person would say it.
 *
 * Worth translating rather than passing through, because the codes read as
 * verdicts when they are only categories: `fraudulent` is what the cardholder's
 * bank filed, not something anybody here established, and a model handed the
 * bare word will write a reply that accuses somebody of fraud.
 */
const REASONS: Record<string, string> = {
  bank_cannot_process: 'their bank could not process the payment',
  check_returned: 'a returned check',
  credit_not_processed: 'they say a refund we promised never arrived',
  customer_initiated: 'the cardholder raised it themselves',
  debit_not_authorized: 'they say the debit was not authorised',
  duplicate: 'they say they were charged twice',
  fraudulent: 'their bank filed it as fraud — the cardholder says they did not authorise it',
  general: 'no reason given',
  incorrect_account_details: 'incorrect account details',
  insufficient_funds: 'insufficient funds',
  product_not_received: 'they say they never received what they paid for',
  product_unacceptable: 'they say what they received was not as described',
  subscription_canceled: 'they say they cancelled and were billed anyway',
  unrecognized: 'they did not recognise the charge on their statement',
  noncompliant: 'the payment did not meet card network rules',
};

export function reasonOf(dispute: StripeDispute): string {
  return REASONS[dispute.reason] ?? dispute.reason.replace(/_/g, ' ');
}

export interface DisputeAnalysis {
  /** Live ones. Their existence is what makes a refund unsafe. */
  open: StripeDispute[];
  /** Closed ones, in the order Stripe gave them: newest first. */
  settled: StripeDispute[];
  /**
   * Charges flagged `disputed` whose dispute we could not read.
   *
   * Counted rather than dropped. The flag needs no permission and the record
   * does, so on a narrow key this is the whole of what is known — and a desk
   * that is told "there may be a chargeback here, I cannot see it" behaves
   * correctly, where a desk told nothing does not.
   */
  unreadable: number;
  /**
   * May the reply offer money back?
   *
   * False while anything is open, and false too when Stripe has said the charge
   * is no longer refundable. Not a permission check — nothing here can refund
   * anything — it is a claim about what a sentence may promise.
   */
  refundSafe: boolean;
  /** The soonest evidence deadline still ahead, epoch seconds. */
  dueBy: number | null;
  /** One line for a card, or null when there is nothing worth the space. */
  headline: string | null;
  /** Sentences for the drafting prompt, already interpreted. */
  lines: string[];
}

const NOTHING: DisputeAnalysis = {
  open: [],
  settled: [],
  unreadable: 0,
  refundSafe: true,
  dueBy: null,
  headline: null,
  lines: [],
};

/**
 * The disputes on this customer, read as instructions.
 *
 * `charges` as well as `disputes` because the two disagree usefully: a charge
 * carries `disputed` without any dispute permission at all, so the difference
 * between the two lists is exactly the set of chargebacks a narrow key knows
 * about and cannot describe.
 *
 * `now` is a parameter so the deadline arithmetic can be tested without a fake
 * clock over the module.
 */
export function analyseDisputes(
  charges: StripeCharge[],
  disputes: StripeDispute[],
  refused: string | null = null,
  now: number = Date.now(),
): DisputeAnalysis {
  const flagged = charges.filter(charge => charge.disputed || charge.dispute);
  if (flagged.length === 0 && disputes.length === 0) return NOTHING;

  const open = disputes.filter(disputeOpen);
  const settled = disputes.filter(dispute => !disputeOpen(dispute));
  const unreadable = Math.max(0, flagged.length - disputes.length);

  const deadlines = open
    .map(dispute => dispute.evidence_details?.due_by ?? null)
    .filter((due): due is number => typeof due === 'number' && due * 1000 > now);
  const dueBy = deadlines.length > 0 ? Math.min(...deadlines) : null;

  // Unreadable counts against safety. We know the bank was asked to reverse
  // something and we do not know whether it still is; promising money on that
  // is the same bet as promising it on an open dispute, taken blind.
  const refundSafe =
    open.length === 0 &&
    unreadable === 0 &&
    !disputes.some(dispute => dispute.is_charge_refundable === false && disputeOpen(dispute));

  const lines: string[] = [];

  for (const dispute of open) {
    const state = disputeState(dispute);
    const what = `${money(dispute.amount, dispute.currency)} (${reasonOf(dispute)})`;

    if (state === 'warning') {
      lines.push(
        `Their bank has raised an early fraud warning on ${what}, filed ${day(dispute.created)}. No money has moved yet and it is not a chargeback, but it becomes one if it is left. Do not tell them they have been charged back.`,
      );
      continue;
    }

    const clock =
      state === 'needs_response' && dispute.evidence_details?.due_by
        ? ` Evidence is due by ${day(dispute.evidence_details.due_by)}; missing that date loses it by default.`
        : '';
    lines.push(
      `There is an OPEN chargeback on ${what}, filed ${day(dispute.created)} and currently ${dispute.status.replace(/_/g, ' ')}.${clock}`,
    );
  }

  if (open.length > 0) {
    // The whole point of the file, stated once and plainly. Said per dispute it
    // would be three variations of one rule, which is how a model comes to
    // treat it as advice.
    lines.push(
      'While a chargeback is open, do NOT offer, promise or imply a refund, and do not say the payment has been returned — refunding a disputed charge does not withdraw the dispute, so the money leaves twice and the dispute fee stays. If they want their money back this way, the reply is to ask them to withdraw the dispute with their bank, and to say we will then handle the refund directly.',
    );
  }

  const lost = settled.filter(dispute => disputeState(dispute) === 'lost');
  if (lost.length > 0) {
    const totals = lost.map(dispute => money(dispute.amount, dispute.currency)).join(', ');
    lines.push(
      `They have already won a chargeback for ${totals} — that money went back to them when the bank decided, so they are not owed it again. Do not offer to refund it.`,
    );
  }

  const won = settled.filter(dispute => disputeState(dispute) === 'won');
  if (won.length > 0) {
    // Deliberately not "we won". The reviewer needs to know the customer is
    // out of pocket and thinks they should not be, which is a live grievance
    // however the card network scored it.
    lines.push(
      `A previous chargeback of theirs was decided in our favour, so they paid and may believe they did not. Treat any "I was charged anyway" as sincere.`,
    );
  }

  if (unreadable > 0) {
    lines.push(
      `${unreadable} of their charges is flagged as disputed but the dispute record could not be read${refused ? ` (${refused})` : ''}. Assume a chargeback may be open and do not promise a refund until somebody has checked Stripe.`,
    );
  }

  return { open, settled, unreadable, refundSafe, dueBy, headline: headlineOf(open, settled, unreadable), lines };
}

/**
 * The one line a card has room for.
 *
 * Open before settled before unreadable, because that is the order in which
 * they change what the reviewer does next — and a card that leads with a
 * chargeback we won last year while one is open today has buried the thing it
 * was put on the screen to surface.
 */
function headlineOf(
  open: StripeDispute[],
  settled: StripeDispute[],
  unreadable: number,
): string | null {
  if (open.length > 0) {
    const first = open[0]!;
    const kind = disputeState(first) === 'warning' ? 'fraud warning' : 'chargeback open';
    const more = open.length > 1 ? ` (+${open.length - 1} more)` : '';
    return `${kind} · ${money(first.amount, first.currency)}${more}`;
  }
  if (unreadable > 0) return `${unreadable} disputed charge(s), unreadable`;
  if (settled.length > 0) {
    const lost = settled.filter(dispute => disputeState(dispute) === 'lost').length;
    return lost > 0 ? `${lost} chargeback(s) lost` : `${settled.length} past dispute(s)`;
  }
  return null;
}
