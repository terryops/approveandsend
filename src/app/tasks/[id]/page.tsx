import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { Suspense } from 'react';

import { nudgeQueue } from '@/lib/queue';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import { letterHtml, type InlineImage, type Letter } from '@/lib/mail/incoming';
import { remoteImageUrl, remoteImagesAllowed } from '@/lib/mail/remote-images';
import { REPLY_FORMATS, previewHtml, type ReplyFormat } from '@/lib/mail/render';
import { MAX_UPLOAD_BYTES } from '@/lib/mail/uploads';

import { BillingCard } from '../../billing-card';
import { DismissOnEscape } from '../../dismiss-on-escape';
import { Scrim } from '../../scrim';
import { Pressable } from '../../pending';
import { TaskPoller } from '../../task-poller';
import { AttachTile } from './attach-tile';
import { FileTile, sizeKb } from './file-tile';
import { MarkOpened } from './opened';
import { QueueRail, railTasks } from './queue-rail';
import { DiffToggle } from './diff-toggle';
import { LetterFrame } from './letter-frame';
import { DraftTools } from './draft-tools';
import { RenderedDraft } from './rendered-draft';
import { DraftOverlay, ReviewKeys } from './review-keys';
import { listContext } from '@/lib/context/store';
import { deskLanguage, t } from '@/lib/i18n';
import { getOperator } from '@/lib/operators/store';
import { listAttachments, type TaskAttachment } from '@/lib/tasks/attachments';
import { listPending } from '@/lib/tasks/outgoing';
import { listAlternatives } from '@/lib/tasks/alternatives';
import { listEvents } from '@/lib/tasks/events';
import { listMessages } from '@/lib/tasks/messages';
import { previewEdit } from '@/lib/tasks/edit-preview';
import { paragraphs } from '@/lib/tasks/paragraphs';
import { newlines } from '@/lib/text';
import { reviewLayout } from '@/lib/tasks/layout';
import { replyBox } from '@/lib/tasks/reply-box';
import { getTask, markOpened } from '@/lib/tasks/store';
import { deskedAt, type Critique } from '@/lib/tasks/types';
import { listVersions } from '@/lib/tasks/versions';
import { listRules } from '@/lib/rules/store';
import { getWorkspaceConfig } from '@/lib/config/workspace';
import { cardsSource, parseCards, renderCard } from '@/lib/translation/cards';
import { getTranslation, isSameLanguage, saveTranslation } from '@/lib/translation/store';
import { stamp } from '@/lib/time';
import {
  repliesNeedRendering,
  reviewLanguage,
  translateForReview,
} from '@/lib/translation/translate';

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
 * The two rules that undo `showing` where no script will ever arrive.
 *
 * A string rather than a stylesheet rule, because a stylesheet cannot ask
 * whether scripting is on and `<noscript>` cannot be written in CSS. It is the
 * exact inverse of the pair in `globals.css`, and it exists so that the class
 * can be server-rendered — see `RenderedDraft` for why that matters and what it
 * costs.
 */
const NO_SCRIPT_DRAFT =
  '.draft-box.showing .reply-shown{display:none}.draft-box.showing textarea.draft{display:block}';

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
 *
 * Which blocks there are is `paragraphs`, and it is not the one-liner it looks
 * like it should be — see it for the blank lines that are not blank.
 */
function EmailBody({
  text,
  letter,
  subject,
  className = '',
  language,
}: {
  text: string;
  /** Names the frame for a screen reader. Only used where there is a frame. */
  subject?: string;
  /**
   * The same message as its sender wrote it, when it was written in HTML and
   * there is anything left of it after `letterHtml`. Absent everywhere the text
   * is the original: a translation, a composed brief, a plain-text mail.
   */
  letter?: Letter | null;
  className?: string;
  language?: string;
}) {
  if (letter?.document) {
    return (
      <div className={`email-body rich ${className}`.trim()}>
        {/* Above the letter rather than under it, because it is a fact about
            what is missing from the next screenful, and a note at the bottom of
            a scrollport is a note nobody reaches. Outside the frame, because it
            is the desk speaking and everything inside the frame is the sender. */}
        {letter.remoteImages > 0 && (
          <p className="remote-images">{t('task.remoteImages', { n: letter.remoteImages })}</p>
        )}
        {/* No `lang` on the wrapper: the letter has its own document now, so the
            CJK face is chosen by the frame's own stylesheet rather than by this
            page's `:lang()` rules, which cannot see inside it. */}
        <LetterFrame
          document={letter.document}
          title={subject || t('task.theirLetter')}
          expandLabel={t('task.letterExpand')}
          collapseLabel={t('task.letterCollapse')}
        />
      </div>
    );
  }

  return (
    <div className={`email-body ${className}`.trim()} lang={languageTag(language)}>
      {paragraphs(text).map((block, i) => (
        <p key={i}>{block}</p>
      ))}
    </div>
  );
}

/**
 * The pictures a letter is allowed to point at, and where they are served from.
 *
 * Scoped to the message the letter *is*, not to the task: a thread has one
 * attachment table across every message in it, and two mails in one conversation
 * can easily both call their screenshot `image001.png` with the Content-ID
 * Outlook generates from the filename. Unscoped, the reply's own logo would
 * render inside the customer's question.
 */
function inlineImages(
  attachments: TaskAttachment[],
  taskId: string,
  messageId: string | null,
): InlineImage[] {
  if (!messageId) return [];
  return attachments
    .filter(file => file.contentId && file.messageId === messageId)
    .map(file => ({ contentId: file.contentId!, href: `/api/attachments/${taskId}/${file.id}` }));
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

/**
 * The reply in the language the reviewer reads, arriving after the panel it
 * belongs to.
 *
 * A stored rendering is keyed to the exact text it was made from, so an edited
 * draft has none — and editing before sending is what this desk is for. Somebody
 * had to pay for that call, and until now it was `confirmSend`, awaited between
 * the button and the redirect: the panel could not be drawn until the translator
 * had answered, on a screen where every other thing on it was already known. A
 * shelled-out CLI made that seconds.
 *
 * Behind a boundary it is the last thing to arrive rather than the first thing
 * waited for. The letter, the reply, the risk, the attachments and both buttons
 * are on screen immediately; this lands underneath when it lands. A reviewer who
 * cannot read the reply is no worse served — they could not send before the
 * rendering arrived either — and everyone else got their panel back.
 *
 * The write is a cache write and it is deliberately made from a render. What is
 * being stored is the answer to a question this render just asked and paid for,
 * keyed on the text it was asked about; the alternative is asking again on the
 * way back from Escape. A render that is abandoned mid-flight stores nothing,
 * which is why `confirmSend` also queues the job — see the note there.
 *
 * `null` from `translateForReview` is not a failure. It means the model was
 * shown the reply and said it was already in the target language, which is the
 * same thing the reader needs told as a translator that fell over: there is
 * nothing here to read but the reply itself.
 */
async function DraftReading({
  taskId,
  text,
  language,
}: {
  taskId: string;
  text: string;
  language: string;
}) {
  let rendered: string | null = null;
  /** Whether the model answered at all. A thrown call has said nothing. */
  let asked = false;
  try {
    rendered = await translateForReview(text, language);
    asked = true;
  } catch {
    // A translator that is down must not stop somebody sending mail. The note
    // below says plainly that there is no rendering rather than pretending.
  }

  // Null is not a failure. It is the model having been shown the reply and
  // having said it is already in the target language — so it is written down
  // as such, and neither this panel nor the next one asks again. An unwritten
  // "nothing to do" is what made a desk answering its own language pay for this
  // question on every draft it ever edited. A thrown translator writes nothing
  // and is asked again, which is the correct difference between the two.
  if (!rendered) {
    if (asked) saveTranslation(taskId, 'draft', language, text, '');
    return <p className="meta">{t('task.noTranslation', { language })}</p>;
  }

  saveTranslation(taskId, 'draft', language, text, rendered);

  return (
    <div className="translation">
      <p className="meta">
        {t('task.translation')} · {language}
      </p>
      <EmailBody text={rendered} />
    </div>
  );
}

/**
 * What the second opinion objected to, under the grade that was built from it.
 *
 * The grade said "a second model would not sign this off" and stopped there,
 * which is the shape of every verdict a reviewer learns to ignore: it cannot be
 * argued with, it cannot be checked, and the reasons behind it were being
 * thrown away by the job that wrote it. These are those reasons.
 *
 * The heading is the part that has to be right. Three states arrive here and
 * they ask for different things from the person reading: a rewrite means the
 * text in the box has already been corrected and this is the record of what
 * was wrong with it; a rejection with no rewrite means the text is still wrong
 * and nothing has been done about it; remarks under an approval are a footnote.
 * One line of copy telling them apart is the difference between a card that
 * gets read and a second banner that gets skipped.
 *
 * A left rule rather than another coloured band. The risk banner is already
 * directly above it in the alarming colour, and two washes stacked read as one
 * bigger alarm rather than as a verdict and its reasons.
 */
function CritiqueNote({ critique }: { critique: Critique }) {
  // Nothing to say. An approval with no remarks is the ordinary case, and a
  // card announcing that a check passed is a card in the way of the draft.
  if (critique.issues.length === 0) return null;

  const said = critique.rewritten
    ? 'task.critique.rewritten'
    : critique.approved
      ? 'task.critique.remarks'
      : 'task.critique.unfixed';

  return (
    <div className="critique">
      <p className="said">{t(said)}</p>
      <ul>
        {critique.issues.map((issue, i) => (
          <li key={i}>{issue}</li>
        ))}
      </ul>
    </div>
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

  // Somebody has looked at this — but only if somebody has, and that is no
  // longer a thing this function can know.
  //
  // It used to be an unconditional `after(() => markOpened(id))`: after the
  // response rather than during the render, because rendering is supposed to be
  // free of side effects and Next may run it twice or throw the result away.
  // That reasoning is still right and is no longer sufficient, because the
  // inbox now prefetches this page when the pointer crosses a row. A prefetch is
  // a complete render of this screen that nobody sees, `after` runs for it like
  // any other, and the result was the unread dot quietly clearing itself off
  // every row the mouse travelled over on its way somewhere else.
  //
  // So the marker moved into the browser, where "was this seen" is answerable —
  // see `MarkOpened` at the foot of this component, and `noteOpened`.
  //
  // What stays here is the one case an effect cannot cover: a browser running no
  // JavaScript at all. It never soft-navigates, so it never prefetches, so every
  // request it makes is a person typing or clicking their way to this address.
  //
  // `sec-fetch-dest` is how that is recognised, and it is deliberately not one
  // of Next's own headers: `RSC` and `Next-Router-Prefetch` would both answer
  // this precisely, and both are deleted before a page can read them — see
  // `stripFlightHeaders`, which is why the first attempt at this line silently
  // did nothing and marked every hovered row as read anyway. `document` is the
  // browser's own word for "this request is a navigation, and its answer is a
  // page"; the router's fetches, prefetches included, all say `empty`.
  //
  // A client old enough not to send it at all gets no server-side mark, which is
  // the safe direction to be wrong in: with scripts on the effect covers it, and
  // with scripts off the dot simply stays until the task is answered. Marking
  // mail read that nobody opened is the failure worth avoiding.
  if ((await headers()).get('sec-fetch-dest') === 'document') after(() => markOpened(id));

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

  // The letter as its sender wrote it, where there is one. Built once here
  // rather than inside `EmailBody`, because the message appears twice on this
  // page — the review screen and the confirmation panel — and sanitising the
  // same markup twice per render is work with no reader.
  // A picture the letter keeps elsewhere is fetched by the desk and served
  // from here, rather than by this browser from the sender's server — see
  // `remote-images.ts`. Off, and every one of them is counted and refused.
  const letterOptions = remoteImagesAllowed() ? { proxy: remoteImageUrl } : {};
  const letter = letterHtml(
    task.bodyHtml,
    inlineImages(attachments, task.id, task.messageId),
    letterOptions,
  );
  const threadLetters = new Map(
    thread.map(m => [
      m.id,
      letterHtml(m.bodyHtml, inlineImages(attachments, task.id, m.messageId), letterOptions),
    ]),
  );

  // Only ever the translation of exactly what is rendered below it. A draft
  // regenerated since its translation was written shows none, because a
  // reviewer who cannot read the reply cannot notice the two have drifted.
  // Whether a rule learned from this edit goes live or waits — read here
  // because the panel at the foot of the page promises one or the other.
  const autoApproveRules = getWorkspaceConfig().autoApproveRules;

  const language = reviewLanguage();
  const bodyText = task.body || '';
  /*
   * Three states, not two, and the third is why a Chinese desk answering
   * Chinese mail carried a line under every reply promising a translation that
   * was never coming.
   *
   * A row with content is a rendering. No row is a question nobody has asked
   * yet. An *empty* row is the model having been asked and having answered that
   * the text is already in the language the reviewer reads — see
   * `isSameLanguage`, and the note there for why that answer had to start being
   * written down before any screen could act on it.
   *
   * `stored` keeps the row so the pair below can tell the last two apart;
   * `incoming`/`outgoing` are the ones with something to show, which is what
   * every rendering site below actually wants.
   */
  const incomingStored = language ? getTranslation(task.id, 'body', bodyText, language) : null;
  const outgoingStored = language ? getTranslation(task.id, 'draft', body, language) : null;
  const incoming = isSameLanguage(incomingStored) ? null : incomingStored;
  const outgoing = isSameLanguage(outgoingStored) ? null : outgoingStored;
  // And whether the panel should wait for one that is not stored yet.
  //
  // Only the panel. This is a model call, and the review screen behind it is
  // rendered on every view of every task — one there would be a translator bill
  // for walking the queue with `J`. The panel is a screen somebody asked for,
  // once, about one reply they are about to send.
  //
  // `repliesNeedRendering` is what keeps it from asking a question the config
  // already answers: a desk answering in the language its reviewers read gets
  // the note below instead, having spent nothing.
  // `outgoingStored` and not `outgoing`: an empty row is the model having
  // already answered "nothing to do", and asking it again every time the panel
  // opens is the bill this whole distinction exists to stop.
  const reading =
    Boolean(language) && !outgoingStored && body.trim() !== '' && repliesNeedRendering();
  // And the cards, which are in whatever language their source was written in
  // — English, for the built-in ones and for most config files. Rendered into
  // the interface language instead of the review language, because a card is
  // part of this screen rather than part of the mail; see translation/cards.ts.
  // Absent until the job has run: the fallback is the card as its source wrote
  // it, which is what was there before.
  //
  // `deskLanguage` and not `operatorLanguage`, because this has to name the
  // language the same way the worker that stored the row did, and the worker has
  // no browser to ask. Not absent for good any more either: `noteOpened` queues
  // a rendering for a card that has none, so opening this page is what fixes it.
  const cards = parseCards(getTranslation(task.id, 'context', cardsSource(context), deskLanguage())?.content);

  // Newest first, and never including what is in the box right now — the
  // point of the panel is what the box used to say.
  const drafts = listVersions(task.id);
  // Compared with one spelling of a line break on both sides. Rows written
  // before `newlines` existed hold the CRLF a textarea submits, and against a
  // draft holding the model's LF that is a difference of two invisible bytes —
  // enough for this filter to list the current reply as an earlier draft, and
  // for Put this back to restore a text the box could not show had changed.
  const current = newlines(body).trim();
  const versions = drafts.filter(v => newlines(v.body).trim() !== current);

  // Set by `restoreDraft` alone, and read in two places: the flash on the box
  // and the line by the buttons.
  const restored = typeof query.restored === 'string';

  // The one-shot messages this screen is currently showing, for the form to
  // carry. Only the ones a tab press falsifies: `saved` and `queued` stay true
  // across one, and moving the URL to say so again would spend a navigation on
  // nothing. See `clearsNotice` in actions.ts.
  const notice = ['error', 'restored'].filter(key => typeof query[key] === 'string').join(' ');

  // What the model wrote, against what is in the box now.
  //
  // Not `task.draft`: that field is the current text, and `keepEdits` writes the
  // reviewer's edits straight into it, so comparing it against the box compares
  // a value with itself. The model's own words survive as the newest version
  // marked `model` — written by `draft-reply`, by `compose-message`, and by
  // picking one of the alternatives — and that is the text this edit departed
  // from. A pure call, computed here and thrown away with the render.
  const edit = previewEdit(drafts.find(v => v.source === 'model')?.body ?? null, body);

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
  //
  // Against `current` rather than `body`, for the reason the version filter just
  // above uses it: an option is model output and holds LF, and a row written
  // before `newlines` existed holds the CRLF a textarea submits. Comparing the
  // two spellings put no tab in the lit state and told the reviewer, in the line
  // under the strip, that they had edited a reply they had not touched.
  const selected = alternatives.find(option => newlines(option.body).trim() === current);

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
        /* `Scrim` rather than the bare div its three siblings still use, and the
           difference is a press on the dark part putting you back on the review
           screen. It is the one panel here with nothing typed into it — the note
           and the draft are boxes on the screen behind, already written to the
           row — so a stray click costs a reviewer the scroll position of a panel
           they can reopen and nothing else. Redraft and Dismiss each hold a
           sentence somebody is part way through and keep to Escape, which is
           harder to press by accident than the whole of the rest of the screen.
           `Scrim` renders the Escape handler too; see it for why the press is
           measured at both ends. */
        <Scrim href={`/tasks/${task.id}`}>
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

            {/* And for the same reason, the reasons themselves. This is the
                screen where the decision is actually made, and "it quotes a
                price that is not in the catalogue" is worth more here than
                anywhere else on the desk. */}
            {task.critique && <CritiqueNote critique={task.critique} />}

            {/* Their letter and the reply beside it, rather than one above the
                other. Holding both in view at once is the entire job of this
                screen — stacked, the eye leaves one to check the other and loses
                the paragraph it was on, and these two are not two versions of
                one passage but the question and the answer. A translation, where
                there is one, sits under its own original inside the same half. */}
            <div className="confirm-pair">
              <div className="confirm-half">
                <h3 className="confirm-heading">{t('task.confirm.theyWrote')}</h3>
                <EmailBody
                  text={task.body || t('task.emptyBody')}
                  letter={letter}
                  subject={task.subject}
                  language={task.analysis?.language}
                />
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
                {outgoing ? (
                  <div className="translation">
                    <p className="meta">
                      {t('task.translation')} · {outgoing.language}
                    </p>
                    <EmailBody text={outgoing.content} />
                  </div>
                ) : (
                  /* The one thing on this panel that is not already known when
                     the panel is drawn — so it is the one thing the panel does
                     not wait for. Everything above this line is a read of the
                     row; this is a model call, and it used to happen in
                     `confirmSend` with the redirect held behind it, which is why
                     pressing Preview did nothing visible for as long as the
                     translator took. Streamed in, the letter and the reply are
                     on screen at once and the reading lands under them. */
                  reading && (
                    <Suspense
                      fallback={<p className="meta">{t('task.translationComing', { language })}</p>}
                    >
                      <DraftReading taskId={task.id} text={body} language={language} />
                    </Suspense>
                  )
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
                showing it to them, not to assume the panel is still loading.

                Not while one is on its way: `reading` is the case where the
                column above is either a spinner or about to be a reading, and a
                note saying there is none under a boundary that is fetching one
                is the assumption this sentence exists to prevent, made by the
                sentence itself. `DraftReading` says it there if the answer
                turns out to be nothing.

                And not when the answer is that there is nothing to render:
                `outgoingStored` is set and `outgoing` is not on a reply already
                in the reviewer's language, which is every reply on a desk that
                answers its own mail in its own language. A line announcing a
                missing translation of a sentence they can read is the whole of
                what that desk got out of this feature. */}
            {language && !outgoingStored && !reading && (
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
                {/* The paragraph that used to sit here explained that the
                    learning job reads the edit and proposes a rule in its own
                    words. It is a true sentence and this is the fourth time the
                    screen has said it: the sidebar on the review page says it at
                    length, the heading above says it in five words, and the
                    checkbox below offers the way out of it. On the panel that
                    exists to be read in the second before Send, three lines
                    about a background job is exactly the kind of block people
                    learn to skip — which costs the checkbox its readers too.
                    The heading, the scale, the switch. */}
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
        </Scrim>
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
      {/* And not at all while the confirmation is up.
     *
     * `?confirm=1` is a flag on this route, so raising the panel re-rendered
     * this entire screen underneath it — and "underneath" is a scrim at 78%
     * opacity over a 2px blur. The reviewer is reading the panel; what the
     * second copy buys them is a blurred suggestion of a page they have already
     * left.
     *
     * It is not the render that costs — that is 17ms either way. It is the
     * wire. A support mail is a receipt with an inline image in it, and the
     * panel shows the customer's letter beside the reply, so a screen that also
     * drew the letter behind the scrim sent the whole thing down twice.
     * Measured on a production build against a 241KB receipt: 554KB for the
     * review screen, 1071KB for the same screen with the panel over it. Half of
     * every Preview press was a second copy of a letter nobody could read.
     *
     * On a desk running on localhost that is free and this is invisible. Over a
     * network to a server somewhere it is the whole of the wait, which is why
     * it survived every measurement taken here until one was taken with a real
     * letter in it.
     *
     * The panels that are *not* full-screen keep their page: Redraft and
     * Dismiss are a question in a small box, and the screen behind them is
     * still the context for answering it. This one is a whole screen of its
     * own — the letter, the reply, the risk, the attachments — and it repeats
     * everything the page behind it was for. */}
      {!confirming && (
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

        {/* Under the grade rather than in the sidebar with the analysis, and
            not folded into a `details`. It is the same argument the banner
            above it won: a reason that has to be asked for is a reason nobody
            reads, and this one is about the reply directly below it.

            Outside the `risk` condition on purpose. A critic can object to a
            draft the arithmetic still grades `low` — one factor is not two —
            and on that task this is the only thing on the page that knows
            anything is wrong. */}
        {task.critique && <CritiqueNote critique={task.critique} />}

        {/* The keyboard. Renders nothing; see review-keys.tsx for why every one
            of these presses a control that is already on the page. */}
        <ReviewKeys next={neighbours.next} previous={neighbours.previous} />

        {/* Renders nothing either, and is the reason the unread dot still means
            something now that the inbox fetches this page before it is asked
            for. A prefetch renders this component; only a browser mounts it.
            See `opened.tsx`. */}
        <MarkOpened taskId={task.id} />

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
            is waiting for.

            "Neither is expensive" was true of the read and not of the refresh
            it hangs off, which re-renders this entire screen — the letter, the
            thread, the rulebook, the history — and then reconciles it. Behind
            the panel that is worth paying every two seconds, because a worker is
            running and the answer is close. Out here the queue may not be
            scheduled at all, and then this is a full render every five seconds
            for the rest of the afternoon, competing with whatever the reviewer
            clicks next, to print exactly the same words. So it gives up
            gradually: `slowTo` lets the gap grow towards a minute while nothing
            changes, and the first few refreshes — the ones that catch a wait
            that was really going to end — are as quick as they ever were. A
            minute rather than longer because the ceiling is also how stale this
            screen is allowed to get once somebody has walked away from it and
            come back.

            `restartOn` is the other half of giving up gradually: the status is
            what this is waiting on, so a queue that finally turns collapses the
            gap back to five seconds instead of leaving a written draft sitting
            behind a minute of patience earned while nothing was happening. See
            the poller. */}
        {inFlight && !working && (
          <TaskPoller intervalMs={5000} slowTo={60_000} restartOn={task.status} />
        )}

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
            {` · ${stamp(deskedAt(task))}`}
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
                  {` · ${stamp(m.receivedAt)}`}
                </div>
                {/* The whole thread is in the customer's language, both directions: a
                    reply is written in the language the letter arrived in, which
                    is why there is a translation of the draft at all. */}
                <EmailBody
                  text={m.body || t('task.emptyBody')}
                  letter={threadLetters.get(m.id)}
                  subject={m.subject || task.subject}
                  language={task.analysis?.language}
                />
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
            {/* The translation used to be named up here too, in the accent, on
                the grounds that it is the one thing on this card a reviewer
                looks for. It was right about that and wrong about where: the
                pane below now opens with its own caption, level with the first
                line of the original — see `.compare` — so a head label put the
                word "译文" on the card twice, an inch apart, and the second one
                was the one that said which language. */}
          </div>
          {task.error && <p className="error">{task.error}</p>}
          {/* Original on the left, translation on the right — see `.compare`
              in globals.css for why. The `details` is still `open` by default,
              so a reviewer who wants their old stacked view can just close it. */}
          <div className={`compare${incoming ? '' : ' compare-single'}`}>
            <EmailBody
              text={task.body || t('task.emptyBody')}
              letter={letter}
              subject={task.subject}
              language={task.analysis?.language}
            />
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
        {context.map((block) => {
          // In the desk's language where one has been rendered, and in the
          // source's own words where it has not. Not two versions side by side
          // like the mail panels: nobody is approving a card, so the original
          // is evidence of nothing that a link to the record itself does not
          // already answer.
          const card = renderCard(block, cards);

          return (
          <div className="card" key={block.sourceId}>
            <div className="row">
              <h2 className="grow" style={{ margin: 0 }}>
                {card.title}
              </h2>
              {block.href && (
                <a className="card-open" href={block.href} target="_blank" rel="noreferrer">
                  {t('task.openContext')}
                </a>
              )}
            </div>
            <dl className="facts">
              {card.fields.map((field, i) => (
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
            {/* `card-note`, not `meta`: this is what the draft was written
                from, and it spent long enough looking like the caption under a
                timestamp. See the rule. */}
            {card.prompt && <p className="card-note">{card.prompt}</p>}
          </div>
          );
        })}

        {/* And who they are to Stripe, which is the other half of the question
            the cards above answer: what we have told them before, and what they
            are worth to us. It reads at render time rather than out of the
            enrichment job — see `BillingCard` — so it is here on a task the
            queue enriched before billing was switched on, and on one it never
            enriched at all.

            Not where `stripeSource` has already said it. A desk running both
            would otherwise carry two Stripe boxes down one column saying nearly
            the same thing in two voices, and the one the model was actually
            given is the one worth keeping — a reviewer checking whether a reply
            is right needs to see what it was written from.

            And not on the render that raises the confirmation.

            `?confirm=1` is a flag on this route rather than a route of its own,
            so opening the panel renders this whole screen again underneath it —
            and this is the one thing on the screen that leaves the process to be
            drawn. `customerSummary` remembers the answer for a minute, which
            makes the repeat cheap; it does not make it not happen, and a memo
            that has just expired would put a third party's round trip in front
            of a panel that says nothing about billing. Skipping is the only
            version of this with no worst case.

            What it costs is a card that is not there while the panel is up. The
            scrim is 78% opaque over a 2px blur, so what a reviewer can see of it
            is the column shifting up behind frosted glass for as long as they
            are reading something else. That is the trade, and it is the right
            way round: the panel is the one screen on this desk where waiting is
            unaffordable, and billing is the one thing on the screen behind it
            that nobody is reading through a blur. */}
        {!confirming && !context.some(block => block.sourceId === 'stripe') && (
          <BillingCard email={task.fromAddress} />
        )}

        </div>
        <div className="reply-side">

        {/* `confirmSend`, not `approveAndSend`: this form's own action is what
            the primary button and the return key both reach, and neither should
            put mail on the wire without the panel above being seen first. The
            send itself is posted from that panel. */}
        <form className="stack review-form" action={confirmSend}>
          <input type="hidden" name="taskId" value={task.id} />
          {/* Whether there is a message on screen that a tab press would make
              untrue. The two switches answer without navigating, which is what
              makes them quick and also what leaves the URL — and so the banner
              it drives — exactly where it was; carrying this is how they know to
              navigate once and clear it. See `clearsNotice`. Empty in the
              ordinary case, which is every press after the first. */}
          <input type="hidden" name="notice" value={notice} />
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
          {/* The approaches are inside the card now, and the wrapper they used
              to sit in is gone.

              They were a block of their own above it, which side by side placed
              in a row of its own so that the two cards could still start level.
              That row held one thing, in the right-hand column, and the left
              half of it was empty — a hundred and fifty pixels of nothing beside
              the strip, taken off the top of the letter, on the one screen where
              the letter is the thing that runs out of room. The strip was also
              being asked to fit three approaches into half a screen, so it wrapped
              onto a second line and paid for the room twice.

              In the card the row disappears. Both cards start at the top, the
              letter gets the height back, and the strip gets the width it wanted
              — and it is closer to what it acts on than it has ever been: these
              tabs rewrite the box directly underneath them.

              `#reply` moves here with them. It is the target `setReplyFormat`
              and `useAlternative` redirect to — see `replyHref` in actions.ts —
              and it has to land on whatever holds the tabs, or pressing one
              scrolls the control that just moved out of view. */}
          <div className="card reply-card" id="reply">
          {alternatives.length > 0 && (
            <div className="alt-strip">
              <span className="meta">{t('task.optionsLabel')}</span>
              <div className="alt-tabs" role="group" aria-label={t('task.optionsLabel')}>
                {/* Wrapped so the tab you pressed looks pressed while the post
                    is in the air — the switch is a round trip, and until it
                    lands the row you chose is indistinguishable from the two you
                    did not. See `Pressable`, and note that the action stays
                    named here rather than handed down as a prop.

                    And the option's own text goes down with it, which is what
                    makes the press land on the box rather than only on the tab.
                    It is already here — `listAlternatives` read the body along
                    with the label — so the reply can be swapped on the click and
                    the round trip spent confirming it rather than performing it.
                    See `Pressable` again for the ordering that keeps a
                    reviewer's editing in the post. */}
                {alternatives.map(option => (
                  <Pressable key={option.id} draft={option.body}>
                    <button
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
                  </Pressable>
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
            <p className="meta alt-note">{t('task.optionsEdited')}</p>
          )}
          {/* Whose words these are, and how they will be rendered — the two
              things a reviewer needs to know before reading a single line of the
              box below. The format lives up here rather than on a row of its own
              because it is a property of this reply, not a step in writing it. */}
          <div className="row card-head">
            <span className="card-label grow accent">
              {sent ? t('task.whatWentOut') : t('task.theReply')}
            </span>
            {/* The marks the format already understands, on buttons, for the
                reviewers who do not type them.

                In this row and not above the box, which is the second attempt.
                The first put them on a line of their own between the label and
                the reply, and a line of their own is a line that exists on every
                task — reserved whether anybody is editing or not, because
                collapsing it would have made the card flinch downward at the
                moment you clicked into it. That is a toolbar charging every
                reader for a writer's convenience. This row is already here, the
                buttons sit in space the heading was not using, and nothing moves
                vertically when they appear.

                Only on Markdown, and that is the whole of the condition. On
                plain text a `**` is two asterisks in the customer's mailbox, so
                a bold button there would be a button that inserts a typo; on
                HTML the reviewer is writing tags and does not want `- ` in front
                of them. The one format that reads these marks offers them.

                Sent tasks lose it too. The box is still there, read-only, and a
                toolbar over a reply that has already gone is offering to edit
                something no longer editable. */}
            {!sent && !sending && task.replyFormat === 'markdown' && (
              <DraftTools
                group={t('task.mark.group')}
                labels={{
                  bold: t('task.mark.bold'),
                  italic: t('task.mark.italic'),
                  code: t('task.mark.code'),
                  link: t('task.mark.link'),
                  ul: t('task.mark.ul'),
                  ol: t('task.mark.ol'),
                  quote: t('task.mark.quote'),
                  heading: t('task.mark.heading'),
                }}
              />
            )}
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
                      <Pressable key={option}>
                        <button
                          type="submit"
                          formAction={setReplyFormat.bind(null, option)}
                          className={task.replyFormat === option ? 'active' : ''}
                          aria-current={task.replyFormat === option ? 'true' : undefined}
                          title={t(`task.format.hint.${option}`)}
                        >
                          {t(`task.format.${option}`)}
                        </button>
                      </Pressable>
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
            {/* And the switch between the reply and its diff, after the toolbar
                rather than before it — an order the layout depends on.

                The toolbar comes and goes with the box's focus, and the heading
                to its left has the `grow`, so the heading absorbs its width.
                Anything sitting between the two moves by that width every time
                it appears. This switch was there, which made it a button that
                slid 230px sideways on its own mousedown: the press blurred the
                box, the toolbar vanished, the heading grew, and the mouseup
                landed on the format pill that had taken its place. Everything
                after the toolbar is flush right and never moves.

                Behind `edit.meaningful` for the same reason the learning panel
                is: on a draft nobody has touched there is no diff, and a switch
                offering to show nothing is one more thing to read. */}
            {!sent && !sending && edit.meaningful && <DiffToggle label={t('task.diff.label')} />}
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
            {/* The reply, and what the reviewer did to it, in the same notation
                the versions panel uses.

                This was a wash of green under the sentences the reviewer had
                written: a second copy of the draft rendered behind a transparent
                textarea, aligned character for character. It was the only shape
                a highlight *can* take inside a textarea, and it could only ever
                say half of the thing worth saying. A diff has two sides, and the
                sentence somebody deleted is not in the text to be coloured — so
                the mark answered "which of these words are mine" and never
                "what did I take out", which on a reply that got shorter is the
                whole edit.

                A diff proper says both, and it does not have to fit inside the
                box to do it. It stands in the box's place while it is on: the
                textarea goes `display: none` and keeps posting, because it is
                still the one copy of the reply and the form still has to carry
                it. Turning the switch off is what puts the editor back.

                Only ever on top of an edit — `edit.meaningful` gates the switch
                too, so an untouched draft is an ordinary editable box with no
                control near it and no way into this state. */}
            {/* `restored` puts one animation on the box, and it is doing a job
                rather than decorating. A restore replaces every word in the
                reply at once, from a control in a collapsed panel near the
                bottom of the page — the reviewer's eye is on the button they
                pressed, and the thing that changed is a screen away. The flash
                is the only thing saying which of the two moved. */}
            <div className={`draft-box showing${restored ? ' restored' : ''}`}>
              {/* The reply as it will arrive, which is what this box shows until
                  somebody clicks it. `previewHtml` is the function `sendReply`
                  composes the mail with, so this is not a picture of the reply —
                  it is the reply. See `RenderedDraft` for the click, and for why
                  the class above is the server's rather than a script's.

                  `showing` is on the box unconditionally, including on a sent
                  task: there the rendering is simply what went out, and the
                  click that would start an edit is refused because the textarea
                  under it is read-only. */}
              <div
                className="reply-shown reply-rendered"
                lang={languageTag(task.analysis?.language)}
                dangerouslySetInnerHTML={{ __html: previewHtml(body, task.replyFormat) }}
              />
              {edit.meaningful && (
                <div className="reply-diff diff" lang={languageTag(task.analysis?.language)}>
                  {edit.ops.map((op, i) => (
                    <p key={i} className={`diff-line ${op.kind}`}>
                      <span className="sign">
                        {op.kind === 'add' ? '+' : op.kind === 'remove' ? '−' : ' '}
                      </span>
                      <span className="text">{op.text}</span>
                    </p>
                  ))}
                </div>
              )}
              {/* Opened at the length of the reply rather than at a height
                  somebody picked once. `rows` is the estimate every browser
                  understands; `--reply-rows` is the same number in a form the
                  stylesheet can cap a quoted thread with. See reply-box.ts.

                  `key` is the prop without which Put this back does nothing.
                  `defaultValue` is the DOM property of the same name, and the
                  DOM reads it once, when the element is created. Every server
                  action here ends in a redirect to this same route, which React
                  renders by reconciling — same element in the same place, so the
                  node is kept and the new `defaultValue` is written to a
                  textarea that stopped caring about it at mount. The row had
                  been rewritten and the page re-rendered from it, and the box
                  still showed the old reply until somebody pressed refresh.
                  Measured on the restore: the row went 38 → 130 characters and
                  the box stayed at 36.

                  Keying on the text remounts the box exactly when the server's
                  idea of the draft changes, and never otherwise. Safe here
                  because an idle review screen has no re-render to lose typing
                  to: `TaskPoller` is mounted only inside the working dialog, and
                  every other re-render follows a server action that has just
                  saved this box's contents. */}
              <textarea
                className="draft"
                name="draft"
                aria-label={t('task.draftLabel')}
                key={body}
                defaultValue={body}
                readOnly={sent || sending}
                placeholder={t('task.draftPlaceholder')}
                rows={box.rows}
                data-quoted={box.quoted ? '' : undefined}
                style={{ '--reply-rows': box.rows } as React.CSSProperties}
              />
              <DraftOverlay highlighted={edit.meaningful} />
              <RenderedDraft format={task.replyFormat} />
              {/* And the reader with no JavaScript gets the box back.
                  `showing` is in the markup so that nobody sees a frame of raw
                  Markdown before the script arrives; without a script there is
                  nothing to click the rendering into an editor, so this hands
                  back the plain textarea this screen has always had. */}
              <noscript>
                <style>{NO_SCRIPT_DRAFT}</style>
              </noscript>
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
          {/* `outgoingStored`, so a reply the model has already said needs no
              rendering says nothing here at all. See the note by the pair. */}
          {language && !outgoingStored && body.trim() !== '' && (
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
              {/* "Preview", because that is what pressing it does. It was
                  "Approve & send", which named the whole journey and not the
                  step: what it opens is a panel that shows the letter and then
                  asks, and the words it asked with — "Yes, send it" — were an
                  answer to a question the button had already appeared to ask.
                  The phrase has moved inward to the button that does put mail on
                  the wire, where approving and sending are the same press.

                  Wrapped, because it is the one button on this screen whose
                  press had nothing at all to show for itself. Every tab above it
                  goes dim under the hand; this posted the form, waited out a
                  round trip and then replaced the screen — which reads as a hang
                  and then a jump, and is the press people make twice. No `draft`
                  prop: there is no box for a guess to go in, and the panel it is
                  waiting for is the server's to draw. See `Pressable`. */}
              {sendable && (
                <Pressable>
                  <button className="primary" type="submit">
                    {t('task.preview')} <kbd>⌘↵</kbd>
                  </button>
                </Pressable>
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
              {restored && <span className="meta said">{t('task.restored')}</span>}
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
              {t('task.sentAt', { time: stamp(task.sentAt) })}
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
            {versions.map(version => {
              /* Each old draft against the one in the box, rather than on its
                 own.

                 Seven drafts of one reply are seven texts that differ by a
                 sentence, and the panel used to print all seven in full and
                 leave the comparing to the reader — which is the only thing
                 anybody opens it to do. The question being asked here is never
                 "what did this version say", it is "what would change if I
                 pressed the button", so that is what it now answers: the
                 sentences this version has that the box does not, marked, and
                 above them the size of the swap in both directions.

                 `previewEdit` reads from the box towards the version, which is
                 the direction the button moves. So its `added` is what putting
                 this back would bring and its `removed` is what it would drop —
                 the reverse of the reading in the reply card, where the same
                 function measures the reviewer's departure from the model.

                 Rendered the way everyone already reads a diff: `−` for the
                 sentences the swap would take out, `+` for the ones it would
                 bring, and the untouched ones between them as context. The marks
                 used in the reply box are the wrong tool here — they can only
                 colour text that is present, so a version whose whole point is
                 the paragraph it *lacks* showed up as a plain block with nothing
                 marked on it at all.

                 Sentences and not lines, which is where this parts company with
                 git and is better for it. A reply is paragraphs; a line diff of
                 one would report a whole paragraph replaced because a date
                 inside it changed. `diffSentences` is an LCS over sentences, so
                 the unit on screen is the unit somebody actually edited. */
              const against = previewEdit(current, newlines(version.body));
              // No ops when there is nothing to compare against — an empty box.
              // The version is then all context rather than all addition, which
              // is the truthful reading: nothing is being taken out.
              const lines =
                against.ops.length > 0
                  ? against.ops
                  : [{ kind: 'keep' as const, text: newlines(version.body) }];
              return (
                <form action={restoreDraft} key={version.id} className="version">
                  <input type="hidden" name="taskId" value={task.id} />
                  <input type="hidden" name="versionId" value={version.id} />
                  <div className="row version-head">
                    <span className="meta grow">
                      {stamp(version.createdAt)} ·{' '}
                      {t(`task.versionBy.${version.source}`)}
                      {version.notes ? ` · ${version.notes}` : ''}
                    </span>
                    {!sent && !sending && <button type="submit">{t('task.restore')}</button>}
                  </div>
                  {/* No count above it. It said "brings 1 sentence and drops 1"
                      over a diff with one `+` and one `−` already in it —
                      arithmetic about something the reader can see, in the one
                      place where seeing it is the entire point. */}
                  <div className="version-diff diff" lang={languageTag(task.analysis?.language)}>
                    {lines.map((op, i) => (
                      <p key={i} className={`diff-line ${op.kind}`}>
                        {/* The sign is read out, not hidden. "minus, we refund
                            in three days" is the sentence a screen reader needs;
                            an `aria-hidden` gutter would leave it announcing two
                            contradictory sentences with nothing to tell them
                            apart. */}
                        <span className="sign">
                          {op.kind === 'add' ? '+' : op.kind === 'remove' ? '−' : ' '}
                        </span>
                        <span className="text">{op.text}</span>
                      </p>
                    ))}
                  </div>
                </form>
              );
            })}
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
                    {stamp(event.createdAt)}
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
              {/* Two sentences that have to match what the desk actually does.
                  Under `autoApproveRules` the learning pass writes the rule
                  rather than proposing it, and there is no click between the
                  two — a panel still promising "no proposal steers a draft
                  until you approve it" would be describing a gate that is not
                  there, on the one screen whose whole subject is what this
                  edit is about to change. See the setting. */}
              <p className="proposed">
                {t(autoApproveRules ? 'task.learns.willLearnAuto' : 'task.learns.willLearn')}
              </p>
              <p className="foot">
                <span>
                  {t(autoApproveRules ? 'task.learns.notYetAuto' : 'task.learns.notYet')}
                </span>
                <Link href="/rules">{t('task.learns.openRulebook')}</Link>
              </p>
            </section>
          )}
        </aside>
      </div>
      )}
    </>
  );
}
