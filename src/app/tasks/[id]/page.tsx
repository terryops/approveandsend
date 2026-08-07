import Link from 'next/link';
import { notFound } from 'next/navigation';
import { after } from 'next/server';

import { requirePage } from '@/lib/auth/guard';
import { listContext } from '@/lib/context/store';
import { t } from '@/lib/i18n';
import { getOperator } from '@/lib/operators/store';
import { isRenderableImage, listAttachments } from '@/lib/tasks/attachments';
import { listAlternatives } from '@/lib/tasks/alternatives';
import { listEvents } from '@/lib/tasks/events';
import { listMessages } from '@/lib/tasks/messages';
import { getTask, markOpened } from '@/lib/tasks/store';
import { listVersions } from '@/lib/tasks/versions';
import { listRules } from '@/lib/rules/store';
import { getTranslation } from '@/lib/translation/store';
import { reviewLanguage } from '@/lib/translation/translate';

import {
  approveAndSend,
  dismissTask,
  redraftTask,
  reopenTask,
  restoreDraft,
  saveDraft,
  useAlternative,
} from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * The review screen. This is the product.
 *
 * The draft is a plain textarea inside the same form as the Send button, so
 * what gets sent is exactly what is on screen — there is no separate "save"
 * the reviewer can forget, and no client state to desynchronise from it.
 */
export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();

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
  const rulesInPlay = listRules({ enabledOnly: true }).length;
  const context = listContext(task.id);
  const thread = listMessages(task.id);
  const attachments = listAttachments(task.id);
  const files = attachments.filter(file => !file.inline);
  // Inline ones included, and that is the point. A screenshot pasted into
  // Gmail arrives inline, and it is very often the whole content of the email
  // — "here is what I'm seeing". Filtering those out to keep signature logos
  // off the page meant the one thing the customer actually sent was the one
  // thing the reviewer could not see. A stray logo is a cheaper mistake.
  const pictures = attachments.filter(file => isRenderableImage(file.contentType));

  // Only ever the translation of exactly what is rendered below it. A draft
  // regenerated since its translation was written shows none, because a
  // reviewer who cannot read the reply cannot notice the two have drifted.
  const language = reviewLanguage();
  const bodyText = task.body || '';
  const incoming = language ? getTranslation(task.id, 'body', bodyText, language) : null;
  const outgoing = language ? getTranslation(task.id, 'draft', body, language) : null;

  // Newest first, and never including what is in the box right now — the
  // point of the panel is what the box used to say.
  const versions = listVersions(task.id).filter(v => v.body.trim() !== body.trim());

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
      <p className="meta">
        <Link href="/">{t('task.backToInbox')}</Link>
      </p>

      {typeof query.error === 'string' && <p className="banner">{query.error}</p>}
      {typeof query.saved === 'string' && <p className="meta">{t('task.saved')}</p>}
      {typeof query.queued === 'string' && (
        <p className="meta">{t('task.redraftQueued')}</p>
      )}

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
          {t('task.superseded')} <a href={`/tasks/${task.supersededBy}`}>{t('task.supersededOpen')}</a>
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

      <div className="detail">
        <div className="detail-main">

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
                <pre className="email">{m.body || t('task.emptyBody')}</pre>
              </div>
            ))}
          </details>
        )}

        <div className="card">
          <div className="row">
            <span className="subject grow">{task.subject || t('task.noSubject')}</span>
            {task.risk && task.risk.level !== 'low' && (
              <span className={`tag risk-${task.risk.level}`}>
                {t(`task.risk.${task.risk.level}`)}
              </span>
            )}
            <span className={`tag ${task.status}`}>{t(`task.status.${task.status}`)}</span>
          </div>
          {/* The reasons, not just the grade. A badge a reviewer cannot argue
              with is one they learn to ignore. */}
          {task.risk && task.risk.factors.length > 0 && (
            <p className="meta">
              {task.risk.factors.map(f => t(`task.riskFactor.${f}`)).join(' · ')}
            </p>
          )}
          <div className="meta">
            {/* On a composed mail this address is the recipient, not a sender.
                The label above the body says which, because a brief presented as
                "the customer's email" is a lie on the one screen that has to be
                trusted. */}
            {task.origin === 'composed' ? `${t('compose.to')}: ` : ''}
            {/* The address is the link, because it is the thing being asked
                about. "Have we talked to this person before, and what did we
                say" is a question the context card answers in one sentence and
                a reviewer sometimes needs the whole of. */}
            <a href={`/senders/${encodeURIComponent(task.fromAddress)}`}>
              {task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
            </a>
            {task.receivedAt ? ` · ${task.receivedAt.slice(0, 16).replace('T', ' ')}` : ''}
          </div>
          {task.origin === 'composed' && (
            <p className="meta" style={{ marginTop: 12 }}>{t('task.brief')}</p>
          )}
          {task.error && <p className="error">{task.error}</p>}
          {/* Original on the left, translation on the right — see `.compare`
              in globals.css for why. The `details` is still `open` by default,
              so a reviewer who wants their old stacked view can just close it. */}
          <div className={`compare${incoming ? '' : ' compare-single'}`} style={{ marginTop: 12 }}>
            <pre className="email">
              {task.body || t('task.emptyBody')}
            </pre>
            {incoming && (
              <details className="translation" open>
                <summary>
                  {t('task.translation')} · {incoming.language}
                </summary>
                <pre className="email">{incoming.content}</pre>
              </details>
            )}
          </div>
          {/* Shown, not linked. `loading="lazy"` and a CSS height cap rather
              than a thumbnailer: the bytes come from the mailbox on demand and
              we keep no copy to resize, and a reviewer who needs the detail can
              open the image itself. Plain <img>, not next/image — that wants to
              fetch and cache customer attachments through its own optimiser,
              which is a copy of exactly the data we have gone out of our way
              not to keep. */}
          {pictures.length > 0 && (
            <div className="pictures">
              {pictures.map(picture => (
                <a key={picture.id} href={`/api/attachments/${task.id}/${picture.id}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/attachments/${task.id}/${picture.id}`}
                    alt={picture.filename || t('task.unnamedAttachment')}
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          )}
          {/* Inline images are left out of the file list for the same reason the
              drafter is not told about them: a signature logo is not a file
              anyone sent. They are still rendered above, where being wrong about
              that costs a picture rather than a fact. */}
          {files.length > 0 && (
            <p className="meta" style={{ marginTop: 12 }}>
              {t('task.attachments')}:{' '}
              {files.map((file, i) => (
                <span key={file.id}>
                  {i > 0 ? ', ' : ''}
                  <a href={`/api/attachments/${task.id}/${file.id}`}>
                    {file.filename || t('task.unnamedAttachment')}
                  </a>
                  {file.size > 0 ? ` (${Math.max(1, Math.round(file.size / 1024))} KB)` : ''}
                </span>
              ))}
            </p>
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

        <form className="card stack" action={approveAndSend}>
          <h2>{sent ? t('task.whatWentOut') : t('task.theReply')}</h2>
          <input type="hidden" name="taskId" value={task.id} />
          {/* A textarea, not a text input, for the reason the reason box below
              is one: the first submit button in this form is Send, and a
              single-line input turns Enter into "send this email". Empty means
              the customer's own subject, prefixed with Re: — which is what
              every task had before there was a box here at all. */}
          <textarea
            className="subject-line"
            name="subject"
            rows={1}
            aria-label={t('task.subjectLabel')}
            defaultValue={task.replySubject ?? ''}
            readOnly={sent || sending}
            placeholder={t('task.subjectPlaceholder')}
          />
          {/* The other ways this could have been answered.

              Above the box rather than in a fold below it, and always there
              rather than behind a button, because the choice between approaches
              is one to make *before* reading a draft closely — not after
              deciding the one on screen is wrong. Tab A is the draft itself, so
              one of them is always lit on arrival.

              Submit buttons inside the draft's own form rather than a form
              each: nesting forms is not a thing HTML does, and posting the
              textarea along with the switch is the point rather than a side
              effect — switching keeps whatever is in the box first, so a
              reviewer who edits B, reads C and comes back finds their editing
              in the drafts panel rather than gone. The id is bound to the
              action instead of carried as the button's value; see the note on
              `useAlternative` for why the obvious HTML silently does nothing. */}
          {alternatives.length > 0 && (
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
                  <span className="alt-strategy">{option.strategy || t('task.optionUnlabelled')}</span>
                </button>
              ))}
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
          {/* Draft on the left, translation on the right — same shape as the
              incoming pair above, so the reviewer's eye can compare the reply
              they are approving against the reply the customer will read. */}
          <div className={`compare${outgoing ? '' : ' compare-single'}`}>
            {/* Named, not just prompted. A placeholder is the only label these
                three had, which leaves a screen reader announcing "edit text"
                and leaves everybody else with no label at all the moment they
                start typing — the point at which knowing which box this is
                matters. */}
            <textarea
              className="draft"
              name="draft"
              aria-label={t('task.draftLabel')}
              defaultValue={body}
              readOnly={sent || sending}
              placeholder={t('task.draftPlaceholder')}
            />
            {/* The nearest thing here to a confirmation step: what is going out,
                in a language the reviewer reads. */}
            {outgoing && (
              <details className="translation" open>
                <summary>
                  {sent ? t('task.whatWentOut') : t('task.whatYouAreAboutToSend')} · {outgoing.language}
                </summary>
                <pre className="email">{outgoing.content}</pre>
              </details>
            )}
          </div>
          {language && !outgoing && body.trim() !== '' && (
            <p className="meta">{t('task.noTranslation', { language })}</p>
          )}
          {/* A textarea rather than a text input, and the reason is Enter. In a
              form whose first submit button is Send, a single-line input turns
              the return key into "send this email" — which is the muscle memory
              of everyone who has ever used a chat box, and an irreversible
              action to attach to it. A textarea takes the keystroke itself. */}
          <textarea
            name="notes"
            rows={1}
            aria-label={t('task.notesLabel')}
            defaultValue={task.reviewerNotes ?? ''}
            readOnly={sent || sending}
            placeholder={t('task.notesPlaceholder')}
          />
          {/* In the same form as the draft and the Send button, for the reason
              the draft is: what goes out is what is on screen. The other buttons
              in this form post the files too and ignore them — a wasted upload
              on a Save, and the price of not splitting the one form that must
              not be split. */}
          {!sent && !sending && (
            <label className="meta">
              {t('task.attach')}
              <input type="file" name="files" multiple />
            </label>
          )}
          {!sent && !sending && (
            <div className="actions">
              {sendable && (
                <button className="primary" type="submit">
                  {t('task.approveAndSend')}
                </button>
              )}
              <button type="submit" formAction={saveDraft}>
                {t('task.save')}
              </button>
              <button type="submit" formAction={redraftTask}>
                {t('task.redraft')}
              </button>
              {/* Only where there is something to come back from. A task that is
                  already awaiting review has nowhere to be reopened to. */}
              {(task.status === 'dismissed' || task.status === 'failed') && (
                <button type="submit" formAction={reopenTask}>
                  {t('task.reopen')}
                </button>
              )}
              {/* The reason sits next to the button rather than behind a second
                  click, because a rejection with no explanation teaches nothing
                  and asking afterwards never works. Optional: somebody clearing
                  an email that needed no answer has nothing to explain. */}
              <textarea
                className="reason"
                name="reason"
                rows={1}
                aria-label={t('task.reasonLabel')}
                defaultValue={task.rejectionReason ?? ''}
                placeholder={t('task.reasonPlaceholder')}
              />
              <button className="danger" type="submit" formAction={dismissTask}>
                {t('task.dismiss')}
              </button>
              <span className="meta">{t('task.editsBecomeRules')}</span>
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

        {sent && task.draft && task.draft !== task.finalReply && (
          <div className="card">
            <h2>{t('task.draftYouChanged')}</h2>
            <pre className="email">{task.draft}</pre>
          </div>
        )}

        {/* Everything the draft box used to say. Its own form, outside the one
            above: a restore must not carry the text currently on screen with
            it, and nesting forms is not a thing HTML does. */}
        {versions.length > 0 && (
          <details className="card">
            <summary>{t('task.versions', { n: versions.length })}</summary>
            {versions.map(version => (
              <form action={restoreDraft} key={version.id} style={{ marginTop: 12 }}>
                <input type="hidden" name="taskId" value={task.id} />
                <input type="hidden" name="versionId" value={version.id} />
                <div className="row">
                  <span className="meta grow">
                    {version.createdAt.slice(0, 16).replace('T', ' ')} ·{' '}
                    {t(`task.versionBy.${version.source}`)}
                    {version.notes ? ` · ${version.notes}` : ''}
                  </span>
                  {!sent && !sending && <button type="submit">{t('task.restore')}</button>}
                </div>
                <pre className="email">{version.body}</pre>
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
            <div className="card">
              <h2>{t('task.whatItUnderstood')}</h2>
              <p style={{ marginTop: 0 }}>{task.analysis.intent}</p>
              <p className="meta">
                {task.analysis.language || '?'} ·{' '}
                {t(`task.sentiment.${task.analysis.sentiment}`)}
                {task.analysis.scope ? ` · ${task.analysis.scope}` : ''}
                {/* Left out entirely when nothing is broken. A "cause" on a sales
                    enquiry is a label looking for a fault that was never there. */}
                {task.analysis.cause && task.analysis.cause !== 'not_a_problem'
                  ? ` · ${t(`task.cause.${task.analysis.cause}`)}`
                  : ''}{' '}
                · {t('task.rulesActive', { n: rulesInPlay })}
              </p>
              {task.analysis.keyPoints.length > 0 && (
                <ul>
                  {task.analysis.keyPoints.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              )}
              {task.analysis.suggestedActions.length > 0 && (
                <div className="critique">
                  <strong>{t('task.youMayAlsoNeedTo')}</strong>
                  <ul style={{ margin: '4px 0 0' }}>
                    {task.analysis.suggestedActions.map((action, i) => (
                      <li key={i}>{action}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
