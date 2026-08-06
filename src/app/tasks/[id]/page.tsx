import { notFound } from 'next/navigation';

import { requirePage } from '@/lib/auth/guard';
import { listContext } from '@/lib/context/store';
import { getTask } from '@/lib/tasks/store';
import { listRules } from '@/lib/rules/store';

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

  return (
    <>
      <p className="meta">
        <a href="/">← Inbox</a>
      </p>

      {typeof query.error === 'string' && <p className="banner">{query.error}</p>}
      {typeof query.saved === 'string' && <p className="meta">Saved.</p>}
      {typeof query.queued === 'string' && (
        <p className="meta">Redraft queued. Run the queue to pick it up.</p>
      )}

      <div className="card">
        <div className="row">
          <span className="subject grow">{task.subject || '(no subject)'}</span>
          <span className={`tag ${task.status}`}>{task.status.replace('_', ' ')}</span>
        </div>
        <div className="meta">
          {task.fromName ? `${task.fromName} <${task.fromAddress}>` : task.fromAddress}
          {task.receivedAt ? ` · ${task.receivedAt.slice(0, 16).replace('T', ' ')}` : ''}
        </div>
        {task.error && <p className="error">{task.error}</p>}
        <pre className="email" style={{ marginTop: 12 }}>
          {task.body || '(empty body)'}
        </pre>
      </div>

      {task.analysis && (
        <div className="card">
          <h2>What it understood</h2>
          <p style={{ marginTop: 0 }}>{task.analysis.intent}</p>
          <p className="meta">
            {task.analysis.language || '?'} · {task.analysis.sentiment}
            {task.analysis.scope ? ` · ${task.analysis.scope}` : ''} · {rulesInPlay} rules active
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
              <strong>You may also need to:</strong>
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
                Open ↗
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
        <h2>{sent ? 'What went out' : 'The reply'}</h2>
        <input type="hidden" name="taskId" value={task.id} />
        <textarea
          className="draft"
          name="draft"
          defaultValue={body}
          readOnly={sent}
          placeholder="No draft yet. Run the queue, or write one here."
        />
        <input
          type="text"
          name="notes"
          defaultValue={task.reviewerNotes ?? ''}
          readOnly={sent}
          placeholder="Why you changed it — optional, and it goes to the rule extractor"
        />
        {!sent && (
          <div className="actions">
            <button className="primary" type="submit">
              Approve &amp; send
            </button>
            <button type="submit" formAction={saveDraft}>
              Save
            </button>
            <button type="submit" formAction={redraftTask}>
              Redraft
            </button>
            <button className="danger" type="submit" formAction={dismissTask}>
              Dismiss
            </button>
            <span className="meta">Edits here become rules once it is sent.</span>
          </div>
        )}
        {sent && task.sentAt && (
          <p className="meta">Sent {task.sentAt.slice(0, 16).replace('T', ' ')}.</p>
        )}
      </form>

      {sent && task.draft && task.draft !== task.finalReply && (
        <div className="card">
          <h2>The draft you changed</h2>
          <pre className="email">{task.draft}</pre>
        </div>
      )}
    </>
  );
}
