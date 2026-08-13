import { day, money, type StripeCharge, type StripeDispute } from './stripe';

/**
 * What each reason code means for the letter that has to be written.
 *
 * The prohibition is the same whatever the bank filed; the reply is not. A
 * cardholder who does not recognise a line on their statement needs the
 * statement descriptor and the date. Somebody who says the product was not
 * what they were promised needs their complaint answered before they will
 * consider doing us a favour. Sending the second person the first letter is
 * how a withdrawable dispute becomes one that is fought to the end.
 */
const PLAYS: Record<string, string> = {
  fraudulent:
    'They told their bank they did not authorise this. Usually that means they did not recognise it rather than that anything was stolen, so lead with what the charge looks like on a statement and when it was taken, and ask — without any suggestion of blame — whether someone else with access to the card may have signed up. Do not use the word fraud back at them.',
  unrecognized:
    'They did not recognise the charge. The statement descriptor and the date are the whole of the answer; give them first and explain second.',
  duplicate:
    'They believe they were charged twice. Check the payment list before saying anything: if there really are two charges, say so plainly and treat the withdrawal as the formality it then is. If there is only one, show them the one.',
  subscription_canceled:
    'They believe they cancelled and were billed anyway. Say what the subscription record actually shows, with dates, and do not flatly contradict them — a cancellation that did not save is our failure, not their memory.',
  product_not_received:
    'Their complaint is that they never got what they paid for. Answer that first and properly. Nobody withdraws a dispute for a desk that has not yet acknowledged the thing they disputed over.',
  product_unacceptable:
    'Their complaint is about the product itself. Answer it before asking for anything: the withdrawal request only lands once they feel heard.',
  credit_not_processed:
    'They say a refund we promised never arrived. Check the payment list for what was actually sent before making any claim about it.',
  customer_initiated:
    'The cardholder raised this themselves rather than the bank flagging it, so there is a person on the other end with a specific grievance. Find it in the thread and answer it.',
};

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

export interface AnalysisOptions {
  /** Stripe's words when it would not hand the dispute records over. */
  refused?: string | null;
  /** A parameter so the deadline arithmetic tests without a fake clock. */
  now?: number;
  /**
   * Whether this desk will refund once the customer withdraws.
   *
   * The default, because it is the only move that ends well for both sides and
   * it is what most desks would do if they had thought about it: the money is
   * going back either way, and going back by agreement keeps the fee, the
   * win-rate and the customer. A desk that would rather defend the charge sets
   * this false and gets the same letter without the promise — never a letter
   * that promises and then does not pay, which is worse than either.
   */
  offerRefundOnWithdrawal?: boolean;
}

/**
 * The disputes on this customer, read as instructions.
 *
 * `charges` as well as `disputes` because the two disagree usefully: a charge
 * carries `disputed` without any dispute permission at all, so the difference
 * between the two lists is exactly the set of chargebacks a narrow key knows
 * about and cannot describe. The charge is also where the statement descriptor
 * lives, which is the single most useful line in a reply about a payment
 * somebody did not recognise.
 */
export function analyseDisputes(
  charges: StripeCharge[],
  disputes: StripeDispute[],
  { refused = null, now = Date.now(), offerRefundOnWithdrawal = true }: AnalysisOptions = {},
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
  const byId = new Map(charges.map(charge => [charge.id, charge]));

  for (const dispute of open) {
    const state = disputeState(dispute);
    const what = `${money(dispute.amount, dispute.currency)} (${reasonOf(dispute)})`;
    const paid = byId.get(dispute.charge);
    // The date they will recognise is the date they paid, not the date their
    // bank got round to filing. Fall back only because a narrow charge list
    // may not reach back far enough to hold it.
    const when = paid ? day(paid.created) : day(dispute.created);

    if (state === 'warning') {
      lines.push(
        `Their bank has raised an early fraud warning on ${what}, taken ${when}. No money has moved yet and it is not a chargeback, but it becomes one if it is left. Do not tell them they have been charged back.`,
      );
      continue;
    }

    const clock =
      state === 'needs_response' && dispute.evidence_details?.due_by
        ? ` Evidence is due by ${day(dispute.evidence_details.due_by)}; missing that date loses it by default.`
        : '';
    lines.push(
      `There is an OPEN chargeback on ${what}, for a payment taken ${when}, filed ${day(dispute.created)} and currently ${dispute.status.replace(/_/g, ' ')}.${clock}`,
    );

    // The line the customer is actually looking at. Almost never the product's
    // name, and neither side thinks to compare the two.
    if (paid?.calculated_statement_descriptor) {
      lines.push(
        `On their statement that payment reads "${paid.calculated_statement_descriptor}" — quote it back to them exactly, because that string is what they failed to recognise.`,
      );
    }

    const play = PLAYS[dispute.reason];
    if (play) lines.push(play);
  }

  // Warnings are excluded on purpose. Nothing has been charged back yet, so
  // there is nothing for the cardholder to withdraw, and a letter asking them
  // to phone their bank about a dispute they have not made is how a warning
  // turns into one.
  const chargebacks = open.filter(dispute => disputeState(dispute) !== 'warning');

  if (chargebacks.length > 0) {
    // The whole point of the file, stated once and plainly. Said per dispute it
    // would be three variations of one rule, which is how a model comes to
    // treat it as advice.
    lines.push(
      'While a chargeback is open, do NOT offer to refund it now, do not say the payment has been returned, and do not say we have refused a refund. Refunding a disputed charge does not withdraw the dispute: the money would leave twice and the dispute fee stays gone either way. Stripe will usually not even allow it.',
    );

    // What to write, not merely what not to. A prohibition on its own produces
    // a careful reply that leaves the dispute exactly where it was — and the
    // desk still loses the money, the fee and the customer, having said nothing
    // wrong. The only thing that stops a chargeback is the cardholder telling
    // their own bank to drop it, so the reply's job is to get that done.
    lines.push(
      'The aim of this reply is to get the cardholder to withdraw the dispute themselves, since only they can. Write it to do that: open by identifying the payment concretely — the amount, the date it was taken and what it was for — then explain once, without blame or defensiveness, that their bank has taken control of the money so we cannot return it from our side while the case is open. Then ask for the specific action: contact their card issuer, on the number on the back of the card or in their banking app, and ask to withdraw the dispute for that amount and date.',
    );

    if (offerRefundOnWithdrawal) {
      // The half that makes it worth doing for them. Without a stated
      // consequence this is a letter asking somebody to give up their only
      // leverage as a favour.
      lines.push(
        'Say plainly what they get for it: as soon as the bank confirms the dispute is withdrawn we will refund the payment in full, directly, and they do not need to chase it. Ask them to reply here once they have spoken to their bank so we can watch for the release. Do not attach conditions to that promise and do not hedge it — a hedged offer is not worth the phone call it is asking for.',
      );
    } else {
      lines.push(
        'Do not offer a refund in exchange for the withdrawal; this desk defends these. Ask for the withdrawal on the merits of the account and the payment, and leave any refund decision to a human.',
      );
    }

    if (dueBy) {
      lines.push(
        `Give them the reason to do it now: the bank's deadline is ${day(dueBy)}. Frame that as why we are writing today, never as a threat and never as a deadline imposed by us.`,
      );
    }

    // The evidence is already on the screen, in somebody else's block. A model
    // that has "Minutes: 412 · Active days: 19" three lines up will not think
    // to use it unless told, and a letter about a disputed payment is exactly
    // where a specific beats a paragraph of goodwill.
    lines.push(
      'If any other context here says what this account has actually done — usage, activity, dates, what they created — use the specifics in the letter where they help them recognise the purchase or see that we know who they are. Use them to jog a memory, never to argue that they owe us.',
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
