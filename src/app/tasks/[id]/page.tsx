import Link from 'next/link';
import { notFound } from 'next/navigation';
import { after } from 'next/server';

import { nudgeQueue } from '@/lib/queue';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import { REPLY_FORMATS, previewHtml, type ReplyFormat } from '@/lib/mail/render';
import { MAX_UPLOAD_BYTES } from '@/lib/mail/uploads';

import { DismissOnEscape } from '../../dismiss-on-escape';
import { TaskPoller } from '../../task-poller';
import { AttachTile } from './attach-tile';
import { FileTile, sizeKb } from './file-tile';
import { QueueRail, railTasks } from './queue-rail';
import { DraftOverlay, ReviewKeys } from './review-keys';
import { listContext } from '@/lib/context/store';
import { t } from '@/lib/i18n';
import { getOperator } from '@/lib/operators/store';
import { listAttachments } from '@/lib/tasks/attachments';
import { listPending } from '@/lib/tasks/outgoing';
import { listAlternatives } from '@/lib/tasks/alternatives';
import { listEvents } from '@/lib/tasks/events';
import { listMessages } from '@/lib/tasks/messages';
import { markAdded, previewEdit } from '@/lib/tasks/edit-preview';
import { reviewLayout } from '@/lib/tasks/layout';
import { replyBox } from '@/lib/tasks/reply-box';
import { getTask, markOpened } from '@/lib/tasks/store';
import { deskedAt } from '@/lib/tasks/types';
import { listVersions } from '@/lib/tasks/versions';
import { listRules } from '@/lib/rules/store';
import { getTranslation } from '@/lib/translation/store';
import { reviewLanguage } from '@/lib/translation/translate';

import {
  approveAndSend,
  askRedraft,
  attachFiles,
  confirmSend,
  askDismiss,
  detachFile,
  dismissTask,
  redraftTask,
  reopenTask,
  restoreDraft,
  saveDraft,
  setReplyFormat,
  useAlternative,
} from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * How many of the active rules the sidebar names before it stops and links.
 *
 * Six. The question this card answers is "is one of these obviously not meant
 * for this email", and answering it needs enough of the rulebook to recognise
 * the shape of it — three is a sample, not a look. Past six it stops being read
 * at all.
 *
 * The rest are a link rather than a disclosure. Reading the whole rulebook is a
 * different job with a screen of its own, and `/rules` has the search and the
 * editing and the approval queue that job needs; a second copy of the list
 * unfolding in a 288px column is that screen done worse.
 */
const RULES_SHOWN = 6;

/**
 * A message the way its reader sees it, rather than the way it was stored.
 *
 * This was a `<pre>`, which renders a blank line between paragraphs as a whole
 * empty line — a full line box at this leading, against the 12px the customer
 * actually gets from the mail we send. So the screen where a reply is judged was
 * the one place the spacing was wrong, and every message on it read as more
 * loosely spaced than it really is.
 *
 * `pre-wrap` is kept inside each paragraph: a single newline in the middle of
 * one is a line the sender chose to break, and `<br>` is what it becomes in the
 * mail too. Only the gap between blocks is ours to decide.
 */
function EmailBody({
  text,
  className = '',
  language,
}: {
  text: string;
  className?: string;
  language?: string;
}) {
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  return (
    <div className={`email-body ${className}`.trim()} lang={languageTag(language)}>
      {blocks.map((block, i) => (
        <p key={i}>{block}</p>
      ))}
    </div>
  );
}

/**
 * The detected language of a message, if it is something a `lang` attribute can
 * honestly carry.
 *
 * Han characters are shared between Chinese, Japanese and Korean and drawn
 * differently in each, so a stylesheet cannot pick the right face for a letter
 * without being told which language it is in — see the `:lang()` rules in
 * `globals.css`. `task.analysis.language` is the only place that is known, and
 * marking it on the element also tells a screen reader which voice to read the
 * mail in.
 *
 * It is validated here rather than trusted because of where it comes from: the
 * drafting model is asked for ISO 639-1 and `draft.ts` lowercases whatever it
 * says without checking it, so the field holds `ja` on a good day and `japanese`
 * on a bad one. Worse than useless is the empty string, which is what an
 * un-drafted task has and what `lang=""` means to a browser — *this subtree is in
 * no known language* — and that would switch off the CJK stack the page already
 * inherits from `<html lang>`. `undefined` leaves the attribute off entirely,
 * which is the honest answer to not knowing.
 */
function languageTag(language: string | undefined): string | undefined {
  const tag = (language ?? '').trim();
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag) ? tag : undefined;
}



/**
 * The review screen. This is the product.
 *
 * The draft is a plain textarea inside the same form as the Send button, so
 * what gets sent is exactly what is on screen — there is no separate "save"
 * the reviewer can forget, and no client state to desynchronise from it.
 */
/**
 * The reply as the customer will actually receive it.
 *
 * Built by `previewHtml`, which is `replyHtml` — the same function `sendReply`
 * calls — so this cannot drift from the mail. That is the entire point: the
 * format was applied only inside the send path, so a reply written in Markdown
 * reached this screen as `**API**` and the recipient as bold text, and the panel
 * whose one job is "here is what goes out" was the panel not showing it.
 *
 * `dangerouslySetInnerHTML` with the danger removed rather than assumed away —
 * which this comment used to claim while `previewHtml` was a blacklist of three
 * regexes that half a dozen ordinary payloads walked through. For `markdown` and
 * `text` every tag in the string was written by `render.ts` and every character
 * of the reply passed through `escapeHtml` on the way in. For `html` the markup
 * is the *model's*, written after reading mail from a stranger, so it is treated
 * as hostile: `previewHtml` now rebuilds it from an allowlist of tags and
 * attributes and keeps nothing it does not recognise.
 */
function RenderedReply({ text, format }: { text: string; format: ReplyFormat }) {
  return (
    <div
      className="reply-rendered"
      dangerouslySetInnerHTML={{ __html: previewHtml(text, format) }}
    />
  );
}

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();

  // Only for the one link out of here that leads somewhere a reviewer cannot
  // follow — see the queue button in the working panel below.
  const admin = await isAdmin();

  const { id } = await params;
  const query = await searchParams;
  const task = getTask(id);
  if (!task) notFound();

  // After the response, not during the render. Rendering is supposed to be
  // free of side effects — Next may run it twice, or throw the result away —
  // and a write in the middle of it is a write that happens an unpredictable
  // number of times. `after` runs once, when the page has actually been sent.
  after(() => markOpened(id));

  const sent = task.status === 'sent';
  // A claim `sendReply` is holding right now. Every button below is a write to
  // a row the send is about to write itself, so none of them render — see the
  // banner, which is the only thing this state has to say.
  const sending = task.status === 'sending';
  const sender = task.sentBy ? getOperator(task.sentBy) : null;
  const body = task.finalReply ?? task.draft ?? '';
  // Sending is a decision, and these are the states where it has already been
  // made. Rendering the button anyway meant the one on a dismissed task threw
  // — `sendReply` refuses it — and the one on a superseded task worked, which
  // is worse: it answers a question the customer withdrew when they wrote
  // again.
  //
  // The empty check covers `pending` and `drafting`, where the box holds
  // nothing yet because the model has not written it: Send there throws the
  // same refusal a dismissed task does, one status over.
  const sendable =
    !sent && !sending && task.status !== 'dismissed' && !task.supersededBy && body.trim() !== '';
  // Set by `confirmSend`, which has just written the edits to the row. Gated on
  // `sendable` as well as on the flag, so a bookmarked `?confirm=1` on a task
  // that has since been sent, dismissed or superseded shows the task rather
  // than a panel offering to send it again.
  const confirming = query.confirm === '1' && sendable;
  // Redraft is offered wherever the draft is still editable, which is a wider
  // set than `sendable`: a failed or empty task is exactly the one worth asking
  // the model to try again on.
  const redrafting = query.redraft === '1' && !sent && !sending;
  // The model is writing. `pending` and `drafting` are the two states the task
  // passes through between the button and the new reply, so the panel is driven
  // by the row rather than by the flag alone — it closes itself the moment the
  // work lands, and a bookmarked `?redrafting=1` on a finished task shows the
  // task instead of a spinner that will never stop.
  const working =
    query.redrafting === '1' && (task.status === 'pending' || task.status === 'drafting');

  // The machine still has this one — queued, being drafted, or on its way to the
  // mail server.
  //
  // A fact about the row, deliberately not about how you got here. `working` is
  // the same three statuses behind `?redrafting=1`, and for a long time that
  // flag was the only thing that mounted the poller: a task opened from the
  // inbox at `pending` rendered once and then sat there, no draft, no
  // movement, no sign that anything was coming — while the identical row
  // reached by pressing Redraft updated itself every two seconds. The wait is
  // the same wait either way, and the screen has no business being livelier
  // about the one you started than about the one that was already running.
  const inFlight = task.status === 'pending' || task.status === 'drafting' || sending;

  // Turning the queue while somebody is watching it.
  //
  // `redraftTask` kicks a worker of its own, and that alone was not enough:
  // drafting is chained behind an enrichment job, so the first turn completed
  // `enrich-context`, the `draft-reply` it queued arrived a moment later, and
  // the drain had already gone. The job sat at `attempts = 0` with its
  // `run_after` in the past and nothing coming back for it — a spinner over a
  // queue that had quietly stopped.
  //
  // The poller refreshes this page every couple of seconds, so hanging a short
  // drain off the render makes every one of those refreshes a turn of the
  // queue: whatever the last job queued gets picked up on the next tick. Only
  // while the panel is up — an idle review screen starts nothing — and `after`
  // so it runs once the page has actually been sent. The worker's lease is what
  // makes it safe to do this alongside the cron.
  //
  // One at a time — see `nudgeQueue`, which is where the flag that makes it
  // one lives, and why it is not four lines here.
  if (working) after(() => nudgeQueue());
  // Dismissing asks why, the way redrafting asks what for — same shape, same
  // reason. See the panel below and the note where the box used to live.
  const dismissing = query.dismiss === '1' && !sent && !sending && task.status !== 'dismissed';
  // The rules themselves, not just how many of them there are. "5 rules active"
  // is a number, not an explanation: why the draft says what it says is in those
  // five, and not one of them was on screen. The summary already exists for
  // exactly this — what a rule looks like folded up — and this is its second use.
  //
  // Six of them, because the question here is "is one of these obviously wrong
  // for this email", not "what does the rulebook say". That is what /rules is.
  const activeRules = listRules({ enabledOnly: true });
  const rulesInPlay = activeRules.length;
  const rulesShown = activeRules.slice(0, RULES_SHOWN);
  const rulesRest = Math.max(0, rulesInPlay - RULES_SHOWN);
  // The kinds of rule in play, for the folded card to show instead of nothing.
  // In the order they first appear rather than sorted, because that order is the
  // rulebook's own and a reviewer who opens the card meets them in it. Three,
  // then a count: there are only four kinds, so a fourth word buys one bit and
  // costs the line its shape.
  const kinds = [...new Set(activeRules.map(rule => rule.category))];
  const glance = kinds.slice(0, 3);
  const glanceRest = kinds.length - glance.length;
  // How this reader reads. A cookie rather than a query parameter — see
  // `lib/tasks/layout.ts`.
  const layout = await reviewLayout();

  // The queue as the rail shows it, read once and used twice: the rail draws it,
  // and `J` / `K` step through it. Asking twice would let the two disagree about
  // what "next" means, which is the one thing a shortcut must never do.
  const rail = layout === 'columns' ? railTasks() : [];
  // Whether this screen is three columns or two, decided once. The grid and the
  // rail have to agree — a track list that counts a child the page did not
  // render puts the letter where the queue should be.
  const railed = rail.length > 0;
  const at = rail.findIndex(row => row.id === id);
  const neighbours = {
    next: at >= 0 ? (rail[at + 1]?.id ?? null) : (rail[0]?.id ?? null),
    previous: at > 0 ? (rail[at - 1]?.id ?? null) : null,
  };
  const context = listContext(task.id);
  const thread = listMessages(task.id);
  // Inline ones included, and that is the point. A screenshot pasted into
  // Gmail arrives inline, and it is very often the whole content of the email
  // — "here is what I'm seeing". Filtering those out to keep signature logos
  // off the page meant the one thing the customer actually sent was the one
  // thing the reviewer could not see. A stray logo is a cheaper mistake.
  const attachments = listAttachments(task.id);
  // The other direction: files this reviewer has put on the reply, waiting for
  // it to go. Names and sizes only — see `listPending`.
  const carrying = listPending(task.id);

  // Only ever the translation of exactly what is rendered below it. A draft
  // regenerated since its translation was written shows none, because a
  // reviewer who cannot read the reply cannot notice the two have drifted.
  const language = reviewLanguage();
  const bodyText = task.body || '';
  const incoming = language ? getTranslation(task.id, 'body', bodyText, language) : null;
  const outgoing = language ? getTranslation(task.id, 'draft', body, language) : null;

  // Newest first, and never including what is in the box right now — the
  // point of the panel is what the box used to say.
  const drafts = listVersions(task.id);
  const versions = drafts.filter(v => v.body.trim() !== body.trim());

  // What the model wrote, against what is in the box now.
  //
  // Not `task.draft`: that field is the current text, and `keepEdits` writes the
  // reviewer's edits straight into it, so comparing it against the box compares
  // a value with itself. The model's own words survive as the newest version
  // marked `model` — written by `draft-reply`, by `compose-message`, and by
  // picking one of the alternatives — and that is the text this edit departed
  // from. A pure call, computed here and thrown away with the render.
  const edit = previewEdit(drafts.find(v => v.source === 'model')?.body ?? null, body);
  // The same text the box holds, cut into runs so the reviewer's own sentences
  // can be marked underneath it. One run and no marks when nothing was edited.
  const marked = markAdded(body, edit);

  // How tall to open the box: the length of the reply, unless the reply drags a
  // quoted thread along behind it. `narrow` because a translation beside it
  // halves the width, and a half-width box wraps the same words onto twice the
  // lines — see reply-box.ts.
  const box = replyBox(body, { narrow: Boolean(outgoing) });

  // Names, not ids, and resolved once each — a task drafted and edited six
  // times by the same person is six rows pointing at one operator.
  // Hidden once the reply has gone, or while it is going: the choice they
  // represent has been made.
  const alternatives = sent || sending ? [] : listAlternatives(task.id);

  // Which tab is lit.
  //
  // Matched on the text rather than stored on the row, and the mismatch case is
  // the useful one: once the reviewer edits, the box is nobody's option any
  // more, so no option tab is active and the leftmost tab — their own draft —
  // takes it. Storing a `selected` column would leave a tab claiming credit for
  // a paragraph the reviewer wrote themselves.
  const selected = alternatives.find(option => option.body.trim() === body.trim());

  const history = listEvents(task.id);
  const names = new Map<string, string>();
  for (const event of history) {
    if (event.actor && !names.has(event.actor)) {
      names.set(event.actor, getOperator(event.actor)?.name ?? event.actor);
    }
  }
  const who = (actor: string) => names.get(actor) ?? actor;

  return (
    <>
      {/* The last look before it goes.

          Rendered from the row rather than from the boxes below it, and that is
          the whole point: `confirmSend` writes the edits first, so what this
          panel shows is what `approveAndSend` will read a moment later. A
          confirmation that read from the textarea could show one paragraph and
          post another, which is worse than no confirmation.

          Nothing on it is editable, and that now includes the files. The picker
          lived here for as long as this was the only form that could carry them
          — a browser will not let a page fill a file input, so bytes picked
          anywhere else died on the redirect. They survive it now, in a table
          that the send empties, which lets attaching happen where answering
          happens and leaves this panel doing only what it is for. */}
      {confirming && (
        <div className="confirm-scrim">
          {/* Named as a dialog because it is one to anybody who cannot see the
              scrim, and Escape closes it the way the shape promises. */}
          {/* `banded`: this is the one panel built out of full-width sections
              that each carry their own padding — the risk band, the two halves,
              the actions — so it is the one that gives up the card's. Its three
              siblings are a heading and a paragraph in a plain card and keep
              it. See `.confirm.card.banded`. */}
          <form
            className="confirm card banded"
            action={approveAndSend}
            role="dialog"
            aria-labelledby="confirm-title"
          >
            <DismissOnEscape href={`/tasks/${task.id}`} />
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="subject" value={task.replySubject ?? ''} />
            <input type="hidden" name="draft" value={body} />
            {/* The panel is a second request and the switcher is behind the
                scrim, so the format has to travel with the send or the reply
                would go out rendered as something the reviewer did not pick. */}
            <input type="hidden" name="format" value={task.replyFormat} />

            <div className="confirm-head">
              <h2 id="confirm-title">{t('task.confirm.title')}</h2>
              <span className="meta">{t('task.confirm.escapeHint')}</span>
              <p className="meta confirm-to">
                {t('task.confirm.to', {
                  who: task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress,
                })}
                {` · ${task.replySubject?.trim() || t('task.confirm.subjectDefault')}`}
              </p>
            </div>

            {/* Said once on the review screen already. Repeated here because
                "needs care" and pressing Send can be ten minutes and three
                rewrites apart, and the last look has to contain it. */}
            {task.risk && task.risk.level !== 'low' && (
              <div className={`risk-banner${task.risk.level === 'normal' ? ' normal' : ''}`}>
                <span className="verdict">{t(`task.risk.${task.risk.level}`)}</span>
                {task.risk.factors.length > 0 && (
                  <span className="why">
                    {task.risk.factors.map(f => t(`task.riskFactor.${f}`)).join(' · ')}
                  </span>
                )}
              </div>
            )}

            {/* Their letter and the reply beside it, rather than one above the
                other. Holding both in view at once is the entire job of this
                screen — stacked, the eye leaves one to check the other and loses
                the paragraph it was on, and these two are not two versions of
                one passage but the question and the answer. A translation, where
                there is one, sits under its own original inside the same half. */}
            <div className="confirm-pair">
              <div className="confirm-half">
                <h3 className="confirm-heading">{t('task.confirm.theyWrote')}</h3>
                <EmailBody text={task.body || t('task.emptyBody')} language={task.analysis?.language} />
                {incoming && (
                  <div className="translation">
                    <p className="meta">
                      {t('task.translation')} · {incoming.language}
                    </p>
                    <EmailBody text={incoming.content} />
                  </div>
                )}
              </div>

              <div className="confirm-half outgoing">
                {/* "What they will receive", not "preview". A preview is a
                    picture of the thing; this is `previewHtml`, which is the
                    same function `sendReply` calls. */}
                <h3 className="confirm-heading">{t('task.confirm.theyWillGet')}</h3>
                <RenderedReply text={body} format={task.replyFormat} />
                {outgoing && (
                  <div className="translation">
                    <p className="meta">
                      {t('task.translation')} · {outgoing.language}
                    </p>
                    <EmailBody text={outgoing.content} />
                  </div>
                )}
              </div>
            </div>

            {/* There was a line here explaining that the right-hand column is
                built by the same function that posts the mail. True, and the
                reason the column is worth showing — but it is a claim about our
                implementation, printed under the mail, on the screen where
                somebody is deciding whether to send it. Nobody re-reads it, and
                a panel that argues for its own trustworthiness every time is
                asking a question the reviewer had not raised. The heading says
                what the column is; the note belongs where the decision was made,
                which is `previewHtml`. */}

            {/* Said out loud rather than left as a blank column. A reviewer who
                cannot read the reply needs to know that this screen is not
                showing it to them, not to assume the panel is still loading. */}
            {language && !outgoing && (
              <p className="meta confirm-notes">{t('task.noTranslation', { language })}</p>
            )}

            {/* Carried, not asked for.

                This was a textarea, and a textarea is the one thing this screen
                must not have. Everything else here is deliberately read-only —
                the panel exists to ask one question with a yes and a no — and a
                box in the middle of it invites a last-second edit at exactly the
                moment nothing should be changing, on the one screen where the
                text on display has to be the text that goes out. The note is
                written next to the draft now, where editing belongs, and rides
                through hidden so the rule extractor still receives it. */}
            <input type="hidden" name="notes" value={task.reviewerNotes ?? ''} />
            {task.reviewerNotes && (
              <p className="meta confirm-notes">
                <strong>{t('task.notesLabel')}</strong> · {task.reviewerNotes}
              </p>
            )}

            {/* The way out of the learning loop, and the only place it is
                offered. While the draft is being edited the reviewer is thinking
                about what to say; the second before Send is the only moment
                anybody thinks "this one is a special case". A checkbox rather
                than a link, because this form posts and a link would leave the
                page and lose the answer.

                Only where there is something to learn from: an unedited draft
                teaches nothing anyway, and an opt-out from nothing is a control
                that does nothing. */}
            {edit.meaningful && (
              <div className="confirm-learns">
                <p className="head">
                  <span className="kicker">{t('task.confirm.willLearn')}</span>
                  <span className="meta">
                    {t('task.learns.scale', { added: edit.added, removed: edit.removed })}
                  </span>
                </p>
                <p className="meta">{t('task.learns.willLearn')}</p>
                <label className="skip">
                  <input type="checkbox" name="skipLearning" value="1" />
                  {t('task.confirm.skipLearning')}
                </label>
              </div>
            )}

            {/* What is riding along, said and not asked.

                The picker used to be here, because files are the one thing a
                round trip cannot carry and this was the form that posted the
                mail. It is on the review screen now, where the reply is actually
                written — attaching an invoice is part of answering, not part of
                confirming — and this panel does what it does with every other
                field: reports it. See `outgoing.ts` for where the bytes wait.

                Read from the row, like everything else here, so the list cannot
                disagree with what `approveAndSend` is about to read. */}
            {carrying.length > 0 && (
              <p className="meta confirm-carrying">
                <strong>{t('task.attachGoing')}</strong> ·{' '}
                {carrying.map(file => `${file.filename} (${sizeKb(file.size)})`).join(', ')}
              </p>
            )}

            <div className="confirm-actions">
              <button className="primary" type="submit">
                {t('task.confirm.send')}
              </button>
              {/* A link, not a button: going back must not post anything, and
                  the row already holds every edit that got us here. */}
              <Link className="button-link" href={`/tasks/${task.id}`}>
                {t('task.confirm.back')}
              </Link>
              {/* "Sent is the one door that does not open again" used to sit at
                  the end of this row. The panel is already the pause it was
                  arguing for — a whole screen that exists to be read before the
                  button is pressed — so the sentence was telling somebody who
                  had stopped to look that they ought to stop and look. Warnings
                  that restate what the interface is already doing are the ones
                  people learn to read past, and this row is two buttons and a
                  decision. */}
            </div>
          </form>
        </div>
      )}

      {/* The model is writing, and the reviewer is watching it happen.

          Redraft used to close the panel and drop the reviewer back on the task
          with the old draft still in the box and a line saying the work was
          queued — which on an install without the crontab set up was a promise
          nothing would keep. The work is kicked off directly now (see
          `redraftTask`), and this is the other half: stay on the step, say what
          is happening, and let the poller end it. */}
      {working && (
        <div className="confirm-scrim">
          <div
            className="confirm card stack working"
            role="dialog"
            aria-labelledby="working-title"
            aria-busy="true"
          >
            <DismissOnEscape href={`/tasks/${task.id}`} />
            <TaskPoller />
            <h2 id="working-title">
              {/* No spinner once the attempt has already failed. Something
                  turning says "nearly there", and on a desk with no model
                  configured it would say that forever. */}
              {!task.error && <span className="spinner" aria-hidden="true" />}
              {task.error ? t('task.working.stuckTitle') : t('task.working.title')}
            </h2>
            {/* Polite rather than assertive: this updates itself every couple of
                seconds, and an assertive region would interrupt a screen reader
                on every one of them. */}
            <p className="meta" aria-live="polite">
              {task.error ? t('task.working.stuckBody') : t('task.working.body')}
            </p>
            {/* The real reason, said here rather than left behind the panel.
                A drafting job retries with a backoff, so the task sits at
                `pending` between attempts and the wait looks identical to one
                that is going to succeed — which is how "AI_MODEL is required"
                turned into an endless spinner instead of an answer. */}
            {task.error && <p className="error">{task.error}</p>}
            <div className="actions">
              {/* Leaving does not cancel anything — the job is already running,
                  and the draft will be here whether or not this stays open. */}
              <Link className="button-link" href={`/tasks/${task.id}`}>
                {t('task.working.leave')}
              </Link>
              {/* Where a wait that is not going to end explains itself. A desk
                  with no model configured queues this job and fails it on the
                  first attempt, and the queue screen is where that says so.

                  Offered to the people who can open it. A reviewer is not left
                  with nothing — `task.error` above is the same sentence the
                  queue screen would have shown them, printed right here. */}
              {admin && (
                <Link className="button-link" href="/queue">
                  {t('nav.queue')}
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Redraft, asking what for.

          Same shape as the confirmation above and for the same reason: the
          instruction is the whole of the feature, and a box that is only open
          when somebody has actually asked to redraft is a box they read. */}
      {redrafting && (
        <div className="confirm-scrim">
          <form
            className="confirm card stack"
            action={redraftTask}
            role="dialog"
            aria-labelledby="redraft-title"
          >
            <DismissOnEscape href={`/tasks/${task.id}`} />
            <input type="hidden" name="taskId" value={task.id} />
            {/* The draft and subject travel with it so `keepEdits` has the same
                text to protect that it did a moment ago — the panel is a second
                request, and the boxes it came from are behind the scrim. */}
            <input type="hidden" name="draft" value={body} />
            <input type="hidden" name="subject" value={task.replySubject ?? ''} />

            <h2 id="redraft-title">{t('task.redraftAsk.title')}</h2>
            <p className="meta">{t('task.redraftAsk.intro')}</p>
            <textarea
              name="notes"
              rows={4}
              autoFocus
              aria-label={t('task.notesLabel')}
              defaultValue={task.reviewerNotes ?? ''}
              placeholder={t('task.redraftAsk.placeholder')}
            />
            <div className="actions">
              <button className="primary" type="submit">
                {t('task.redraftAsk.go')}
              </button>
              <Link className="button-link" href={`/tasks/${task.id}`}>
                {t('task.confirm.back')}
              </Link>
            </div>
          </form>
        </div>
      )}

      {/* Dismissing, asking why.

          Optional, and it says so: somebody clearing a pitch that needed no
          answer has nothing to explain. But a rejection with a reason is the
          only kind the learning job can read, and asking afterwards never
          works — so the question is put at the moment of the decision. */}
      {dismissing && (
        <div className="confirm-scrim">
          <form className="confirm card stack" action={dismissTask} role="dialog" aria-labelledby="dismiss-title">
            <DismissOnEscape href={`/tasks/${task.id}`} />
            {/* The draft and the subject deliberately do not travel with this
                one, unlike the redraft panel. `askDismiss` has already written
                them through `keepEdits` on the way here, and `dismissTask` never
                reads them — carrying them anyway would be two hidden fields
                posting values nothing consumes, which is exactly the silent
                no-op `actions.fields.test.ts` exists to catch. It caught it. */}
            <input type="hidden" name="taskId" value={task.id} />

            <h2 id="dismiss-title">{t('task.dismissAsk.title')}</h2>
            <p className="meta">{t('task.dismissAsk.intro')}</p>
            <textarea
              name="reason"
              rows={4}
              autoFocus
              aria-label={t('task.reasonLabel')}
              defaultValue={task.rejectionReason ?? ''}
              placeholder={t('task.reasonPlaceholder')}
            />
            <div className="actions">
              <button className="danger" type="submit">
                {t('task.dismissAsk.go')}
              </button>
              <Link className="button-link" href={`/tasks/${task.id}`}>
                {t('task.confirm.back')}
              </Link>
            </div>
          </form>
        </div>
      )}

      {/* One DOM, two readings. Side by side is the same markup with the main
          column widened and the aside dropped underneath it — there is no second
          review screen, and so no second review screen to keep in step with this
          one. See `.detail-compare` in globals.css.

          `detail-railed` is what tells the grid how many children it has. The
          three-column track list is only right when the rail is actually one of
          them, and the rail is absent whenever the queue is empty — on a desk
          that has caught up, or on any sent task once it has. Without the class
          the letter and the draft were laid into the 236px track meant for the
          queue while the 288px one stood empty, which is a broken screen in
          exactly the state that should look calmest. */}
      <div
        className={`detail${layout === 'compare' ? ' detail-compare' : ''}${
          railed ? ' detail-railed' : ''
        }`}
      >
        {/* The grid's first column, and the reason columns mode is three of
            them. Not in side by side: that main column is already two columns of
            its own, and a rail beside it makes three — the thing side by side is
            for getting away from. */}
        {railed && <QueueRail currentId={task.id} rows={rail} />}
        <div className="detail-main">

        {/* Everything this screen has to say about its own state, in the column
            it is about.

            These used to sit above the three columns, in a strip of their own
            between the header and the work — which put "Saved." level with the
            queue rail and the model's reading, neither of which it concerns.
            Anything that is about this task belongs in the column holding the
            task. */}
        {typeof query.error === 'string' && <p className="banner">{query.error}</p>}
        {/* Otherwise this screen is a dead end: no Send button, no editable
            draft, and nothing saying why either is missing. What it says is the
            honest answer — including that the sweep will hand it back if the
            send never finished, so waiting is a real option. */}
        {sending && <p className="banner">{t('task.sendingBanner')}</p>}

        {/* The loudest thing on the page when it applies. A reviewer who opens a
            superseded task from a bookmark or the sent list is about to spend
            time on a draft nobody should send. */}
        {task.supersededBy && (
          <p className="banner">
            {t('task.superseded')} <Link href={`/tasks/${task.supersededBy}`}>{t('task.supersededOpen')}</Link>
          </p>
        )}

        {/* Why the last person to look at this refused to send it. Shown to
            whoever opens it next — usually somebody deciding whether to reopen,
            and the reason is the whole of what they need to decide with. */}
        {task.rejectionReason && task.status === 'dismissed' && (
          <p className="banner">
            {t('task.rejectedBecause', { reason: task.rejectionReason })}
          </p>
        )}

        {/* The grade and the reasons for it, in one band across the top of the
            letter — this column's width, not the page's.

            `task.risk.factors` was always in the data and was always rendered as
            a line of grey `.meta` under the subject — the same weight as "5
            rules active" — while the grade itself was a pill the size of every
            other pill beside it. A verdict nobody can argue with is a verdict
            reviewers learn to skip, so the reasons sit next to it, on its own
            ground, at the top of the thing being judged.

            `low` draws nothing. The grade that has nothing to say should say
            nothing. */}
        {task.risk && task.risk.level !== 'low' && (
          <div className={`risk-banner${task.risk.level === 'normal' ? ' normal' : ''}`}>
            <span className="verdict">{t(`task.risk.${task.risk.level}`)}</span>
            {task.risk.factors.length > 0 && (
              <span className="why">
                {task.risk.factors.map(f => t(`task.riskFactor.${f}`)).join(' · ')}
              </span>
            )}
          </div>
        )}

        {/* The keyboard. Renders nothing; see review-keys.tsx for why every one
            of these presses a control that is already on the page. */}
        <ReviewKeys next={neighbours.next} previous={neighbours.previous} />

        {/* Watching a job somebody else started.

            Renders nothing either. It ends by itself: the refresh that finds the
            task off `pending` renders a screen where `inFlight` is false, and
            this stops being mounted — the same way the redraft panel closes.

            Not while that panel is up, which mounts its own on a shorter tick.
            Two of these would be two intervals refreshing one page.

            Five seconds rather than the panel's two, because the two waits are
            not the same length. Behind the panel a worker has already been
            kicked and the answer is tens of seconds away; here the task is
            waiting for the next turn of a queue that runs every couple of
            minutes, and a screen that asks a hundred times in that window is
            asking ninety-nine times for nothing. Both are one read of a local
            file, so neither is expensive — this one is just honest about what it
            is waiting for. */}
        {inFlight && !working && <TaskPoller intervalMs={5000} />}

        {/* The subject, at the size of the thing it names.

            It was a 15px line inside a card, which on the one screen whose whole
            subject *is* the subject made the page look like it began at "THE
            REPLY". Out of the card and up to heading size: a reviewer arriving
            from the rail should be able to tell in one glance which of the
            twelve they landed on.

            Above the pair rather than inside its left half. Side by side is a
            promise that the question and the answer start level, and a title
            living in one of the two columns pushes that column down by its own
            height — which is the one thing this reading exists to prevent. */}
        <header className="task-head">
          <div className="row">
            <h1 className="subject grow">{task.subject || t('task.noSubject')}</h1>
            <span className={`tag ${task.status}`}>{t(`task.status.${task.status}`)}</span>
          </div>
          <p className="meta">
            {/* On a composed mail this address is the recipient, not a sender.
                The label above the body says which, because a brief presented as
                "the customer's email" is a lie on the one screen that has to be
                trusted. */}
            {task.origin === 'composed' ? `${t('compose.to')}: ` : ''}
            {task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
            {/* `deskedAt`, not `receivedAt`. A composed mail was never received,
                so that column is null and this heading used to end at the
                address — an address, a gap, and nothing to say when the letter
                is from. See the note on the helper. */}
            {` · ${deskedAt(task).slice(0, 16).replace('T', ' ')}`}
            {' · '}
            {/* Said as the question it answers rather than left as a bare
                address. "Have we talked to this person before, and what did we
                say" is a question the context card answers in one sentence and a
                reviewer sometimes needs the whole of. */}
            <Link href={`/senders/${encodeURIComponent(task.fromAddress)}`}>
              {t('task.allWithThisAddress')}
            </Link>
          </p>
        </header>

        {/* What they wrote, and what is going back — the two things side by side
            puts side by side.

            The wrappers are here in both readings and do nothing in the first
            one: `.review-pair` and its two halves are `display: contents` until
            `.detail-compare` turns them into a grid, so columns mode is the same
            stack of cards it always was. That is what keeps this one screen
            rather than two. */}
        <div className="review-pair">
        <div className="letter-side">

        {/* Above the message being answered, in the order it happened. A
            reviewer judging "is this reply right?" on a follow-up cannot answer
            it from the last message alone, and the reply they are approving was
            written with all of this in front of it. Collapsed, because on a
            first contact — most tasks — there is nothing here at all. */}
        {thread.length > 0 && (
          <details className="card">
            <summary>{t('task.conversation', { n: thread.length })}</summary>
            {thread.map(m => (
              <div key={m.id} style={{ marginTop: 12 }}>
                <div className="meta">
                  {m.direction === 'outbound' ? t('task.threadUs') : t('task.threadCustomer')}
                  {m.fromAddress ? ` · ${m.fromAddress}` : ''}
                  {` · ${m.receivedAt.slice(0, 16).replace('T', ' ')}`}
                </div>
                {/* The whole thread is in the customer's language, both directions: a
                    reply is written in the language the letter arrived in, which
                    is why there is a translation of the draft at all. */}
                <EmailBody text={m.body || t('task.emptyBody')} language={task.analysis?.language} />
              </div>
            ))}
          </details>
        )}


        <div className="card letter">
          {/* Named, because the card below it is also a piece of prose about the
              same subject and the two must never be confused. This one is
              theirs. */}
          <div className="row card-head">
            <span className="card-label grow">
              {task.origin === 'composed' ? t('task.brief') : t('task.theirLetter')}
            </span>
            {/* Named at the top of the letter rather than only inside it, and in
                the accent because it is the one thing on this card a reviewer
                looks *for*. The pane itself is below, beside the original. */}
            {incoming && (
              <span className="translation-label">{t('task.translation')}</span>
            )}
          </div>
          {task.error && <p className="error">{task.error}</p>}
          {/* Original on the left, translation on the right — see `.compare`
              in globals.css for why. The `details` is still `open` by default,
              so a reviewer who wants their old stacked view can just close it. */}
          <div className={`compare${incoming ? '' : ' compare-single'}`}>
            <EmailBody text={task.body || t('task.emptyBody')} language={task.analysis?.language} />
            {incoming && (
              <details className="translation" open>
                <summary>
                  {t('task.translation')} · {incoming.language}
                </summary>
                <EmailBody text={incoming.content} />
              </details>
            )}
          </div>
          {/* What came with their email, as the same tiles the reply uses.

              This was two blocks that did not know about each other: pictures
              rendered up to 320px tall, and every other file a comma-separated
              line of links below them — so a mail with a screenshot and a log
              was a wall of image and then a sentence, and the two halves of one
              question ("what did they send?") were answered in two typefaces.
              One row of thumbnails, and pressing one opens it full size.

              Inline images are in it now, which the file list used to exclude on
              the grounds that a signature logo is not a file anyone sent. True,
              and it was worth acting on when the alternative was a logo rendered
              three hundred pixels tall. At 56 pixels a stray logo costs a tile;
              a hidden screenshot costs the reviewer the email. */}
          {attachments.length > 0 && (
            <div className="file-tiles">
              {attachments.map(file => (
                <FileTile
                  key={file.id}
                  href={`/api/attachments/${task.id}/${file.id}`}
                  filename={file.filename}
                  size={file.size}
                  contentType={file.contentType}
                />
              ))}
            </div>
          )}
        </div>

        {/* Shown above the draft, not beside it: this is what the model was
            told, and a reviewer deciding whether a reply is right needs to know
            what it was working from before they read it. */}
        {context.map((block) => (
          <div className="card" key={block.sourceId}>
            <div className="row">
              <h2 className="grow" style={{ margin: 0 }}>
                {block.title}
              </h2>
              {block.href && (
                <a className="meta" href={block.href} target="_blank" rel="noreferrer">
                  {t('task.openContext')}
                </a>
              )}
            </div>
            <dl className="facts">
              {block.fields.map((field, i) => (
                <div key={i}>
                  <dt>{field.label}</dt>
                  <dd>
                    {field.href ? (
                      <a href={field.href} target="_blank" rel="noreferrer">
                        {field.value}
                      </a>
                    ) : (
                      field.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {block.prompt && <p className="meta">{block.prompt}</p>}
          </div>
        ))}

        </div>
        <div className="reply-side">

        {/* `confirmSend`, not `approveAndSend`: this form's own action is what
            the primary button and the return key both reach, and neither should
            put mail on the wire without the panel above being seen first. The
            send itself is posted from that panel. */}
        <form className="stack review-form" action={confirmSend}>
          <input type="hidden" name="taskId" value={task.id} />
          {/* How the box below becomes mail.

              Submit buttons rather than radios, and bound rather than valued —
              see `setReplyFormat`. Switching applies at once, because the format
              decides what the text means and a preview of the wrong one is worse
              than none. Hidden field alongside them so Save and Send carry the
              current choice too: the buttons change it, everything else has to
              preserve it. */}
          <input type="hidden" name="format" value={task.replyFormat} />

          {/* The other ways this could have been answered.

              Above the box rather than in a fold below it, and always there
              rather than behind a button, because the choice between approaches
              is one to make *before* reading a draft closely — not after
              deciding the one on screen is wrong. Tab A is the draft itself, so
              one of them is always lit on arrival.

              A row rather than a stack: three approaches are three headlines to
              be compared at a glance, and a column of them reads as a list of
              things to work through.

              Submit buttons inside the draft's own form rather than a form
              each: nesting forms is not a thing HTML does, and posting the
              textarea along with the switch is the point rather than a side
              effect — switching keeps whatever is in the box first, so a
              reviewer who edits B, reads C and comes back finds their editing
              in the drafts panel rather than gone. The id is bound to the
              action instead of carried as the button's value; see the note on
              `useAlternative` for why the obvious HTML silently does nothing. */}
          {/* Wrapped, and the wrapper is what side by side places.

              In that reading the letter and the reply have to start level, so
              the grid pins both cards to one row and everything that comes
              before the reply to the row above it. That row needs to be one
              element, or "which row is the reply card on" depends on whether
              this task happened to get alternatives. */}
          <div className="reply-lead">
          {alternatives.length > 0 && (
            <div className="alt-strip">
              <span className="meta">{t('task.optionsLabel')}</span>
              <div className="alt-tabs" role="group" aria-label={t('task.optionsLabel')}>
                {alternatives.map(option => (
                  <button
                    key={option.id}
                    type="submit"
                    formAction={useAlternative.bind(null, option.id)}
                    className={selected?.id === option.id ? 'active' : ''}
                    aria-current={selected?.id === option.id ? 'true' : undefined}
                  >
                    <span className="alt-label">{option.label}</span>
                    <span className="alt-strategy">
                      {option.strategy || t('task.optionUnlabelled')}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* No tab is lit, which now means one thing only: the reviewer has
              edited. Tab A is the draft as generated, so on arrival A matches
              and this line is absent. Worth saying out loud when it applies — a
              strip with none of its tabs active otherwise reads as a rendering
              fault rather than as an answer to "where am I". */}
          {alternatives.length > 0 && !selected && (
            <p className="meta">{t('task.optionsEdited')}</p>
          )}
          </div>

          <div className="card reply-card">
          {/* Whose words these are, and how they will be rendered — the two
              things a reviewer needs to know before reading a single line of the
              box below. The format lives up here rather than on a row of its own
              because it is a property of this reply, not a step in writing it. */}
          <div className="row card-head">
            <span className="card-label grow accent">
              {sent ? t('task.whatWentOut') : t('task.theReply')}
            </span>
            {/* How this becomes mail, and what it will be called — two facts
                stated in one quiet line rather than two rows of controls.

                The row of format tabs and the subject box were both permanently
                open above the draft, which put two things nobody changes on most
                tasks between the reviewer and the only thing they came here to
                read. Folded into a disclosure they are still one click away, and
                the line that opens it already answers the question the controls
                were being kept open to answer. */}
            {!sent && !sending && (
              <details className="reply-settings">
                {/* A control that looks like one, and names what is inside it
                    rather than reporting it.

                    This was bare grey text with the disclosure marker hidden,
                    which left it reading as a caption — and a caption is a thing
                    you read, not a thing you press. It is a pill with a caret
                    now, the same pair the language menu in the header wears,
                    because pressing it does the same thing.

                    And it is one word. It spelled out the subject line first,
                    which is the value of a setting quoted on the button that
                    opens the setting — the box below says it, in the box you
                    would change it in, and the confirmation says it again before
                    anything is sent. Replacing the value with the word "subject"
                    was no better: a label with nothing after it names a control
                    that is already named by the panel it opens, and the caret had
                    said "there is more in here" without any help.

                    What is left is the format, which earns its place — it decides
                    what the characters in the box *mean*, and it is the one thing
                    up here that can be wrong in a way you would want to catch
                    before reading a single line. The rest is behind the caret,
                    and `aria-label` says so for anybody who cannot see it. */}
                <summary aria-label={t('task.replySettings')}>
                  {t(`task.format.${task.replyFormat}`)}
                  <span className="caret" aria-hidden="true">
                    ▾
                  </span>
                </summary>
                <div className="reply-settings-body">
                  <div className="format-tabs" role="group" aria-label={t('task.format.label')}>
                    <span className="meta">{t('task.format.label')}</span>
                    {REPLY_FORMATS.map(option => (
                      <button
                        key={option}
                        type="submit"
                        formAction={setReplyFormat.bind(null, option)}
                        className={task.replyFormat === option ? 'active' : ''}
                        aria-current={task.replyFormat === option ? 'true' : undefined}
                        title={t(`task.format.hint.${option}`)}
                      >
                        {t(`task.format.${option}`)}
                      </button>
                    ))}
                  </div>
                  {/* A textarea, not a text input, for the reason the reason box
                      below is one: the first submit button in this form is Send,
                      and a single-line input turns Enter into "send this email".
                      Empty means the customer's own subject, prefixed with Re: —
                      which is what every task had before there was a box at
                      all. */}
                  <textarea
                    className="subject-line"
                    name="subject"
                    rows={1}
                    aria-label={t('task.subjectLabel')}
                    defaultValue={task.replySubject ?? ''}
                    placeholder={t('task.subjectPlaceholder')}
                  />
                </div>
              </details>
            )}
            {/* Sent, so there is nothing to change — and here the subject line
                itself is worth spelling out, which is why this says more than
                the trigger above it does. That one is a button, and a button
                quoting the value of the setting it opens is quoting something
                you are one press from seeing. This is not a button: the mail has
                gone, "what did it go out as" is the question this whole card
                answers, and there is no longer anywhere else to read it. */}
            {(sent || sending) && (
              <span className="meta">
                {t(`task.format.${task.replyFormat}`)}
                {' · '}
                {task.replySubject?.trim()
                  ? t('task.replyMeta.subject', { subject: task.replySubject.trim() })
                  : t('task.replyMeta.subjectTheirs')}
                <input type="hidden" name="subject" value={task.replySubject ?? ''} />
              </span>
            )}
          </div>
          {/* The reply, and beside it a translation if the reviewer needs one.

              There used to be a third thing in this slot: the rendered reply,
              paired with the box for every format but plain text. It went,
              because on the format that is nearly always in use the pair was the
              same paragraph twice — the same words, one column apart, differing
              in two asterisks. A second pane that says almost exactly what the
              first one says is not a second opinion; it is half the width of the
              editor spent on nothing, and it made the box people actually type in
              the smaller half of the screen.

              What is going out is worth showing once, at the moment it matters,
              and the confirmation panel is that moment: it renders from the row
              rather than from the textarea, so it is the one preview that cannot
              be a version of the reply nobody saved. See the note there.

              A translation is not the same case. That is a different language,
              which is a thing the reviewer genuinely cannot read off the box. */}
          <div className={`compare${outgoing ? '' : ' compare-single'}`}>
            {/* Named, not just prompted. A placeholder is the only label these
                three had, which leaves a screen reader announcing "edit text"
                and leaves everybody else with no label at all the moment they
                start typing — the point at which knowing which box this is
                matters. */}
            {/* The reply, with the reviewer's own sentences marked in it.

                A textarea cannot colour half its own contents, so the marks are
                a second copy of the same text rendered underneath it, and the
                box on top is made transparent — see `DraftOverlay`, which turns
                this on only once its script has actually run. Without it the
                textarea is the plain box it has always been, which is the whole
                point: the highlight is worth having and worth nothing at the
                cost of an unusable editor.

                `aria-hidden`, because the text under the box is the same text
                that is in it, and a screen reader should meet it once. */}
            <div className="draft-box">
              <div className="draft-mirror" aria-hidden="true">
                {marked.map((run, i) =>
                  run.added ? <mark key={i}>{run.text}</mark> : <span key={i}>{run.text}</span>,
                )}
              </div>
              {/* Opened at the length of the reply rather than at a height
                  somebody picked once. `rows` is the estimate every browser
                  understands; `--reply-rows` is the same number in a form the
                  stylesheet can cap a quoted thread with. See reply-box.ts. */}
              <textarea
                className="draft"
                name="draft"
                aria-label={t('task.draftLabel')}
                defaultValue={body}
                readOnly={sent || sending}
                placeholder={t('task.draftPlaceholder')}
                rows={box.rows}
                data-quoted={box.quoted ? '' : undefined}
                style={{ '--reply-rows': box.rows } as React.CSSProperties}
              />
              <DraftOverlay highlighted={edit.meaningful} />
            </div>
            {/* The nearest thing here to a confirmation step: what is going out,
                in a language the reviewer reads. */}
            {outgoing && (
              <details className="translation" open>
                <summary>
                  {sent ? t('task.whatWentOut') : t('task.whatYouAreAboutToSend')} · {outgoing.language}
                </summary>
                <EmailBody text={outgoing.content} />
              </details>
            )}
          </div>
          {language && !outgoing && body.trim() !== '' && (
            <p className="meta">{t('task.noTranslation', { language })}</p>
          )}
          {/* Shown, not asked for — the same decision the confirmation panel
              made about the same sentence, for a reason that turns out to hold
              here too.

              This was a labelled one-line textarea, and the label was the tell:
              a box needs naming because a box is a question, and the question
              had already been asked. The note is written in the redraft panel,
              at the moment somebody asks for a redraft, which is the only moment
              it does anything — it steers that redraft and it feeds the rule
              extractor. A second copy of it standing open under the draft asks
              again for an answer already given, in the card whose whole point is
              the reply, where every other box is part of the mail.

              A line of text instead, and because it is text it can stay after
              the mail has gone: "what was said about this draft" is still a
              question on a sent task, and there was nowhere to read it. */}
          {task.reviewerNotes && (
            <p className="meta notes-said">
              <strong>{t('task.notesLabel')}</strong> · {task.reviewerNotes}
            </p>
          )}

          {/* Files, put on the reply where the reply is written.

              This was on the confirmation panel, which is the last screen before
              the mail leaves and the wrong place to remember the invoice: by
              then the reviewer is answering "is this right?", and the answer to
              that question should not depend on a control they have to notice.
              Attaching is part of writing the answer, so it sits under the
              answer — in the same card, in the same form, so the draft rides
              along with it.

              A button rather than a picker that submits itself, because a picker
              that submits itself needs script and this screen deliberately has
              none. Send carries them too — see `keepFiles` — so a reviewer who
              picks a file and goes straight for Send does not lose it.

              Only while there is still a reply to put them on. Once the mail has
              gone the rows are deleted with it, and what was attached is in the
              history line the send wrote.

              The same tiles the letter above uses, in the same row as the
              control that adds one — so "what is going out with this" and "put
              something else on it" are one strip and not two. The picker itself
              is folded into the last tile, because most replies carry nothing
              and a file input with a fifteen-megabyte notice standing open under
              every draft is chrome the great majority of tasks pay for and never
              use. What is never folded is the answer: a tile per file, always
              visible, because a fold may hide a control and may not hide a fact
              about the mail. */}
          {!sent && !sending && (
            <div className="file-tiles attach">
              {carrying.map(file => (
                <FileTile
                  key={file.id}
                  href={`/api/outgoing/${task.id}/${file.id}`}
                  filename={file.filename}
                  size={file.size}
                  contentType={file.contentType}
                  remove={
                    /* The id is bound to the action rather than carried as this
                       button's value; React overwrites `name` on a submit that
                       has a `formAction`. See the note on `useAlternative`. */
                    <button
                      type="submit"
                      className="drop"
                      formAction={detachFile.bind(null, file.id)}
                      title={t('task.attachRemove', { name: file.filename })}
                      aria-label={t('task.attachRemove', { name: file.filename })}
                    >
                      ×
                    </button>
                  }
                />
              ))}

              {/* The tile that adds tiles. It stands in the row it adds to, at
                  the size of the things it makes, which is the shortest way to
                  say what pressing it does — and it costs the card one empty
                  square rather than a strip.

                  Choosing is the whole of it: see `AttachTile`, where the
                  picker submits itself and the button under it is what a browser
                  with no script still gets. `multiple`, and the action stores
                  them as a batch — several at once is one press, and picking
                  again adds to the row rather than replacing it. Only a file of
                  the same name replaces, which is the corrected copy of
                  something already on the reply. */}
              <AttachTile
                attach={attachFiles}
                label={t('task.attach')}
                note={t('task.attachNote')}
                addLabel={t('task.attachAdd')}
                /* Handed down rather than imported over there: `uploads.ts` is
                   a server module — it reads the request and reaches for
                   `Buffer` — and one constant is not worth dragging it into the
                   browser's bundle. The number is the same number either way. */
                limit={MAX_UPLOAD_BYTES}
                tooBig={t('task.attachTooBig')}
              />
            </div>
          )}
          </div>

          {/* The four buttons, held at the bottom of the column.

              Sticky rather than scrolled past. A long thread with three context
              cards puts Send below the fold on arrival, and the one action this
              screen exists for should never be something you have to go looking
              for. The keys are printed on them because a shortcut nobody is told
              about is a shortcut nobody uses — and each one presses the button it
              is printed on, so the hint is also the whole of the implementation
              contract. See review-keys.tsx. */}
          {!sent && !sending && (
            <div className="actions review-actions">
              {sendable && (
                <button className="primary" type="submit">
                  {t('task.approveAndSend')} <kbd>⌘↵</kbd>
                </button>
              )}
              <button type="submit" data-key="save" formAction={saveDraft}>
                {t('task.save')} <kbd>S</kbd>
              </button>
              <button type="submit" data-key="redraft" formAction={askRedraft}>
                {t('task.redraft')} <kbd>R</kbd>
              </button>
              {/* Only where there is something to come back from. A task that is
                  already awaiting review has nowhere to be reopened to. */}
              {(task.status === 'dismissed' || task.status === 'failed') && (
                <button type="submit" formAction={reopenTask}>
                  {t('task.reopen')}
                </button>
              )}
              {/* The reason used to be a bare textarea standing between Redraft
                  and Dismiss, labelled only by a placeholder that vanished on the
                  first keystroke — a box in a row of buttons that nobody could
                  identify, and which read as a second notes field next to the
                  real one above. It is asked in a panel now, the way Redraft
                  asks what to change: same shape, and the question arrives
                  attached to the button that raises it. */}
              {/* Not on a task that is already dismissed. The panel that asks
                  why refuses to render for one — see `dismissing` — so the
                  button posted, redirected, and came back with nothing: no
                  panel, no message, a control that visibly did nothing. Reopen
                  is the button that belongs there, and it is already beside
                  this one. */}
              {task.status !== 'dismissed' && (
                <button className="danger" type="submit" data-key="dismiss" formAction={askDismiss}>
                  {t('task.dismiss')} <kbd>X</kbd>
                </button>
              )}
              {/* Said where it happened. "Saved." at the top of the page is a
                  sentence about a button four hundred pixels below it; here it
                  is the button's own answer. */}
              {typeof query.saved === 'string' && (
                <span className="meta said">{t('task.saved')}</span>
              )}
              {/* The one path that sets this is a compose, and it used to say
                  "Redraft queued. Run the queue to pick it up." — which was
                  wrong three times over on a letter nobody had drafted yet, and
                  told the writer to go and press a button that is no longer on
                  the inbox. The queue is turned by the action itself now, so
                  what is left to say is that it is happening and that the screen
                  will fill itself. */}
              {typeof query.queued === 'string' && (
                <span className="meta said">{t('task.composeQueued')}</span>
              )}
              {/* Only when there is one. On the last task in the queue this says
                  nothing rather than promising a key that does nothing. */}
              {neighbours.next && (
                <span className="meta next-hint">
                  {t('task.nextAfterThis')} <kbd>J</kbd>
                </span>
              )}
            </div>
          )}
          {sent && task.sentAt && (
            <p className="meta">
              {t('task.sentAt', { time: task.sentAt.slice(0, 16).replace('T', ' ') })}
              {/* The byline reads from the operators table rather than a name
                  copied onto the task, so a retired colleague still resolves —
                  which is the whole reason that table never deletes rows. */}
              {` · ${
                sender ? t('task.sentBy', { who: sender.name }) : t('task.sentByUnattributed')
              }`}
            </p>
          )}
        </form>

        </div>
        </div>

        {sent && task.draft && task.draft !== task.finalReply && (
          <div className="card">
            <h2>{t('task.draftYouChanged')}</h2>
            <pre className="email" lang={languageTag(task.analysis?.language)}>{task.draft}</pre>
          </div>
        )}

        {/* Everything the draft box used to say. Its own form, outside the one
            above: a restore must not carry the text currently on screen with
            it, and nesting forms is not a thing HTML does. */}
        {/* Seven of these is the normal number, and seven drafts of the same
            reply are seven texts that differ by a sentence. Run together down
            one column — a grey line, a wall of text, a grey line — there is
            nothing telling the eye where one ends and the next begins, and the
            only thing anybody is here to do is compare them. So each is a block
            of its own: ruled off from the one above, its date and its button on
            one row, and the draft itself in a box that says "this is the text of
            this one" rather than trailing off into the page.

            The inline `marginTop` this used to carry is that rule now. */}
        {versions.length > 0 && (
          <details className="card versions">
            <summary>{t('task.versions', { n: versions.length })}</summary>
            {versions.map(version => (
              <form action={restoreDraft} key={version.id} className="version">
                <input type="hidden" name="taskId" value={task.id} />
                <input type="hidden" name="versionId" value={version.id} />
                <div className="row version-head">
                  <span className="meta grow">
                    {version.createdAt.slice(0, 16).replace('T', ' ')} ·{' '}
                    {t(`task.versionBy.${version.source}`)}
                    {version.notes ? ` · ${version.notes}` : ''}
                  </span>
                  {!sent && !sending && <button type="submit">{t('task.restore')}</button>}
                </div>
                <pre className="email" lang={languageTag(task.analysis?.language)}>{version.body}</pre>
              </form>
            ))}
          </details>
        )}

        {/* Last on the page and collapsed, because the reviewer's job is the
            draft above it and this is only ever consulted — usually when
            somebody asks how a customer came to be told something. */}
        {history.length > 0 && (
          <details className="card">
            <summary>{t('task.history', { n: history.length })}</summary>
            <ol className="history">
              {history.map(event => (
                <li key={event.id}>
                  <span className="meta">
                    {event.createdAt.slice(0, 16).replace('T', ' ')}
                  </span>{' '}
                  {t(`task.event.${event.action}`)}
                  {event.actor ? ` · ${who(event.actor)}` : ''}
                  {event.detail ? <span className="detail">{event.detail}</span> : null}
                </li>
              ))}
            </ol>
          </details>
        )}

        </div>

        {/* Beside the reply rather than above it. This is the model's reading
            of the mail, not the mail — useful to glance at while judging the
            draft, and not worth a screenful of scrolling to get past on the
            way to the thing being approved. */}
        <aside className="detail-side">
          {task.analysis && (
            <section className="side-block">
              <h2 className="side-heading">{t('task.whatItUnderstood')}</h2>
              <p className="side-intent">{task.analysis.intent}</p>
              {/* Pills rather than a line of grey text joined by dots. These are
                  four independent facts about the same email, and a reader
                  looking for one of them — "is this person angry" — should be
                  able to find it without reading the other three. */}
              <p className="side-tags">
                <span className="chip">{t(`task.sentiment.${task.analysis.sentiment}`)}</span>
                {task.analysis.scope && <span className="chip">{task.analysis.scope}</span>}
                {/* Left out entirely when nothing is broken. A "cause" on a sales
                    enquiry is a label looking for a fault that was never there. */}
                {task.analysis.cause && task.analysis.cause !== 'not_a_problem' && (
                  <span className="chip cause">{t(`task.cause.${task.analysis.cause}`)}</span>
                )}
                {task.analysis.language && <span className="chip">{task.analysis.language}</span>}
              </p>
              {(task.analysis.suggestedActions.length > 0 ||
                task.analysis.keyPoints.length > 0) && (
                <div className="card">
                  {task.analysis.suggestedActions.length > 0 && (
                    <>
                      <strong>{t('task.youMayAlsoNeedTo')}</strong>
                      <ul className="side-list">
                        {task.analysis.suggestedActions.map((action, i) => (
                          <li key={i}>{action}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {task.analysis.keyPoints.length > 0 && (
                    <ul className="side-list quiet">
                      {task.analysis.keyPoints.map((point, i) => (
                        <li key={i}>{point}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {/* The rules behind the draft, named rather than counted.

              This card is where "5 rules active" used to end the sentence. The
              reviewer's question is not how many rules there are — it is whether
              one of them is obviously not meant for this email, and that can
              only be answered by rules that are on the screen. The summary is
              what a rule looks like folded up, which is exactly what is wanted
              here; see `rules/summarise.ts`.

              Closed, and the count is the thing that decides whether to open it.
              "The 9 rules behind this draft" is already an answer on most
              tasks — the reviewer wanted to know the rulebook was involved and
              roughly how much of it, and having been told, they read the reply.
              Only the draft that reads oddly sends anybody into the list, and
              that is a deliberate press rather than six summaries occupying the
              column beside every email all day.

              Six inside, then a link. Six is enough of the rulebook to
              recognise the shape of it; reading the whole thing is `/rules`,
              which has the search and the editing this column does not. */}
          {rulesShown.length > 0 && (
            <details className="side-block rules-block">
              <summary className="side-heading">
                <span className="line">
                  {t('task.rulesHeading', { n: rulesInPlay })}
                  <span className="caret" aria-hidden="true">
                    ▾
                  </span>
                </span>
                {/* What is inside, at a glance, so that closed is not blank.
                    The heading says how much of the rulebook is in play; this
                    says what kind — "tone and policy" is a different draft from
                    "product and policy", and knowing which is often the whole
                    reason somebody was about to open this.

                    Kinds rather than the first rule's summary: one summary out
                    of nine is a sample, and a sample invites reading the rest,
                    which is the opposite of what a folded panel is for.

                    Gone once it is open, because every row below then names its
                    own kind and this would be the same words twice. */}
                {glance.length > 0 && (
                  <span className="glance">
                    {glance.map(kind => t(`rules.category.${kind}`)).join(' · ')}
                    {glanceRest > 0 ? ` ${t('task.rulesGlanceMore', { n: glanceRest })}` : ''}
                  </span>
                )}
              </summary>
              <div className="card">
                <ul className="rules-in-play">
                  {rulesShown.map(rule => (
                    <li key={rule.id}>
                      <Link href="/rules">
                        {rule.summary ?? rule.content}
                        <span className="about">
                          {t(`rules.category.${rule.category}`)} ·{' '}
                          {t('rules.usedTimes', { n: rule.appliedCount })}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {rulesRest > 0 && (
                  <p className="meta rules-rest">
                    <Link href="/rules">{t('task.rulesMore', { n: rulesRest })}</Link>
                  </p>
                )}
              </div>
            </details>
          )}

          {/* What this edit would teach, beside the draft being edited.

              The whole promise of the product is that the correction gets
              learned, and at the moment of correcting, nothing on the screen
              mentioned it — that happened afterwards, in a queue, on another
              page. This sits in the column of things the model brought to the
              reply, because that is what it is: the next one of them.

              Only when something actually changed. An unedited draft teaches
              nothing, and a panel announcing "this will teach: (nothing)" is
              worse than no panel. And it describes the mechanism rather than
              guessing at the rule's wording: the extraction runs after the send,
              and a panel that sounded more certain than it is would be believed
              exactly once. */}
          {!sent && !sending && edit.meaningful && (
            <section className="side-block learns">
              <h3>{t('task.learns.heading')}</h3>
              {/* The change in one line, quoted from the reviewer's own edit
                  rather than described in the abstract. `previewEdit` picks the
                  first sentence that went and the first that arrived, which on a
                  real edit is nearly always the one that mattered. */}
              {edit.headline ? (
                <p className="scale">
                  {t('task.learns.changed', {
                    from: edit.headline.from,
                    to: edit.headline.to,
                  })}
                </p>
              ) : (
                <p className="scale">
                  {t('task.learns.scale', { added: edit.added, removed: edit.removed })}
                </p>
              )}
              <p className="proposed">{t('task.learns.willLearn')}</p>
              <p className="foot">
                <span>{t('task.learns.notYet')}</span>
                <Link href="/rules">{t('task.learns.openRulebook')}</Link>
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
