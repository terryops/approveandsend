import { APP_NAME } from '@/lib/brand';
import { setupState } from '@/lib/setup/state';

import { loadDemo, syncNow } from '../../actions';
import { finishSetup } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The last screen, and the one that has to be honest.
 *
 * A wizard that ends in a green tick regardless of what was skipped teaches
 * the operator to distrust the next tick it shows them. So this lists what is
 * still undone, in the same words the steps used, and lets them leave anyway —
 * a mailbox is genuinely optional if you only want to try the rulebook.
 */
export default async function DonePage() {
  const state = setupState();
  const missing = state.steps.filter(step => !step.done);
  const blocked = missing.filter(step => !step.optional);

  return (
    <>
      <div className="card stack">
        <h2>{blocked.length > 0 ? 'Almost' : 'Ready'}</h2>
        {missing.length === 0 ? (
          <p className="meta">
            Everything is configured. Fetch your mail and {APP_NAME} will draft a reply to each new
            message — the drafts wait for you, and nothing is sent without a click.
          </p>
        ) : (
          <>
            <p className="meta">Still undone:</p>
            <ul className="meta" style={{ margin: 0, paddingLeft: 20 }}>
              {missing.map(step => (
                <li key={step.step}>
                  <a href={step.href}>{step.title}</a>
                  {step.optional ? ' — optional' : ' — needed before anything can be drafted'}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card stack">
        <h2>Keep it running</h2>
        <p className="meta">
          Both buttons on the inbox have a cron equivalent, so a real install does not need anyone
          clicking. The token was generated when you set the password; it is <code>CRON_TOKEN</code>{' '}
          in your <code>.env</code>.
        </p>
        <pre className="snippet">
          {'*/5 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sync\n' +
            '*/2 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/worker\n' +
            '30 4 * * 1  curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/consolidate'}
        </pre>
      </div>

      <div className="row">
        <form action={finishSetup}>
          <button type="submit">Go to the inbox</button>
        </form>
        {blocked.length === 0 && (
          <form action={syncNow}>
            <button type="submit">Fetch mail now</button>
          </form>
        )}
        {state.untouched && (
          <form action={loadDemo}>
            <button type="submit">Load sample data instead</button>
          </form>
        )}
        <span className="grow meta">
          You can come back to any of this at <code>/setup</code>.
        </span>
      </div>
    </>
  );
}
