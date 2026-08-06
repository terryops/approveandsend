import { notFound } from 'next/navigation';
import { after } from 'next/server';

import { requirePage } from '@/lib/auth/guard';
import { listContext } from '@/lib/context/store';
import { t } from '@/lib/i18n';
import { getOperator } from '@/lib/operators/store';
import { listAttachments } from '@/lib/tasks/attachments';
import { listEvents } from '@/lib/tasks/events';
import { listMessages } from '@/lib/tasks/messages';
import { getTask, markOpened } from '@/lib/tasks/store';
import { listRules } from '@/lib/rules/store';
import { getTranslation } from '@/lib/translation/store';
import { reviewLanguage } from '@/lib/translation/translate';

import { approveAndSend, dismissTask, redraftTask, reopenTask, saveDraft } from '../../actions';

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
  const sender = task.sentBy ? getOperator(task.sentBy) : null;
  const body = task.finalReply ?? task.draft ?? '';
  const rulesInPlay = listRules({ enabledOnly: true }).length;
  const context = listContext(task.id);
  const thread = listMessages(task.id);
  const files = listAttachments(task.id).filter(file => !file.inline);

  // Only ever the translation of exactly what is rendered below it. A draft
  // regenerated since its translation was written shows none, because a
  // reviewer who cannot read the reply cannot notice the two have drifted.
  const language = reviewLanguage();
  const bodyText = task.body || '';
  const incoming = language ? getTranslation(task.id, 'body', bodyText, language) : null;
  const outgoing = language ? getTranslation(task.id, 'draft', body, language) : null;

  // Names, not ids, and resolved once each — a task drafted and edited six
  // times by the same person is six rows pointing at one operator.
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
        <a href="/">{t('task.backToInbox')}</a>
      </p>

      {typeof query.error === 'string' && <p className="banner">{query.error}</p>}
      {typeof query.saved === 'string' && <p className="meta">{t('task.saved')}</p>}
      {typeof query.queued === 'string' && (
        <p className="meta">{t('task.redraftQueued')}</p>
      )}

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
          {task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
          {task.receivedAt ? ` · ${task.receivedAt.slice(0, 16).replace('T', ' ')}` : ''}
        </div>
        {task.error && <p className="error">{task.error}</p>}
        <pre className="email" style={{ marginTop: 12 }}>
          {task.body || t('task.emptyBody')}
        </pre>
        {/* `details`, so it is open by default and collapsible without a line
            of JavaScript — the same constraint the rest of this UI works to. */}
        {incoming && (
          <details className="translation" open>
            <summary>
              {t('task.translation')} · {incoming.language}
            </summary>
            <pre className="email">{incoming.content}</pre>
          </details>
        )}
        {/* Inline images are left out for the same reason the drafter is not
            told about them: a signature logo is not a file anyone sent. */}
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

      {task.analysis && (
        <div className="card">
          <h2>{t('task.whatItUnderstood')}</h2>
          <p style={{ marginTop: 0 }}>{task.analysis.intent}</p>
          <p className="meta">
            {task.analysis.language || '?'} · {t(`task.sentiment.${task.analysis.sentiment}`)}
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
        <textarea
          className="draft"
          name="draft"
          defaultValue={body}
          readOnly={sent}
          placeholder={t('task.draftPlaceholder')}
        />
        {/* The nearest thing here to a confirmation step: what you are about
            to send, in a language you read. */}
        {outgoing && (
          <details className="translation" open>
            <summary>
              {sent ? t('task.whatWentOut') : t('task.whatYouAreAboutToSend')} · {outgoing.language}
            </summary>
            <pre className="email">{outgoing.content}</pre>
          </details>
        )}
        {language && !outgoing && body.trim() !== '' && (
          <p className="meta">{t('task.noTranslation', { language })}</p>
        )}
        <input
          type="text"
          name="notes"
          defaultValue={task.reviewerNotes ?? ''}
          readOnly={sent}
          placeholder={t('task.notesPlaceholder')}
        />
        {!sent && (
          <div className="actions">
            <button className="primary" type="submit">
              {t('task.approveAndSend')}
            </button>
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
            <input
              type="text"
              className="reason"
              name="reason"
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
    </>
  );
}
