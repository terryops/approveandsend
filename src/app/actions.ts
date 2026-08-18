'use server';

import { isReplyFormat, type ReplyFormat } from '@/lib/mail/render';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';

import { currentOperator, requireAdminApi, requireApi } from '@/lib/auth/guard';
import { DEFAULT_SCAN_LIMIT } from '@/lib/backfill/scan';
import { cancelPendingBackfill, clearBackfill } from '@/lib/backfill/store';
import {
  createCatalogItem,
  deleteCatalogItem,
  getCatalogItem,
  updateCatalogItem,
} from '@/lib/catalog/store';
import { syncCatalogFromStripe } from '@/lib/catalog/sync';
import { normaliseTopicSlug, topicLabel } from '@/lib/config/workspace';
import { taskIdsWithContext } from '@/lib/context/store';
import { seedDemoData } from '@/lib/demo/seed';
import type { RedraftMode } from '@/lib/drafting/draft';
import { setThemeCookie, type Theme } from '@/lib/desk/theme';
import { setSessionCookie } from '@/lib/auth/cookie';
import { COOKIE_NAME, adminPassword, checkPassword, isProtected } from '@/lib/auth/session';
import {
  authenticate,
  countActiveAdmins,
  countActiveOperators,
  createOperator,
  getOperator,
  setOperatorAdmin,
  setOperatorEnabled,
  setOperatorPassword,
  touchOperator,
} from '@/lib/operators/store';
import { t, type Locale } from '@/lib/i18n';
import { stepHref } from '@/lib/setup/state';
import { newlines } from '@/lib/text';
import { saveWorkspaceConfig } from '@/lib/setup/workspace-file';
import { syncInbox } from '@/lib/ingest/sync';
import { readUploads } from '@/lib/mail/uploads';
import {
  DEFAULT_HANDLERS,
  cardsAwaitingRendering,
  createWorker,
  enqueueBackfillScan,
  enqueueContextThenCompose,
  enqueueContextThenWrite,
  enqueueConsolidateRules,
  enqueueForTranslation,
  enqueueSummariseRules,
  deleteJob,
  hasLiveDuplicate,
  nudgeQueue,
  releaseJob,
  retryJob,
} from '@/lib/queue';
import { coerceCategory } from '@/lib/rules/types';
import { approveRule, createRule, deleteRule, getRule, updateRule } from '@/lib/rules/store';
import { installStarterRules } from '@/lib/rules/starter';
import { deleteUnlessSent, rejectTask, reopenTask as reopen } from '@/lib/tasks/lifecycle';
import { getAlternative } from '@/lib/tasks/alternatives';
import { recordEvent } from '@/lib/tasks/events';
import { attachToTask, detachFromTask, pendingAttachments } from '@/lib/tasks/outgoing';
import { getVersion, recordDraft } from '@/lib/tasks/versions';
import { setReviewLayoutCookie, type ReviewLayout } from '@/lib/tasks/layout';
import { markHandled } from '@/lib/tasks/mark-read';
import { sendReply } from '@/lib/tasks/send';
import { createTask, getTask, markOpened, updateTask } from '@/lib/tasks/store';
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
  // `newlines` because a textarea submits CRLF whatever it holds, and the model
  // writes LF — two spellings of one reply that nothing downstream can tell
  // apart from a real edit. The door is the only place to settle it; see
  // `lib/text.ts` for what it cost when it was not settled anywhere.
  return typeof value === 'string' ? newlines(value).trim() : '';
}

/**
 * The same read, but able to tell "cleared" from "not asked about".
 *
 * `field` answers `''` to both, and for most fields that is fine because every
 * form that can change them contains them. It is not fine for the ones that
 * moved into a panel: the review screen's forms no longer carry `notes`, so
 * `field(form, 'notes') || null` wrote null on every Save and every Approve —
 * silently erasing the sentence the reviewer had written about their own edit,
 * which is also the sentence the rule extractor learns from.
 *
 * `undefined` means the form never mentioned it, and `updateTask` skips a key
 * it is not given. An empty string still means cleared, because a box somebody
 * emptied on purpose is an answer.
 *
 * `newlines` for the same reason `field` has it, and it was missing here: every
 * box this reads is a textarea, a textarea submits CRLF whatever it holds, and
 * the model writes LF. `keepEdits` is the one caller that then *compares* what
 * it read against the row — so pressing the format tabs on a freshly drafted
 * reply changed nothing a reader could see and yet wrote the draft, logged an
 * "edited" nobody did, and queued a re-translation of the same words. Worse on
 * the strip above it: `draft.trim() === option.body.trim()` is what lights the
 * option tab a reply came from, so the tab went dark and the screen said the
 * reviewer had edited — one press after they had not.
 */
function optional(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? newlines(value).trim() : undefined;
}

/**
 * A place on this desk, and the inbox if it is anything else.
 *
 * `returnTo` is a form field, so it is whatever the person who posted the form
 * put there, and `redirect()` follows an absolute URL as willingly as a path.
 * Without this, two actions that require a session are an open redirect: post
 * `returnTo=https://evil.example/` and the desk sends its own logged-in reviewer
 * off the site. Next's own origin check guards the action call, not where the
 * action decides to send the browser afterwards.
 *
 * A path, and only a path. `//host` and `/\host` are both protocol-relative — a
 * backslash is a slash to a URL parser — and a control character inside the
 * string is a way to smuggle one past a naive `startsWith`.
 */
function sameOrigin(raw: string): string {
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  return raw;
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

/**
 * The format the reviewer had selected when they pressed the button.
 *
 * Read off the same form as the draft, for the reason the subject and the draft
 * travel together: the format decides what the text in the box *means*, so a
 * reply saved with one format and sent under another is a different reply. An
 * absent or unrecognised field leaves the row alone rather than resetting it to
 * markdown — a client that did not send the field is not a reviewer asking for
 * a change.
 */
function formatFrom(form: FormData): { replyFormat: ReplyFormat } | Record<string, never> {
  const value = form.get('format');
  return isReplyFormat(value) ? { replyFormat: value } : {};
}

/**
 * Back to the reply, rather than back to the top of the page.
 *
 * A redirect is a navigation, so a tab press that ends in one lands the browser
 * at the top of the document — on a task with a thread and three context cards,
 * that scrolls the tabs you just pressed off the screen. A fragment fixes it in
 * both of the directions this still takes: Next's router scrolls to the hash on
 * the URL it navigates to, and a browser with no JavaScript does the same with
 * the `Location` it is handed. `id="reply"` on the task page is what it points
 * at.
 *
 * Not on every action here. A refusal, an error or a dismissal is a sentence
 * about the whole task, and the top of the page is where that is read.
 */
function replyHref(id: string, query = ''): string {
  return `/tasks/${id}${query}#reply`;
}

/**
 * A banner on screen that this press has just made untrue.
 *
 * The two switches below answer the router without navigating, which is the
 * point of them — but the URL is where this screen keeps its one-shot messages,
 * and a URL that never moves is a message that never clears. An attachment
 * rejected as too large redirects to `?error=…`; press a format tab afterwards
 * and the tab works, the page re-renders, and the reviewer is still being told
 * their file was refused, with nothing on the page able to take it back.
 *
 * So the form says whether it is carrying one, and a press that is carrying one
 * navigates after all — once, to a clean URL, at the cost of the round trip
 * this otherwise saves. `saved` and `queued` are not in the list on the page:
 * pressing a tab does save, so those stay true and buy nothing by moving.
 */
function clearsNotice(form: FormData): boolean {
  return field(form, 'notice') !== '';
}

/**
 * Whether the router is driving this action, or a browser posting a form.
 *
 * It decides whether the two switches on the review screen — the format tabs and
 * the option tabs — end in a `redirect()` or in nothing at all, and the two
 * cases genuinely want different endings.
 *
 * A `redirect()` out of a server action is not free and it is not a header. Next
 * answers the POST by fetching the destination back out of itself over HTTP —
 * see `createRedirectRenderResult` — and because that second request carries no
 * router state, what comes back is the whole tree from the root layout down
 * rather than the segment that changed. So pressing a tab cost two renders of a
 * screen that is not small, and the reply the router applied was a replacement
 * for the entire page: measured here at ~100ms against ~78ms without it, and
 * every uncontrolled bit of DOM state on the page thrown away with it — the
 * settings disclosure you opened to reach the format tabs closed itself every
 * time you used it.
 *
 * `revalidatePath` on its own does the thing the redirect was there for. The
 * action's own response carries the re-rendered page, scoped to the part that
 * changed, and the URL never moves — which also means there is no navigation to
 * scroll, so the `#reply` fragment has nothing left to fix.
 *
 * Without JavaScript there is no such response to apply. The browser posted a
 * form and is waiting for a page, and the `Location` it is handed is the only
 * thing that can put it back at the tabs it pressed. So that path keeps the
 * redirect exactly as it was.
 *
 * `next-action` is the header Next itself uses to tell the two apart (it is what
 * `isFetchAction` reads), and it is only ever set by the router. Reading a
 * framework-internal header is a liberty, so it is taken in the safe direction:
 * if the name ever changes, every request looks like a form post and every press
 * goes back to redirecting — which is what this code did before.
 */
async function routerDriven(): Promise<boolean> {
  return (await headers()).get('next-action') !== null;
}

/** Saving without sending. The reviewer's edits are the training signal, so
 * losing them to a closed tab loses more than the typing.
 *
 * And nothing at all once the mail is gone or going, for the reason `keepEdits`
 * refuses it: `sendReply` writes `finalReply` from the text it was handed, and a
 * save that lands underneath it leaves a task whose record of what was proposed
 * is text typed after the customer had already read it. The screen offers no
 * Save in either state — see the task page, where a claim hides every button —
 * so getting here means a stale tab or a form posted twice, and both of those
 * are exactly the race worth refusing. */
export async function saveDraft(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const draft = field(form, 'draft');
  const before = getTask(id);

  // Back to the task rather than to `?saved=1`: nothing was saved, and a banner
  // saying otherwise is the one thing worse than the refusal.
  if (!before || before.status === 'sent' || before.status === 'sending') {
    redirect(`/tasks/${id}`);
  }

  // The subject box travels with the draft box, for the reason the draft box
  // travels with the Send button: what goes out is what is on screen. Cleared
  // to empty means "use the customer's own subject", which is a choice, so it
  // is stored as null rather than ignored.
  const notes = optional(form, 'notes');
  updateTask(id, {
    draft,
    replySubject: field(form, 'subject').trim() || null,
    ...formatFrom(form),
    ...(notes === undefined ? {} : { reviewerNotes: notes || null }),
  });

  // An edited draft's translation is now of text nobody is going to send.
  // `getTranslation` already refuses to show it — which leaves a reviewer who
  // does not read the reply's language staring at an empty panel with no way
  // to fill it, because until now nothing queued the re-translation.
  //
  // Skipped when only the notes changed: the same words do not need rendering
  // twice, and saving is what people do while thinking.
  //
  // Both sides in one spelling first, exactly as `keepEdits` does it. `draft`
  // came through `field`, which normalises what a textarea submits; the row did
  // not, and on any task last written before that fix it still holds CRLF. Two
  // invisible bytes were enough to make Save on an untouched reply log an
  // "edited" nobody did, write a duplicate version, and queue a re-translation
  // of the same words.
  if (draft.trim() !== newlines(before?.draft ?? '').trim()) {
    enqueueForTranslation(id);
    // And turned, rather than left for the crontab.
    //
    // Queueing it was half the job. Nothing in this process turns the queue —
    // see the long note on `redraftTask` — and the only screen that nudged it
    // was the one polling behind a redraft, so a saved draft's rendering sat
    // there until a cron came past. On an install without one it sat there for
    // good. What that costs is not abstract: the reviewer who saves, edits some
    // more and then presses Preview is the reviewer this rendering is for, and
    // they were the one guaranteed to arrive before it did.
    //
    // Here rather than on every view of a task: this fires on an actual edit,
    // which is the moment the work is created, and not on a render. `after`,
    // fire-and-forget, through the same guarded call every other kick uses.
    after(() => nudgeQueue(3));
    // Only a real change to the text. Saving is what people do while
    // thinking, and a history of six identical "edited" lines says less than
    // one does.
    recordEvent(id, 'edited', { actor: (await currentOperator())?.id ?? null });
    recordDraft(id, draft, { source: 'human' });
  }

  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}?saved=1`);
}

/**
 * The unread dot, cleared by somebody having actually looked.
 *
 * The only action here that is not a form post, and the only one posted by a
 * `useEffect` rather than by a button. Both of those follow from what it is for:
 * it records a *view*, and a view is the one event on this desk that the server
 * cannot infer from a render any more. The inbox prefetches a task page when the
 * pointer crosses its row, which renders this whole screen without anybody
 * seeing it — so the old `after(() => markOpened(id))` was clearing the dot off
 * mail nobody had opened. See `opened.tsx`.
 *
 * Deliberately does not revalidate. Nothing on the screen that just mounted
 * changes because of this, and a revalidation would send the whole review page
 * back down the wire again a moment after it arrived, which is the opposite of
 * why any of this was touched. The dot lives on the inbox, and the inbox is
 * rendered again on the way back to it.
 *
 * `markOpened` writes only where the column is still null, so the duplicate this
 * gets on a hard load — where the page has already marked it server-side, for
 * the sake of browsers with no scripting — costs a statement and no write.
 *
 * It also queues the cards, and this is the right place for that precisely
 * because of everything above: it fires when a *person* opens a task, and not
 * when the pointer crosses its row. A card rendering can go missing for reasons
 * no writer of the card knows about — the desk changed language, a callback
 * added a source after the job had run, a translator was down for an hour — and
 * every one of them leaves a screen that would have been rendered and was not.
 * Asked before it is queued, so this stays two reads on a path that is supposed
 * to cost nothing: the answer on a task whose cards are already rendered — every
 * task, nearly always — is no job and no work. What it buys is that no task can
 * be stuck untranslated for good, whatever put it there. The card is still in
 * the source's words on this view, and right on the next one.
 */
export async function noteOpened(taskId: string): Promise<void> {
  await requireApi();
  markOpened(taskId);
  if (cardsAwaitingRendering(taskId)) enqueueForTranslation(taskId);
}

/**
 * Whatever is in the draft box, kept before something else overwrites it.
 *
 * Every button on the review screen posts the whole form, so the text a
 * reviewer has been editing for ten minutes arrives with the click — and until
 * this existed, Redraft, Ask for options and Reopen all threw it away. That is
 * a quiet loss: nothing says it happened, the box simply comes back with the
 * machine's words in it, and the reviewer's are gone. Kept as a version too,
 * so it is one click to get back.
 *
 * No-ops when nothing changed, so pressing Redraft twice does not write two
 * identical versions.
 *
 * And nothing at all mid-send: `sendReply` is going to write `finalReply` from
 * the text it was handed, so rewriting the draft underneath it produces a task
 * whose record of what was proposed is text that was typed after it went.
 */
async function keepEdits(form: FormData, id: string): Promise<void> {
  // All three read with `optional`, and that is load-bearing rather than tidy.
  //
  // The layout switch is a form in the page header, outside the draft — see
  // `setReviewLayout` — and without JavaScript it posts none of these. Read with
  // `field`, an absent draft arrived as `''`, compared unequal to the text on the
  // row, and was written: switching the view with a script blocked **emptied the
  // reviewer's draft and their subject line in the database**. The comment that
  // used to sit on that form claimed `keepEdits` treated the empty fields as
  // "not asked about"; this is that claim made true.
  const draft = optional(form, 'draft');
  const subject = optional(form, 'subject');
  const notes = optional(form, 'notes');
  const before = getTask(id);
  if (!before || before.status === 'sent' || before.status === 'sending') return;

  // Kept even when the draft is untouched. A reviewer who fixed only the
  // subject and then pressed Redraft would otherwise watch their one edit
  // disappear, and be given no reason for it.
  if (subject !== undefined && (subject || null) !== before.replySubject) {
    updateTask(id, { replySubject: subject || null });
  }
  // And the note, which is the third box in that same form. Changing the format
  // or the view posted the draft and the subject and dropped the note on the
  // floor — the same quiet loss, in the field nobody thinks to save first.
  if (notes !== undefined && (notes || null) !== before.reviewerNotes) {
    updateTask(id, { reviewerNotes: notes || null });
  }
  if (draft === undefined) return;
  // Both sides in one spelling before they are compared. `optional` settles the
  // box; this settles the row, which every press made before that fix wrote
  // CRLF into — without it each of those tasks pays for the old bug exactly
  // once more, on whichever button its reviewer happens to press next.
  const kept = newlines(before.draft ?? '');
  if (draft.trim() === kept.trim()) {
    // The same reply in two spellings. The row is rewritten so the comparison
    // above the box — and the one that lights an option tab — stops reading a
    // carriage return as an edit, and nothing else happens: no version, no
    // "edited" in the history, no re-translation, because nobody edited
    // anything.
    if (kept !== (before.draft ?? '')) updateTask(id, { draft: kept });
    return;
  }

  updateTask(id, { draft });
  recordDraft(id, draft, { source: 'human' });
  recordEvent(id, 'edited', { actor: (await currentOperator())?.id ?? null });
  // The same call `saveDraft` makes, and for the same reason — this path had
  // been writing a new draft and leaving the old translation to be refused by
  // its own fingerprint check, with nothing queued to replace it. Every button
  // that is not Save comes through here: Redraft, Ask for options, Dismiss, the
  // format tabs, the layout switch. A reviewer who does not read the reply's
  // language pressed any one of them and the panel went empty for good.
  enqueueForTranslation(id);
}

/**
 * Whatever is in the file picker, kept the way `keepEdits` keeps the draft.
 *
 * The picker lives inside the review form, so its contents arrive with whichever
 * button was pressed — and the two presses that are *about* the files are Attach
 * and Send. Both call this, which is what makes "pick a file, press Send"
 * carry the file rather than lose it: the confirmation panel renders from the
 * table this writes.
 *
 * Throws when the reply would come out over the ceiling. Both callers turn that
 * into `?error=` on the task, because the alternative — swallowing it — is a
 * file the reviewer watched themselves pick and the customer never receives.
 */
async function keepFiles(form: FormData, id: string): Promise<void> {
  const picked = await readUploads(form);
  if (picked.length) attachToTask(id, picked);
}

/**
 * Files, put on the reply while it is being written.
 *
 * This is a button in the review form rather than a form of its own, for the
 * reason every other button there is: posting the whole form is what carries the
 * draft, and a picker that saved an invoice by throwing away ten minutes of
 * editing would be worse than no picker.
 */
export async function attachFiles(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  await keepEdits(form, id);

  let failure: string | null = null;
  try {
    await keepFiles(form, id);
  } catch (error) {
    failure = message(error);
  }

  // Revalidated and *not* redirected, which is the difference between the tile
  // appearing under the hand that added it and the whole screen jumping.
  //
  // A redirect to the address you are already on is still a navigation, and the
  // router answers a navigation by putting the page back at the top — so
  // attaching a file to a reply you had scrolled down to threw you up to the
  // subject line, every time, on the one screen where scrolling back means
  // finding your place in a letter again. There is nothing to redirect *to*:
  // this action does not change which page you are on. Revalidating swaps the
  // row of tiles in place and leaves everything else, including the scroll and
  // the cursor in the draft box, exactly where it was.
  //
  // The failure still redirects, because the sentence saying why lands in the
  // banner at the top and being taken to it is the point.
  revalidatePath(`/tasks/${id}`);
  if (failure) redirect(`/tasks/${id}?error=${encodeURIComponent(failure)}`);
}

/**
 * One of them, taken back off.
 *
 * The id is bound to the action rather than carried as the button's value; see
 * the note on `useAlternative` for why the obvious HTML silently does nothing.
 *
 * No redirect here either, and for the same reason — see `attachFiles`.
 */
export async function detachFile(fileId: string, form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  await keepEdits(form, id);
  detachFromTask(id, fileId);
  revalidatePath(`/tasks/${id}`);
}

/**
 * Redraft, asked rather than assumed.
 *
 * "Redraft" with nothing said asks the same model the same question and is
 * entitled to the same answer, so the instruction is the whole of the feature —
 * which is why the box for it used to sit open under every draft on every
 * screen, whether or not anybody was going to redraft anything. A permanently
 * open input for an action nobody has taken is clutter that also teaches people
 * to ignore it. This asks at the moment of asking, with whatever they last
 * said already in the box.
 *
 * The edits go in first, same as the send path: a reviewer who fixed the
 * subject and then hit Redraft must not watch that work disappear.
 */
export async function askRedraft(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  await keepEdits(form, id);
  redirect(`/tasks/${id}?redraft=1`);
}

/**
 * The step between deciding to send and sending.
 *
 * Approve and Send is the one irreversible button on the desk, and until now it
 * was also a single click on a screen full of other buttons. This puts the mail
 * in front of the reviewer one more time before it leaves: what the customer
 * wrote, what is about to go back, and both of them in the language the
 * reviewer reads.
 *
 * A round trip rather than a dialog in the browser, for the reason the draft box
 * has no client state at all: the panel has to show what will actually be sent,
 * and the only copy that can promise that is the one on disk. So the edits are
 * written first and the confirmation renders from the row — a screen that read
 * from the textarea could show one thing and post another.
 *
 * Writing first is also what made this the one draft writer in the file without
 * the guard every other one carries. `keepEdits`, `restoreDraft` and
 * `setReplyFormat` all refuse a `sent` or `sending` task and say why; this wrote
 * three columns unconditionally, on the action bound to the review form itself.
 * A confirm landing while a send holds the claim rewrote the draft under it. The
 * panel this redirects to is already gated on `sendable`, so the refusal costs
 * nothing: the reviewer lands on the task and reads what actually happened to it.
 */
export async function confirmSend(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const before = getTask(id);
  if (!before || before.status === 'sent' || before.status === 'sending') {
    redirect(`/tasks/${id}`);
  }
  const draft = field(form, 'draft');
  // The review screen's form does not carry a notes box any more — it is asked
  // for on the panel this redirects to — so an absent field must leave whatever
  // is on the row alone rather than clear it on the way past.
  const notes = optional(form, 'notes');
  const subject = field(form, 'subject');

  updateTask(id, {
    draft,
    replySubject: subject || null,
    ...formatFrom(form),
    ...(notes === undefined ? {} : { reviewerNotes: notes || null }),
  });

  // Anything still sitting in the picker, before the panel goes up. A reviewer
  // who picks a file and presses Send has attached it — the alternative is a
  // confirmation that lists no files and a mail that carries none, which is the
  // exact failure the picker used to have on the other side of this redirect.
  //
  // After the draft is written, so an oversized pick costs the reviewer the file
  // and not their editing.
  try {
    await keepFiles(form, id);
  } catch (error) {
    redirect(`/tasks/${id}?error=${encodeURIComponent(message(error))}`);
  }

  // The stored translation is keyed to the exact text it was made from, so an
  // edited draft has none — and a confirmation screen that shows the reply
  // untranslated to someone who cannot read it is the leap of faith this whole
  // step exists to remove. So it still gets made; what changed is where it is
  // waited for.
  //
  // It used to be awaited here, between the button and the redirect, which put
  // a whole model call — a shelled-out CLI on some installs, seconds not
  // milliseconds — in front of a panel that needs none of it to be drawn. The
  // reviewer got a screen that did nothing at all until the translator was
  // finished. It is streamed into the panel now, arriving in the one column
  // that is about it; see `DraftReading` on the task page.
  //
  // This is the durable copy of the same work, and it is here rather than there
  // because a render can be abandoned — Escape, a closed tab, a reviewer who
  // has seen enough — and a render that is abandoned writes nothing. The job
  // dedupes on the task and every part of it opens with `hasTranslation`, so
  // whichever of the two lands first, the other finds the work already done.
  enqueueForTranslation(id);

  redirect(`/tasks/${id}?confirm=1`);
}

export async function approveAndSend(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  // `optional`, not `field`. The confirmation panel does carry a hidden `notes`
  // input, so this was safe — but safe because of a field on another screen,
  // which is the kind of safety that ends the day somebody tidies the panel.
  const notes = optional(form, 'notes');
  // The way out of the learning loop, offered on the confirmation and nowhere
  // else. It applies to this one reply: it is not a preference, because "stop
  // learning" is not a decision anybody should be able to make for the whole
  // desk from a send button, and a remembered switch becomes "this desk stopped
  // learning months ago and nobody remembers who turned it off".
  //
  // It changes the third step only. The mail goes out and the row is written
  // exactly the same either way — see `sendReply`, where the order of those
  // three is not negotiable — and the decision is recorded on the `sent` event,
  // because in three months "why did this one teach nothing" has to have an
  // answer that is not a guess.
  const skipLearning = form.get('skipLearning') === '1';

  let failure: string | null = null;
  try {
    // The edited text is saved before the send is attempted: if the provider
    // is down, the reviewer's work is still on disk when they come back.
    //
    // Not onto a row that is already sent or claimed, though. This write sits
    // ahead of `sendReply`'s claim, so a double-clicked button or a stale tab
    // rewrote the draft of a mail that had already gone and was told no
    // afterwards — the refusal arrived, and the record of what was proposed had
    // already been replaced by the text that lost the race. The claim still
    // decides whether anything is sent; this only decides whether the row
    // survives being refused.
    const before = getTask(id);
    if (before && before.status !== 'sent' && before.status !== 'sending') {
      updateTask(id, {
        draft: field(form, 'draft'),
        ...formatFrom(form),
        ...(notes === undefined ? {} : { reviewerNotes: notes || null }),
      });
    }
    // Whatever the reviewer put on this reply while writing it. Read from the
    // row rather than from this form, for the same reason the panel above
    // renders from the row: what goes out has to be what was on screen when
    // Send was pressed, and the panel has no picker to post one.
    //
    // `sendReply` deletes them in the transaction that marks the task sent, so
    // there is no clean-up on this side and none to forget on a failure — a
    // send that throws leaves the files where the reviewer can see them and try
    // again.
    const attachments = pendingAttachments(id);
    await sendReply(id, {
      finalReply: field(form, 'draft'),
      subject: field(form, 'subject'),
      ...(notes ? { reviewerNotes: notes } : {}),
      sentBy: (await currentOperator())?.id ?? null,
      ...(attachments.length ? { attachments } : {}),
      ...(skipLearning ? { skipLearning: true } : {}),
    });
  } catch (error) {
    failure = message(error);
  }

  revalidatePath('/');
  revalidatePath(`/tasks/${id}`);
  if (failure) redirect(`/tasks/${id}?error=${encodeURIComponent(failure)}`);
  redirect('/?sent=1');
}

/**
 * A reviewer overruling the classifier.
 *
 * The category is not decoration. It decides which rules the drafter is handed
 * — see `assemble` — so a mail filed under the wrong one is answered against
 * the wrong rulebook, and until now the only remedy was to fix the letter by
 * hand every time it happened. Nothing is redrafted from here, deliberately:
 * changing the filing of a mail somebody is halfway through editing must not
 * throw their edit away. The hint under the control says to redraft, and the
 * button for it is on the same screen.
 *
 * An empty selection is a real answer — "none of these" — and stores NULL,
 * which is what an unclassified task has always held.
 */
export async function changeTopic(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const chosen = normaliseTopicSlug(form.get('scope'));
  const task = getTask(id);
  if (task && task.scope !== chosen) {
    updateTask(id, { scope: chosen });
    recordEvent(id, 'recategorised', {
      // The name a person recognises, not the slug: this line is read in the
      // history by whoever is wondering why the reply changed.
      detail: chosen ? topicLabel(chosen) : '',
      actor: (await currentOperator())?.id ?? null,
    });
  }

  revalidatePath('/');
  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}`);
}

export async function dismissTask(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const dismissed = rejectTask(id, {
    reason: field(form, 'reason'),
    // `rejectTask` already distinguishes undefined from empty — see its input
    // type — so passing the absent field through as undefined is what stops a
    // dismissal wiping the note that explains the draft.
    notes: optional(form, 'notes'),
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
 * Opening the dismissal panel, keeping the edits on the way.
 *
 * The mirror of `askRedraft`. It posts rather than links for the same reason:
 * the button lives inside the draft's form, so going to the panel has to carry
 * whatever is in the box or a reviewer who tidied the draft and then decided not
 * to send it would lose the tidying on the way to explaining why.
 */
export async function askDismiss(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  await keepEdits(form, id);
  redirect(`/tasks/${id}?dismiss=1`);
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
  await keepEdits(form, id);
  await reopen(id, { actor: (await currentOperator())?.id ?? null });

  revalidatePath('/');
  revalidatePath(`/tasks/${id}`);
  redirect(`/tasks/${id}`);
}

export async function redraftTask(form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  await keepEdits(form, id);
  const task = getTask(id);
  // Not while a send holds the claim. Redrafting one moved it to `pending` and
  // queued a drafter, the send then finished and wrote `sent` plus the reply
  // that went out, and the drafting job — still in flight — overwrote that
  // with a draft for a mail the customer had already read.
  const asked = task !== null && task.status !== 'sending';
  if (task && asked) {
    // Back to pending first, or the job's own guard would see a task that is
    // already awaiting review and the queue would dedupe the request away.
    //
    // The note goes with it. "Redraft" on its own asks the same model the same
    // question and is entitled to the same answer; the box under the draft is
    // where the reviewer already says what is wrong with it, and the drafter
    // reads it from here.
    const instruction = optional(form, 'notes');
    // Which of the two buttons was pressed. Revise amends the text on the
    // screen and rewrite replaces it — the panel has both because a reviewer
    // who wants a different approach may still have something to say about
    // which one, and inferring the answer from whether they typed anything got
    // that case backwards every time.
    //
    // Anything unrecognised is a rewrite, which is what the single button did.
    const mode: RedraftMode = field(form, 'mode') === 'revise' ? 'revise' : 'rewrite';
    updateTask(id, {
      status: 'pending',
      error: null,
      ...(instruction === undefined ? {} : { reviewerNotes: instruction || null }),
    });
    recordEvent(id, mode === 'revise' ? 'revise' : 'redraft', {
      detail: field(form, 'notes'),
      actor: (await currentOperator())?.id ?? null,
    });
    // Through the enrichment path, not straight to drafting. Someone clicking
    // Redraft is often doing it because the reply was wrong about who this
    // person is, which is the case a stale — or failed — lookup produces.
    //
    // And down whichever pipeline wrote it in the first place. Redraft on a
    // composed mail used to go to the drafter, which reads the task body as a
    // customer's letter — so pressing it on a review follow-up answered our
    // own brief, in a mail addressed to the customer.
    // Without the critic, which is the difference between a redraft and a
    // first draft rather than an economy on one.
    //
    // Two model calls run back to back in the drafting job, and measured on
    // this desk the second is the larger of them: the drafter takes about a
    // minute and the critic about ninety seconds, so skipping it is most of a
    // two-and-a-half minute wait. That wait is the whole cost of the button —
    // a reviewer is sitting in front of it watching a spinner, which is not
    // true of the first draft, written before anybody opened the mail.
    //
    // And the critic is worth less here than anywhere: it exists to catch the
    // draft that reads well and quietly breaks a policy, on a desk where
    // nobody has looked yet. On a redraft somebody has looked, has said what
    // is wrong in the box, and is about to read the answer. A second model
    // rewriting that answer against generic rules is as likely to undo the
    // instruction as to improve on it.
    await enqueueContextThenWrite(task, { critic: false, mode });
    // Started now rather than whenever a cron happens to fire.
    //
    // Nothing in this process turns the queue: jobs move when `/api/worker` is
    // hit on a schedule or when somebody opens the Queue screen and presses the
    // button. That is the right shape for a desk that runs unattended, and it
    // was the wrong shape for a button a person just clicked and is watching —
    // Redraft enqueued the work, closed the panel, and on an install without the
    // crontab set up the redraft simply never happened.
    //
    // `after` rather than awaiting it: a drafting job is a model call and can
    // take the better part of a minute, and the reviewer should get their screen
    // back immediately and watch it there. The claim the worker takes is what
    // makes this safe to run alongside a cron that fires mid-draft.
    //
    // Through `nudgeQueue`, which is the same call the review screen's poller
    // makes. This built its own worker, and a worker built here is a worker the
    // flag in that module cannot see: two reviewers pressing Redraft at the same
    // moment, or one pressing it while a poll tick is mid-drain, was exactly the
    // pile-up the flag exists to prevent, arriving down the one path that had
    // been left out of it.
    after(() => nudgeQueue(5));
  }
  revalidatePath(`/tasks/${id}`);
  // Back to the panel only when there is something to watch. The flag alone put
  // a reviewer who pressed Redraft mid-send on a screen with no panel, no
  // banner and no explanation — the page renders the working state for `pending`
  // and `drafting`, and this branch changed neither. A button that posts,
  // redirects, and comes back with nothing is the failure the Dismiss button was
  // just fixed for; this is it one action over.
  redirect(asked ? `/tasks/${id}?redrafting=1` : `/tasks/${id}`);
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

  // `sending` alongside `sent` for the reason `keepEdits` refuses it: the draft
  // column is what the in-flight send is about to be recorded against.
  if (version && version.taskId === id && task && task.status !== 'sent' && task.status !== 'sending') {
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
  // `restored`, not `saved`. Nothing was saved — a version was swapped into the
  // box — and the two want different answers on screen: "Saved." belongs by the
  // Save button, and this belongs on the box, whose entire contents just
  // changed under somebody who is about to read them.
  redirect(`/tasks/${id}?restored=1`);
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

  await enqueueContextThenCompose(task.id);
  // Turned now rather than left for whenever a cron happens to fire.
  //
  // The same call Redraft makes, against the same hole and for the same reason:
  // somebody wrote this brief thirty seconds ago and is being sent straight to
  // the screen where the result is supposed to appear. Nothing in this process
  // turns the queue on its own, so on an install without the crontab set up the
  // job sat at `pending` and the result never came — a compose screen that
  // accepts a letter and then quietly does nothing with it, which is worse than
  // one that refuses. Redraft was given this kick and this path was not, so the
  // two buttons that ask the model for prose behaved differently for no reason
  // a person could see.
  //
  // `after`, so the redirect is not held behind a model call: the review screen
  // polls while the task is in the machine's hands and renders the draft when it
  // lands. Through `nudgeQueue` rather than a worker built here — see that
  // module for why two people composing at the same moment must not build two.
  after(() => nudgeQueue(5));
  redirect(`/tasks/${task.id}?queued=1`);
}

/*
 * There was an "Other options" button here, and it is gone on purpose.
 *
 * It enqueued the same job that drafting now enqueues for every mail. Behind a
 * button it was indistinguishable from a broken one: the options took two and a
 * half minutes, this screen has no client-side JavaScript to notice them
 * arriving, and the only feedback was a grey line that said "redraft queued"
 * because the wording had been copied from the button beside it. The options
 * landed, correctly, on a page nobody was still looking at.
 *
 * The set is generated with the draft now and sits above the box as tabs, which
 * is where the upstream desk had it all along.
 */

/**
 * Switching the draft box to one of the options.
 *
 * What is in the box now is kept first, so picking B, reading C and coming back
 * does not cost anybody their editing. That is `keepEdits` rather than a copy of
 * the stored draft, and the difference is the whole point once these became
 * tabs: a reviewer who has been typing and then clicks another tab has edits
 * that are *only* in the textarea, and reading `task.draft` would file the text
 * they had before they started typing and drop the rest on the floor.
 *
 * The set is left on the page — a reviewer who picks one and then changes their
 * mind should not have to pay for the other two again.
 */
/*
 * The option's id arrives bound rather than in the form, and it has to.
 *
 * The obvious HTML is `<button name="alternativeId" value={id} formAction={…}>`:
 * a submit button contributes its own name and value, which is exactly how four
 * tabs are supposed to share one form. It does not survive a Server Action —
 * React builds the payload for the action itself and the clicked button's
 * name/value is not in it — so every tab posted an empty id, `getAlternative`
 * returned null, and clicking a tab did nothing at all while looking like it
 * should have. Binding is the supported way to give one action per-button
 * arguments, and it leaves the textarea in the FormData, which is the whole
 * reason these tabs live inside the draft's form.
 */
/**
 * Switching the reply between Markdown, plain text and HTML.
 *
 * Bound rather than carried on the button, for exactly the reason the note above
 * gives: a submit button's name and value do not survive a Server Action, so the
 * obvious `<button name="format" value="html">` would post nothing and the tabs
 * would look clickable and do nothing.
 *
 * It applies immediately rather than waiting for Save, and that is the point of
 * making it a submit at all: the format decides how the box below is turned into
 * mail, so the preview beside it is wrong until the row knows. `keepEdits` runs
 * first so switching never costs somebody the sentence they were part-way
 * through — the tabs sit inside the draft's own form precisely so the textarea
 * comes with them.
 *
 * The text is never rewritten. Converting Markdown into HTML on the way through
 * would be this app editing a reply nobody approved, and converting back is
 * lossy in both directions.
 */
export async function setReplyFormat(format: ReplyFormat, form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  await keepEdits(form, id);

  const task = getTask(id);
  if (task && task.status !== 'sent' && task.status !== 'sending') {
    updateTask(id, { replyFormat: format });
  }

  revalidatePath(`/tasks/${id}`);
  // The revalidation is the answer, and with the router listening it is the
  // whole answer: the page comes back patched in place, at the scroll position
  // and with the disclosure still open. Only a form post with no script behind
  // it needs sending anywhere, and then straight back to the tabs it pressed —
  // see `routerDriven` and `replyHref`. The exception is a stale banner, which
  // lives in the URL and can only be cleared by moving it; see `clearsNotice`.
  if (!(await routerDriven()) || clearsNotice(form)) redirect(replyHref(id, '?saved=1'));
}

/**
 * Switching between the two ways of reading the review screen.
 *
 * The switch lives in the page header, beside the nav, because that is where a
 * control over the whole screen belongs and because it has to be reachable from
 * the top of a long task. That puts it outside the draft's own form, so
 * `CarryDraft` copies the boxes into it on submit — see the note there, and in
 * `keepEdits`, for why that form ships with no hidden fields of its own. Without
 * a script the view still switches and nothing on the row is touched; only an
 * unsaved half-sentence goes, the way an unsaved anything goes when you navigate.
 *
 * `taskId` may still be absent, so the redirect falls back to whatever page
 * asked.
 *
 * No query parameter: how somebody reads is a property of the reader, not of the
 * link, and putting it in the address bar makes a shared URL impose your reading
 * on whoever opens it.
 */
export async function setReviewLayout(layout: ReviewLayout, form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  if (id) await keepEdits(form, id);
  await setReviewLayoutCookie(layout);

  const back = id ? `/tasks/${id}` : sameOrigin(field(form, 'returnTo'));
  // The layout, not the page — the same call `setTheme` and
  // `setInterfaceLanguage` make, and for the same reason: the switch this action
  // toggles is rendered by the root layout, so revalidating the page it was
  // pressed on left the pill lit on the option that was current *before* the
  // press. The screen relaid out and the control disagreed with it, which reads
  // as a broken button rather than as a stale cache.
  //
  // It also fixes a call that was doing nothing at all: `back` is
  // `sameOrigin(returnTo)` when there is no task, and that carries the query —
  // `/?status=sent&q=refund` — which `revalidatePath` does not take.
  revalidatePath('/', 'layout');
  redirect(back);
}

/**
 * Light, dark, or the machine's answer.
 *
 * A cookie and a redirect, like the layout switch — no script, and no flash of
 * the wrong palette on the way in, because the attribute is on `<html>` in the
 * markup the server sends rather than added by something that has to load first.
 *
 * Nothing to keep here. This form is in the header and carries no draft, and
 * unlike the layout switch it is offered on every screen rather than on the one
 * with a half-written reply in it — so there is deliberately no `keepEdits`.
 * Somebody changing the palette mid-sentence on the review screen loses the
 * sentence, which is the same thing any navigation does and is the honest cost of
 * a control that belongs to the whole app rather than to that form.
 */
export async function setTheme(chosen: Theme, form: FormData): Promise<void> {
  await requireApi();
  await setThemeCookie(chosen);

  const back = sameOrigin(field(form, 'returnTo'));
  revalidatePath('/', 'layout');
  redirect(back);
}

/**
 * The language of the interface, changed from the header rather than from the
 * wizard.
 *
 * Desk-wide, not per person, and that is the existing decision rather than a new
 * one — see `locale()` in lib/i18n. A support desk is a room of people who share
 * a language, and "the second field on the mailbox screen" has to be a sentence
 * one colleague can say to another. This writes the same workspace file the
 * setup step writes; it just stops the answer being buried four screens deep.
 *
 * And it reports the write the way the wizard does. The result was being thrown
 * away, so on a deployment whose config file is read-only — a container with the
 * app directory mounted `ro`, which is a normal way to run this — the menu
 * closed, the page came back in the same language, and nothing said why. That is
 * indistinguishable from a broken control, which is the exact confusion
 * `localePinned` exists to prevent for the other cause. The voice step is where
 * this file is edited and the one screen that knows how to offer the
 * paste-it-yourself fallback — wherever that step currently lives, which is a
 * page of the wizard on a new install and a section of the settings screen on
 * an old one.
 */
export async function setInterfaceLanguage(language: Locale, form: FormData): Promise<void> {
  await requireApi();
  const result = saveWorkspaceConfig({ language });

  // Every context card on the desk was rendered into the language that was
  // current a moment ago, and a rendering is looked up by the language it is
  // for — so as of this line the whole backlog reads in whatever words its
  // source wrote, and nothing was going to change that. The job that made them
  // is queued once per email, and those emails have already been through it.
  //
  // After the write, so the jobs are queued for the language that was actually
  // saved rather than the one this action was asked for. Only the tasks still
  // on the desk; see `taskIdsWithContext` for what happens to the archive, and
  // note that switching back is free — a rendering for a language is still
  // there when that language comes round again.
  if (result.saved) {
    after(() => {
      for (const taskId of taskIdsWithContext()) enqueueForTranslation(taskId);
    });
  }

  revalidatePath('/', 'layout');
  if (!result.saved) {
    redirect(stepHref('voice', `unwritable=${encodeURIComponent(result.error ?? 'unknown')}`));
  }
  redirect(sameOrigin(field(form, 'returnTo')));
}

export async function useAlternative(alternativeId: string, form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'taskId');
  const option = getAlternative(alternativeId);
  await keepEdits(form, id);
  const task = getTask(id);

  if (option && option.taskId === id && task && task.status !== 'sent' && task.status !== 'sending') {
    recordDraft(id, option.body, { source: 'model', notes: option.strategy || null });
    updateTask(id, { draft: option.body });
    recordEvent(id, 'edited', {
      detail: `option ${option.label}`,
      actor: (await currentOperator())?.id ?? null,
    });
    enqueueForTranslation(id);
    // Turned as well, for the reason Save's is — this swap replaced the whole
    // reply, so the rendering on screen is of a draft nobody is going to send.
    after(() => nudgeQueue(3));
  }

  revalidatePath(`/tasks/${id}`);
  // Comparing three approaches means pressing A, B and C in turn, so this is the
  // press that most needs to cost nothing: with the router listening the page is
  // patched where it stands and the tab that was clicked is still under the
  // cursor, because nothing navigated. A form post with no script still gets
  // sent back to the strip, and so does the first press under a stale banner —
  // see `routerDriven`, `clearsNotice` and `replyHref`.
  if (!(await routerDriven()) || clearsNotice(form)) redirect(replyHref(id, '?saved=1'));
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
 * Turns a rule the model proposed into one the desk actually follows.
 *
 * The click is the entire security boundary. Everything the learning pass
 * writes has had a customer's words in its context, so until somebody here
 * reads a proposal and agrees with it, it is a suggestion and is kept out of
 * every prompt. Discarding one is `removeRule`, which is already on the page.
 */
export async function approveProposedRule(form: FormData): Promise<void> {
  await requireApi();
  const rule = approveRule(field(form, 'ruleId'));
  // It was never summarised — proposals are not in that queue — and now that
  // it is a real rule it needs the one line the list is scanned by.
  if (rule) enqueueSummariseRules();
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

/*
 * The target state arrives bound, for the reason the option id on
 * `useAlternative` does — and this button is where that lesson had not been
 * applied yet.
 *
 * It was `<button name="enabled" value={String(!rule.enabled)} formAction={…}>`,
 * which is the obvious HTML and does not survive a Server Action: React needs
 * the clicked button's `name` to encode which action to invoke, so it overwrites
 * it and the rendered markup says `name="$ACTION_ID_…"`. The field never
 * arrived, `field(form, 'enabled') === 'true'` was therefore always false, and
 * the button could only ever switch a rule off. Retiring one worked; restoring
 * it silently retired it again, which looks exactly like a page that did not
 * reload.
 */
export async function toggleRule(enabled: boolean, form: FormData): Promise<void> {
  await requireApi();
  const id = field(form, 'ruleId');
  const content = field(form, 'content');

  // The whole card posts, edits included. Toggling used to send only the flag,
  // so opening a rule, rewording it, then switching it off threw the rewording
  // away — silently, because the page reloads looking exactly as expected.
  const before = getRule(id);
  const rewritten = before != null && content !== '' && content !== before.content;

  updateRule(
    id,
    {
      enabled,
      ...(rewritten
        ? {
            content,
            category: coerceCategory(field(form, 'category')),
            topics: form.getAll('topics').map(String),
          }
        : {}),
    },
    { reason: 'manual', actor: await actorName() },
  );

  // Only a changed sentence needs a new summary; a flag does not.
  if (rewritten) enqueueSummariseRules();
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
  await requireAdminApi();
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
  // The name, so the page can say who. Encoded because it is whatever somebody
  // typed, and rendered as text on the other side.
  redirect(`/operators?added=${encodeURIComponent(name)}`);
}

export async function changeOperatorPassword(form: FormData): Promise<void> {
  await requireAdminApi();
  const password = field(form, 'password');
  if (!password) redirect('/operators?error=blank');
  setOperatorPassword(field(form, 'operatorId'), password);
  revalidatePath('/operators');
  redirect('/operators?changed=1');
}

/*
 * Bound, not posted — the same React trap as `toggleRule` above. Here the dead
 * field also made the guard below misfire: restoring the only operator on a
 * passwordless install read as an attempt to disable the last one, so the one
 * button that could undo the lockout answered with an error about causing it.
 */
export async function setOperatorAccess(enabled: boolean, form: FormData): Promise<void> {
  await requireAdminApi();
  const id = field(form, 'operatorId');

  // Disabling the last active operator on an install with no shared password
  // does not lock the door — it removes it, and the next visitor walks in
  // unauthenticated. Refusing here is the difference between a mistake and an
  // exposed inbox.
  if (!enabled && adminPassword() === null && countActiveOperators() <= 1) {
    redirect('/operators?error=last');
  }

  // And retiring the last admin locks the settings rather than the door. Same
  // shape of mistake, one floor down: the desk keeps working, nobody can
  // change the mailbox it works on, and the screen where that is undone is one
  // of the four this flag governs. Only when there is no shared password —
  // with one set there is always a way back in as nobody in particular.
  if (!enabled && adminPassword() === null && getOperator(id)?.admin && countActiveAdmins() <= 1) {
    redirect('/operators?error=lastAdmin');
  }

  setOperatorEnabled(id, enabled);
  revalidatePath('/operators');
  redirect('/operators');
}

/**
 * Who may reach the queue, the archive, this list and the settings.
 *
 * Bound rather than posted, like `setOperatorAccess` above and for the same
 * reason. The guard is the one that matters here: demoting the last admin on
 * an install with no shared password leaves a desk that cannot be configured
 * by anyone, from any screen, and the only repair is a SQLite client on the
 * host. It is refused rather than warned about.
 */
export async function setOperatorRole(admin: boolean, form: FormData): Promise<void> {
  await requireAdminApi();
  const id = field(form, 'operatorId');

  if (!admin && adminPassword() === null && countActiveAdmins() <= 1) {
    redirect('/operators?error=lastAdmin');
  }

  setOperatorAdmin(id, admin);
  revalidatePath('/operators');
  // The nav is rendered by the root layout, so the demoted person's four links
  // hang around until something rebuilds it. On their next navigation this is
  // what has already made that a fresh render rather than a cached one.
  revalidatePath('/', 'layout');
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
  await requireAdminApi();
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
  await requireAdminApi();
  const id = field(form, 'jobId');
  const job = retryJob(id);
  revalidatePath('/queue');
  if (job) redirect('/queue?retried=1');

  // Two ways to refuse, and they read completely differently to whoever
  // pressed the button. "Not failed" means somebody got there first; the other
  // means a newer job already holds this one's dedupe key — the usual cause
  // being a Redraft, which enqueued a replacement while this one sat here.
  redirect(
    `/queue?error=${encodeURIComponent(
      t(hasLiveDuplicate(id) ? 'queue.retrySuperseded' : 'queue.notFailed'),
    )}`,
  );
}

export async function releaseJobNow(form: FormData): Promise<void> {
  await requireAdminApi();
  const job = releaseJob(field(form, 'jobId'));
  revalidatePath('/queue');
  redirect(job ? '/queue?released=1' : `/queue?error=${encodeURIComponent(t('queue.notStuck'))}`);
}

export async function deleteJobNow(form: FormData): Promise<void> {
  await requireAdminApi();
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
  await requireAdminApi();
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
 * The step between deciding to tidy and tidying.
 *
 * "Tidy the rulebook" was a bare button on a toolbar, and what it starts is a
 * model pass that rewords rules somebody wrote by hand and switches others off.
 * Nothing about the label says that, and the confirmation it deserves is not
 * "are you sure" — it is an account of what the pass does, what it leaves
 * alone, and how to undo it.
 *
 * A page state rather than a browser dialog, for the reason the send
 * confirmation is one — see `askDismiss`. The only thing it carries is which
 * filter the rulebook is under, because the panel's way out is a link back to
 * this page and the round trip must not quietly switch the list underneath it.
 * Compared rather than passed through: this ends up in a URL, and the one
 * spelling that means anything is the one the page reads.
 */
export async function askTidy(form: FormData): Promise<void> {
  await requireApi();
  const showAll = field(form, 'show') === 'all';
  redirect(showAll ? '/rules?show=all&tidy=ask' : '/rules?tidy=ask');
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

/** A number from a form, held to the bounds the input advertises. */
function bounded(raw: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * The step between choosing a window and paying for it.
 *
 * `askTidy`'s twin, and the case for it is stronger. "Scan the Sent folder"
 * reads like listing a directory; what it starts is a full generation per
 * archived reply — classify, draft, criticise, extract — running for hours
 * against a mailbox nobody has looked at in a year, and there is no bill on
 * this screen to notice it on afterwards. The number that decides the cost is
 * already in the form; the panel is where it is said out loud.
 *
 * A page state rather than a browser dialog, for the reason the send
 * confirmation is one — see `askDismiss`. It carries both numbers, because the
 * panel is what actually posts them: a round trip that dropped them would
 * quietly run the defaults over whatever somebody had typed. Clamped here to
 * the bounds the inputs advertise, since `min` and `max` are a browser's
 * courtesy and this ends up in a URL anybody can edit.
 */
export async function askBackfill(form: FormData): Promise<void> {
  await requireAdminApi();

  const months = bounded(field(form, 'months'), 12, 1, 120);
  const limit = bounded(field(form, 'limit'), DEFAULT_SCAN_LIMIT, 1, 5000);

  redirect(`/backfill?scan=ask&months=${months}&limit=${limit}`);
}

/**
 * Learning from the mailbox's history.
 *
 * Queued, never run inline. The scan itself is one provider call, but what it
 * produces is hundreds of generations, and a button that blocked until those
 * finished would be a button that always fails.
 */
export async function startBackfill(form: FormData): Promise<void> {
  await requireAdminApi();

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
  await requireAdminApi();
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
  await requireAdminApi();
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

/**
 * Pulling the price list out of Stripe and into the desk.
 *
 * A button rather than a schedule. A catalogue changes when somebody changes
 * it, which on most desks is a few times a year, and a nightly job would be
 * spending a Stripe call a day to notice nothing — while still being a day
 * stale on the one morning it matters. The person who just edited a price is
 * the person who knows to press this.
 *
 * The counts go back in the URL rather than into a flash cookie: a sync that
 * reports "0 added, 0 updated" is how somebody discovers their key is pointed
 * at the test catalogue, and that sentence has to survive a reload.
 */
export async function syncCatalog(): Promise<void> {
  await requireApi();

  let destination: string;
  try {
    const counts = await syncCatalogFromStripe();
    destination =
      `/catalog?added=${counts.added}&updated=${counts.updated}&gone=${counts.discontinued}`;
  } catch (error) {
    // Shown, not swallowed. The two failures that matter here — a key without
    // the products permission, and a test key on a live desk — both look
    // exactly like an empty catalogue if this is turned into a silent no-op.
    destination = `/catalog?failed=${encodeURIComponent(
      error instanceof Error ? error.message : 'unknown',
    )}`;
  }

  revalidatePath('/catalog');
  redirect(destination);
}

/**
 * The half of an entry that Stripe cannot know.
 *
 * What a product does not include, who it does not suit, the caveat that stops
 * the reply being technically true and wrong. It survives every sync — see
 * `applySync` — which is the only reason it is worth writing.
 */
export async function saveCatalogNote(form: FormData): Promise<void> {
  await requireApi();
  updateCatalogItem(field(form, 'itemId'), { note: field(form, 'note') || null });
  revalidatePath('/catalog');
  redirect('/catalog');
}

/**
 * Out of every prompt, without leaving the desk.
 *
 * Deleting a synced row would only bring it back on the next sync, so the
 * switch is the real control: the row stays, its note stays, and the drafter
 * stops being told about it.
 */
export async function toggleCatalogItem(enabled: boolean, form: FormData): Promise<void> {
  await requireApi();
  updateCatalogItem(field(form, 'itemId'), { enabled });
  revalidatePath('/catalog');
  redirect('/catalog');
}

/** Something the desk sells that Stripe has never billed for. */
export async function addCatalogItem(form: FormData): Promise<void> {
  await requireApi();
  const name = field(form, 'name');
  if (name) {
    createCatalogItem({
      name,
      description: field(form, 'description') || null,
      pricing: field(form, 'pricing') || null,
      note: field(form, 'note') || null,
      source: 'manual',
    });
  }
  revalidatePath('/catalog');
  redirect('/catalog');
}

/**
 * Only ever a hand-written row.
 *
 * A synced one has no delete: it would reappear on the next sync, and offering
 * a button whose effect expires is worse than not offering one. Switch it off
 * instead.
 */
export async function removeCatalogItem(form: FormData): Promise<void> {
  await requireApi();
  const item = getCatalogItem(field(form, 'itemId'));
  if (item?.source === 'manual') deleteCatalogItem(item.id);
  revalidatePath('/catalog');
  redirect('/catalog');
}
