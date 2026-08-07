'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { currentOperator, requireApi } from '@/lib/auth/guard';
import { cancelPendingBackfill, clearBackfill } from '@/lib/backfill/store';
import { seedDemoData } from '@/lib/demo/seed';
import { setSessionCookie } from '@/lib/auth/cookie';
import { COOKIE_NAME, adminPassword, checkPassword, isProtected } from '@/lib/auth/session';
import {
  authenticate,
  countActiveOperators,
  createOperator,
  setOperatorEnabled,
  setOperatorPassword,
  touchOperator,
} from '@/lib/operators/store';
import { t } from '@/lib/i18n';
import { syncInbox } from '@/lib/ingest/sync';
import { readUploads } from '@/lib/mail/uploads';
import {
  DEFAULT_HANDLERS,
  createWorker,
  enqueueAlternatives,
  enqueueBackfillScan,
  enqueueCompose,
  enqueueConsolidateRules,
  enqueueForDrafting,
  enqueueForTranslation,
  enqueueSummariseRules,
  deleteJob,
  releaseJob,
  retryJob,
} from '@/lib/queue';
import { coerceCategory } from '@/lib/rules/types';
import { createRule, deleteRule, updateRule } from '@/lib/rules/store';
import { installStarterRules } from '@/lib/rules/starter';
import { deleteUnlessSent, rejectTask, reopenTask as reopen } from '@/lib/tasks/lifecycle';
import { getAlternative } from '@/lib/tasks/alternatives';
import { recordEvent } from '@/lib/tasks/events';
import { getVersion, recordDraft } from '@/lib/tasks/versions';
import { markHandled } from '@/lib/tasks/mark-read';
import { sendReply } from '@/lib/tasks/send';
import { createTask, getTask, updateTask } from '@/lib/tasks/store';
import { sweepStuckTasks } from '@/lib/tasks/sweep';

/**
 * Every mutation the UI can perform.
 *
 * These are plain form actions, so the review screen works with JavaScript
 * disabled and — more usefully — a half-written draft survives a page reload
 * because it was posted rather than held in component state.
 */

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whose name goes in the revision history.
 *
 * The shared password is a real answer, not a missing one: somebody with the
 * password made this change and the history should say so rather than name a
 * person who may not have been there.
 */
async function actorName(): Promise<string> {
  return (await currentOperator())?.name ?? t('actions.actorSharedPassword');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function login(form: FormData): Promise<void> {
  const password = field(form, 'password');
  const name = field(form, 'name');

  // One error message for every way this can fail, including a name that does
  // not exist. Telling someone which half they got wrong is telling them which
  // names are real.
  if (name) {
    const operator = authenticate(name, password);
    if (!operator) redirect('/login?error=1');
    touchOperator(operator.id);
    await setSessionCookie(operator.id);
    redirect('/');
  }

  // No name given, so this is the shared password — which is not an option on
  // an install whose only door is its operators. Without this line, adding
  // operators to a passwordless install would leave a blank-name login walking
  // straight past all of them.
  if (adminPassword() === null && isProtected()) redirect('/login?error=1');
  if (!checkPassword(password)) redirect('/login?error=1');

  await setSessionCookie();
  redirect('/');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
  redirect('/login');
}

/** Saving without sending. The reviewer's edits are the training signal, so
 * losing them to a closed tab loses more than the typing. */
export async function saveDraft(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const draft = field(form, 'draft');
  const before = getTask(id);

  updateTask(id, { draft, reviewerNotes: field(form, 'notes') || null });

  // An edited draft's translation is now of text nobody is going to send.
  // `getTranslation` already refuses to show it — which leaves a reviewer who
  // does not read the reply's language staring at an empty panel with no way
  // to fill it, because until now nothing queued the re-translation.
  //
  // Skipped when only the notes changed: the same words do not need rendering
  // twice, and saving is what people do while thinking.
  if (draft.trim() !== (before?.draft ?? '').trim()) {
    enqueueForTranslation(id);
    // Only a real change to the text. Saving is what people do while
    // thinking, and a history of six identical "edited" lines says less than
    // one does.
    recordEvent(id, 'edited', { actor: (await currentOperator())?.id ?? null });
    recordDraft(id, draft, { source: 'human' });
  }

  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}?saved=1`);
}

export async function approveAndSend(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const notes = field(form, 'notes');

  let failure: string | null = null;
  try {
    // The edited text is saved before the send is attempted: if the provider
    // is down, the reviewer's work is still on disk when they come back.
    updateTask(id, { draft: field(form, 'draft'), reviewerNotes: notes || null });
    // Read before the send, so an oversized attachment fails the request
    // rather than the mail — and fails it after the draft is already saved.
    const attachments = await readUploads(form);
    await sendReply(id, {
      finalReply: field(form, 'draft'),
      ...(notes ? { reviewerNotes: notes } : {}),
      sentBy: (await currentOperator())?.id ?? null,
      ...(attachments.length ? { attachments } : {}),
    });
  } catch (error) {
    failure = message(error);
  }

  revalidatePath('/');
  revalidatePath(`/tasks/${id}`);
  if (failure) redirect(`/tasks/${id}?error=${encodeURIComponent(failure)}`);
  redirect('/?sent=1');
}

export async function dismissTask(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const dismissed = rejectTask(id, {
    reason: field(form, 'reason'),
    notes: field(form, 'notes'),
    actor: (await currentOperator())?.id ?? null,
  });
  // Dismissed is a decision, not an oversight: somebody looked at this and said
  // it needs no reply. Leaving it bold in the mailbox would put it back in
  // front of the next person to open Zoho as if nobody had.
  if (dismissed) await markHandled(dismissed);
  revalidatePath('/');
  redirect('/');
}

/**
 * Undoing a dismissal.
 *
 * The bulk filter and the dismiss button are both allowed to be wrong, and
 * without this the only remedy is asking the customer to write again. A task
 * that already has a draft goes straight back to review — the text is still
 * there and still applies. One that never got that far goes back to pending
 * and is queued, because "reopened" with nothing in it is just a row.
 *
 * Sent tasks are not reopenable, here or anywhere. What went out went out, and
 * a status that could travel backwards from `sent` would make "how many did we
 * answer this week" a question with no answer.
 */
export async function reopenTask(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  await reopen(id, { actor: (await currentOperator())?.id ?? null });

  revalidatePath('/');
  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}`);
}

export async function redraftTask(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const task = getTask(id);
  if (task) {
    // Back to pending first, or the job's own guard would see a task that is
    // already awaiting review and the queue would dedupe the request away.
    //
    // The note goes with it. "Redraft" on its own asks the same model the same
    // question and is entitled to the same answer; the box under the draft is
    // where the reviewer already says what is wrong with it, and the drafter
    // reads it from here.
    updateTask(id, {
      status: 'pending',
      error: null,
      reviewerNotes: field(form, 'notes') || null,
    });
    recordEvent(id, 'redraft', {
      detail: field(form, 'notes'),
      actor: (await currentOperator())?.id ?? null,
    });
    // Through the enrichment path, not straight to drafting. Someone clicking
    // Redraft is often doing it because the reply was wrong about who this
    // person is, which is the case a stale — or failed — lookup produces.
    await enqueueForDrafting(id);
  }
  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}?queued=1`);
}

/**
 * Putting an older draft back in the box.
 *
 * The text that is being replaced is kept first, so this is itself undoable —
 * a restore that discards the current draft would be the same trap as the
 * redraft button it exists to make safe.
 *
 * A sent task is not restorable: its draft column is the record of what was
 * proposed against what actually went out, and the learning loop reads the
 * pair.
 */
export async function restoreDraft(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const version = getVersion(field(form, 'versionId'));
  const task = getTask(id);

  if (version && version.taskId === id && task && task.status !== 'sent') {
    if (task.draft) recordDraft(id, task.draft, { source: 'human' });
    updateTask(id, { draft: version.body });
    recordEvent(id, 'edited', {
      detail: 'restored',
      actor: (await currentOperator())?.id ?? null,
    });
    // The reviewer is about to read a reply in a language they may not have,
    // and the translation on file is of the text this just replaced.
    enqueueForTranslation(id);
  }

  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}?saved=1`);
}

/**
 * Writing a mail nobody asked for.
 *
 * Produces an ordinary task and sends the operator to the review screen for
 * it. There is no path from here to the mailbox that does not go through a
 * human reading the result, which is the point of the whole product and is
 * most load-bearing exactly here: an unsolicited mail has no customer question
 * bounding what it can say.
 */
export async function composeEmail(form: FormData): Promise<void> {
  await requireApi();
  const to = field(form, 'to');
  const brief = field(form, 'brief');
  if (!to || !brief) redirect('/compose');

  const { task } = createTask({
    origin: 'composed',
    // Where a customer's words would be. The drafter is told which it is
    // reading; nothing else downstream needs to care.
    body: brief,
    fromAddress: to,
    subject: field(form, 'subject'),
    // Ahead of the inbox: somebody is watching this one.
    priority: 3,
  });

  enqueueCompose(task.id);
  redirect(`/tasks/${task.id}?queued=1`);
}

/**
 * Asking what else this reply could have said.
 *
 * A separate button from Redraft because they answer different questions.
 * Redraft says this draft is wrong and here is why; this says the reviewer
 * does not yet know what right looks like, and would like to see the choice
 * laid out before committing the desk to one of them.
 *
 * Deliberately not automatic. Most mail is answered by the first draft, and
 * three replies to every routine question is three times the bill for the one
 * task in ten that is actually a judgement call.
 */
export async function askForOptions(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const task = getTask(id);

  if (task && task.status !== 'sent' && task.status !== 'dismissed') {
    enqueueAlternatives(id);
  }

  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}?queued=1`);
}

/**
 * Putting one of the options in the draft box.
 *
 * The same shape as a restore, and for the same reason: what is in the box now
 * is kept first, so picking B and then wanting A back does not cost anybody
 * their editing. The set is left on the page — a reviewer who picks one and
 * then changes their mind should not have to pay for the other two again.
 */
export async function useAlternative(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const option = getAlternative(field(form, 'alternativeId'));
  const task = getTask(id);

  if (option && option.taskId === id && task && task.status !== 'sent') {
    if (task.draft) recordDraft(id, task.draft, { source: 'human' });
    recordDraft(id, option.body, { source: 'model', notes: option.strategy || null });
    updateTask(id, { draft: option.body });
    recordEvent(id, 'edited', {
      detail: `option ${option.label}`,
      actor: (await currentOperator())?.id ?? null,
    });
    enqueueForTranslation(id);
  }

  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}?saved=1`);
}

/**
 * Doing one thing to a screenful of tasks.
 *
 * The first sync of an established mailbox produces a hundred tasks nobody
 * will ever answer, and clearing them one page at a time is how a tool gets
 * abandoned in week one. The selection is a set of checkboxes in a plain form,
 * so this works with no client-side JavaScript at all and the request carries
 * exactly what was on screen.
 *
 * Every branch is deliberately a thing that can be undone. There is no bulk
 * send: approving a hundred replies you have not read is not a feature, it is
 * the failure this whole product exists to prevent.
 */
function selected(form: FormData): string[] {
  return form
    .getAll('taskId')
    .filter((v): v is string => typeof v === 'string' && v !== '');
}

export async function bulkDismiss(form: FormData): Promise<void> {
  await requireApi();
  const ids = selected(form);
  const actor = (await currentOperator())?.id ?? null;
  for (const id of ids) {
    const task = rejectTask(id, { actor });
    // Same reasoning as the single dismiss: a decision made here should not
    // leave the mail bold for whoever opens the mailbox next.
    if (task) await markHandled(task);
  }
  revalidatePath('/');
  redirect(`/?bulk=${ids.length}`);
}

export async function bulkReopen(form: FormData): Promise<void> {
  await requireApi();
  const ids = selected(form);
  const actor = (await currentOperator())?.id ?? null;
  let reopened = 0;
  for (const id of ids) {
    if (await reopen(id, { actor })) reopened += 1;
  }
  revalidatePath('/');
  redirect(`/?bulk=${reopened}`);
}

export async function bulkDelete(form: FormData): Promise<void> {
  await requireApi();
  const ids = selected(form);
  let deleted = 0;
  for (const id of ids) {
    // Sent tasks are the record of what a customer was told. Dropping that on
    // the floor because a checkbox was ticked is not a thing this offers.
    if (deleteUnlessSent(id)) deleted += 1;
  }
  revalidatePath('/');
  // Worth saying plainly: the row is gone, but so is the note that this
  // message was ever seen, and the next sync will ingest it again.
  redirect(`/?deleted=${deleted}`);
}

export async function addRule(form: FormData): Promise<void> {
  await requireApi();
  const content = field(form, 'content');
  if (content) {
    createRule({
      content,
      category: coerceCategory(field(form, 'category')),
      topics: form.getAll('topics').map(String),
      rationale: t('actions.handWrittenRuleRationale'),
    });
    enqueueSummariseRules();
  }
  revalidatePath('/rules');
  redirect('/rules');
}

/**
 * Installs the starter rulebook.
 *
 * Only ever reached by somebody pressing the button. Nothing seeds these on
 * first run: a desk that discovered rules it had never agreed to would have
 * good reason to stop trusting the rest of the rulebook, which is the one
 * thing this whole system is asking it to trust.
 */
export async function addStarterRules(form: FormData): Promise<void> {
  await requireApi();
  const result = installStarterRules();
  revalidatePath('/rules');
  // The wizard sends people back to the wizard: pressing this mid-setup should
  // not abandon the three steps they have not done yet.
  redirect(field(form, 'next') === 'setup' ? '/setup/done' : `/rules?starter=${result.added}`);
}

export async function editRule(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'ruleId');
  const enabled = form.get('enabled');
  updateRule(
    id,
    {
      content: field(form, 'content'),
      category: coerceCategory(field(form, 'category')),
      topics: form.getAll('topics').map(String),
      ...(enabled === null ? {} : { enabled: enabled === 'on' || enabled === 'true' }),
    },
    { reason: 'manual', actor: await actorName() },
  );
  // A rewritten rule had its summary cleared on the way in, so it needs a new
  // one. Toggling or deleting a rule does not — neither changes what it says.
  enqueueSummariseRules();
  revalidatePath('/rules');
  redirect('/rules');
}

export async function toggleRule(form: FormData): Promise<void> {
  await requireApi();
  updateRule(
    field(form, 'ruleId'),
    { enabled: field(form, 'enabled') === 'true' },
    { reason: 'manual', actor: await actorName() },
  );
  revalidatePath('/rules');
  redirect('/rules');
}

export async function removeRule(form: FormData): Promise<void> {
  await requireApi();
  deleteRule(field(form, 'ruleId'));
  revalidatePath('/rules');
  redirect('/rules');
}

/**
 * Adding someone to the desk.
 *
 * The failure cases are named in the URL rather than thrown, because the two
 * that happen — a name already taken, a blank field — are things the person
 * typing can fix in the form they are looking at.
 */
export async function addOperator(form: FormData): Promise<void> {
  await requireApi();
  const name = field(form, 'name');
  const password = field(form, 'password');

  if (!name || !password) redirect('/operators?error=blank');
  try {
    createOperator(name, password);
  } catch {
    // The unique index is the only thing that can reasonably fail here, and it
    // fails for exactly one reason worth reporting.
    redirect('/operators?error=taken');
  }
  revalidatePath('/operators');
  redirect('/operators?added=1');
}

export async function changeOperatorPassword(form: FormData): Promise<void> {
  await requireApi();
  const password = field(form, 'password');
  if (!password) redirect('/operators?error=blank');
  setOperatorPassword(field(form, 'operatorId'), password);
  revalidatePath('/operators');
  redirect('/operators?changed=1');
}

export async function setOperatorAccess(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'operatorId');
  const enabled = field(form, 'enabled') === 'true';

  // Disabling the last active operator on an install with no shared password
  // does not lock the door — it removes it, and the next visitor walks in
  // unauthenticated. Refusing here is the difference between a mistake and an
  // exposed inbox.
  if (!enabled && adminPassword() === null && countActiveOperators() <= 1) {
    redirect('/operators?error=last');
  }

  setOperatorEnabled(id, enabled);
  revalidatePath('/operators');
  redirect('/operators');
}

export async function syncNow(): Promise<void> {
  await requireApi();
  let query = '';
  try {
    const result = await syncInbox();
    query = `?synced=${result.created}`;
  } catch (error) {
    query = `?error=${encodeURIComponent(message(error))}`;
  }
  revalidatePath('/');
  redirect(`/${query}`);
}

/**
 * Draining the queue from a button.
 *
 * A self-hosted install with no cron still has to get its drafts written
 * somehow, and "click this when you want work to happen" is an honest answer
 * for v0.1 — see `/api/worker` for the scheduled one.
 */
export async function runQueue(): Promise<void> {
  await requireApi();
  const worker = createWorker({ handlers: DEFAULT_HANDLERS });
  let query = '';
  try {
    const processed = await worker.drain(25);
    query = `?ran=${processed.length}`;
  } catch (error) {
    query = `?error=${encodeURIComponent(message(error))}`;
  }
  revalidatePath('/queue');
  revalidatePath('/');
  redirect(`/queue${query}`);
}

/**
 * The three things a person needs to do to a single job.
 *
 * Without these, a queue page is a window onto a problem with no handle on it:
 * the only way to clear one bad job has been a SQLite client and a guess at
 * the schema, on a machine somebody has to SSH into. Each one redirects back
 * with a note rather than throwing, because the row being acted on may well
 * have finished on its own between the render and the click, and that is not
 * an error worth a stack trace.
 */
export async function retryJobNow(form: FormData): Promise<void> {
  await requireApi();
  const job = retryJob(field(form, 'jobId'));
  revalidatePath('/queue');
  redirect(job ? '/queue?retried=1' : `/queue?error=${encodeURIComponent(t('queue.notFailed'))}`);
}

export async function releaseJobNow(form: FormData): Promise<void> {
  await requireApi();
  const job = releaseJob(field(form, 'jobId'));
  revalidatePath('/queue');
  redirect(job ? '/queue?released=1' : `/queue?error=${encodeURIComponent(t('queue.notStuck'))}`);
}

export async function deleteJobNow(form: FormData): Promise<void> {
  await requireApi();
  // No confirmation step. A job is a note to do something, not the something:
  // the task it refers to is untouched, the sweep will find it if it is left
  // owing work, and re-enqueueing is one button away on the task itself.
  deleteJob(field(form, 'jobId'));
  revalidatePath('/queue');
  redirect('/queue?deleted=1');
}

/**
 * Rescuing tasks nothing is going to finish, from a button.
 *
 * On the queue page rather than the inbox because what it repairs is a queue
 * fault — and because the tasks it finds are, by definition, the ones not
 * showing up on the inbox.
 */
export async function sweepNow(): Promise<void> {
  await requireApi();
  let query = '';
  try {
    const result = await sweepStuckTasks();
    query = `?swept=${result.requeued + result.failed}`;
  } catch (error) {
    query = `?error=${encodeURIComponent(message(error))}`;
  }
  revalidatePath('/queue');
  revalidatePath('/');
  redirect(`/queue${query}`);
}

/**
 * Queueing the rulebook tidy from the rules page.
 *
 * Enqueued rather than run inline: a pass over a few hundred rules is a dozen
 * LLM calls and minutes of wall time, which is not a thing to do inside a form
 * post. `force` because a human who clicked the button has overruled the gate.
 */
export async function tidyRulebook(): Promise<void> {
  await requireApi();
  const result = enqueueConsolidateRules({ force: true });
  revalidatePath('/rules');
  revalidatePath('/queue');
  redirect(`/rules?tidy=${result.deduped ? 'already' : 'queued'}`);
}

/**
 * Learning from the mailbox's history.
 *
 * Queued, never run inline. The scan itself is one provider call, but what it
 * produces is hundreds of generations, and a button that blocked until those
 * finished would be a button that always fails.
 */
export async function startBackfill(form: FormData): Promise<void> {
  await requireApi();

  const limit = Number.parseInt(field(form, 'limit'), 10);
  const months = Number.parseInt(field(form, 'months'), 10);

  // A window, because "learn from everything" against a mailbox with ten years
  // in it is a bill nobody meant to authorise. Both bounds are shown in the
  // form and both are editable; neither is hidden in an env var.
  const since = Number.isFinite(months) && months > 0
    ? new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  enqueueBackfillScan({
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(since ? { since } : {}),
  });

  revalidatePath('/backfill');
  revalidatePath('/queue');
  redirect('/backfill?started=1');
}

/** Stopping a run. Items already generating are left to finish. */
export async function stopBackfill(): Promise<void> {
  await requireApi();
  const cancelled = cancelPendingBackfill();
  revalidatePath('/backfill');
  redirect(`/backfill?stopped=${cancelled}`);
}

/**
 * Clearing the record of a run.
 *
 * Only the record. Rules the backfill taught stay exactly where they are —
 * they are in the rulebook now, with their provenance, and the rules screen is
 * where you retire the ones you disagree with.
 */
export async function clearBackfillHistory(): Promise<void> {
  await requireApi();
  clearBackfill();
  revalidatePath('/backfill');
  redirect('/backfill?cleared=1');
}

/**
 * Filling an empty install with the sample inbox.
 *
 * Offered only on the empty state, and `seedDemoData` refuses to write over
 * anything, so the worst outcome of a stray click is nothing at all.
 */
export async function loadDemo(): Promise<void> {
  await requireApi();
  const result = seedDemoData();
  revalidatePath('/');
  revalidatePath('/rules');
  redirect(result.skipped ? '/' : `/?demo=${result.tasks}`);
}
