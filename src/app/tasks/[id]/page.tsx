import { notFound } from 'next/navigation';

import { requirePage } from '@/lib/auth/guard';
import { listContext } from '@/lib/context/store';
import { t } from '@/lib/i18n';
import { getTask } from '@/lib/tasks/store';
import { listRules } from '@/lib/rules/store';
import { getTranslation } from '@/lib/translation/store';
import { reviewLanguage } from '@/lib/translation/translate';

import { approveAndSend, dismissTask, redraftTask, saveDraft } from '../../actions';

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

  const sent = task.status === 'sent';
  const body = task.finalReply ?? task.draft ?? '';
  const rulesInPlay = listRules({ enabledOnly: true }).length;
  const context = listContext(task.id);

  // Only ever the translation of exactly what is rendered below it. A draft
  // regenerated since its translation was written shows none, because a
  // reviewer who cannot read the reply cannot notice the two have drifted.
  const language = reviewLanguage();
  const bodyText = task.body || '';
  const incoming = language ? getTranslation(task.id, 'body', bodyText, language) : null;
  const outgoing = language ? getTranslation(task.id, 'draft', body, language) : null;

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

      <div className="card">
        <div className="row">
          <span className="subject grow">{task.subject || t('task.noSubject')}</span>
          <span className={`tag ${task.status}`}>{t(`task.status.${task.status}`)}</span>
        </div>
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
      </div>

      {task.analysis && (
        <div className="card">
          <h2>{t('task.whatItUnderstood')}</h2>
          <p style={{ marginTop: 0 }}>{task.analysis.intent}</p>
          <p className="meta">
            {task.analysis.language || '?'} · {t(`task.sentiment.${task.analysis.sentiment}`)}
            {task.analysis.scope ? ` · ${task.analysis.scope}` : ''} ·{' '}
            {t('task.rulesActive', { n: rulesInPlay })}
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
            <button className="danger" type="submit" formAction={dismissTask}>
              {t('task.dismiss')}
            </button>
            <span className="meta">{t('task.editsBecomeRules')}</span>
          </div>
        )}
        {sent && task.sentAt && (
          <p className="meta">
            {t('task.sentAt', { time: task.sentAt.slice(0, 16).replace('T', ' ') })}
          </p>
        )}
      </form>

      {sent && task.draft && task.draft !== task.finalReply && (
        <div className="card">
          <h2>{t('task.draftYouChanged')}</h2>
          <pre className="email">{task.draft}</pre>
        </div>
      )}
    </>
  );
}
