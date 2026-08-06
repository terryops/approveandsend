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
import {
  DEFAULT_HANDLERS,
  createWorker,
  enqueueBackfillScan,
  enqueueConsolidateRules,
  enqueueForDrafting,
  enqueueSummariseRules,
} from '@/lib/queue';
import { coerceCategory } from '@/lib/rules/types';
import { createRule, deleteRule, updateRule } from '@/lib/rules/store';
import { sendReply } from '@/lib/tasks/send';
import { getTask, updateTask } from '@/lib/tasks/store';

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
  updateTask(id, { draft: field(form, 'draft'), reviewerNotes: field(form, 'notes') || null });
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
    await sendReply(id, {
      finalReply: field(form, 'draft'),
      ...(notes ? { reviewerNotes: notes } : {}),
      sentBy: (await currentOperator())?.id ?? null,
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
  updateTask(id, { status: 'dismissed', reviewerNotes: field(form, 'notes') || null });
  revalidatePath('/');
  redirect('/');
}

export async function redraftTask(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const task = getTask(id);
  if (task) {
    // Back to pending first, or the job's own guard would see a task that is
    // already awaiting review and the queue would dedupe the request away.
    updateTask(id, { status: 'pending', error: null });
    // Through the enrichment path, not straight to drafting. Someone clicking
    // Redraft is often doing it because the reply was wrong about who this
    // person is, which is the case a stale — or failed — lookup produces.
    await enqueueForDrafting(id);
  }
  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}?queued=1`);
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
