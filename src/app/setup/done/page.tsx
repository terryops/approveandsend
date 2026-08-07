import { APP_NAME } from '@/lib/brand';
import { t, type MessageKey } from '@/lib/i18n';
import { setupState, type SetupStep } from '@/lib/setup/state';

import { STARTER_RULES } from '@/lib/rules/starter';
import { listRules } from '@/lib/rules/store';

import { addStarterRules, loadDemo, syncNow } from '../../actions';
import { finishSetup } from '../actions';

export const dynamic = 'force-dynamic';

/** The step titles live in the dictionary, keyed by step id. */
const NAV_TITLES: Record<SetupStep, MessageKey> = {
  access: 'setup.nav.access',
  model: 'setup.nav.model',
  mailbox: 'setup.nav.mailbox',
  voice: 'setup.nav.voice',
};

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
  // Offered only while there is nothing to overwrite. Somebody who reaches
  // /setup again on a working desk does not need to be asked about this.
  // Proposals count as something to overwrite: a desk with suggestions waiting
  // has a rulebook, even if nobody has approved any of it yet.
  const rulebookEmpty = listRules({ proposed: 'include' }).length === 0;

  return (
    <>
      <div className="card stack">
        <h2>{blocked.length > 0 ? t('setup.done.almost') : t('setup.done.ready')}</h2>
        {missing.length === 0 ? (
          <p className="meta">{t('setup.done.allConfigured', { app: APP_NAME })}</p>
        ) : (
          <>
            <p className="meta">{t('setup.done.stillUndone')}</p>
            <ul className="meta" style={{ margin: 0, paddingLeft: 20 }}>
              {missing.map(step => (
                <li key={step.step}>
                  <a href={step.href}>{t(NAV_TITLES[step.step])}</a>
                  {step.optional ? t('setup.done.optional') : t('setup.done.required')}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {rulebookEmpty && (
        <div className="card stack">
          <h2>{t('setup.starter.title')}</h2>
          <p className="meta">{t('setup.starter.body', { n: STARTER_RULES.length })}</p>
          <form action={addStarterRules}>
            <input type="hidden" name="next" value="setup" />
            <button type="submit">{t('setup.starter.button')}</button>
          </form>
        </div>
      )}

      <div className="card stack">
        <h2>{t('setup.done.cronTitle')}</h2>
        <p className="meta">
          {t('setup.done.cronBefore')} <code>CRON_TOKEN</code> {t('setup.done.cronMiddle')}{' '}
          <code>.env</code>
          {t('setup.done.cronAfter')}
        </p>
        <pre className="block">
          {'*/5 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sync\n' +
            '*/2 * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/worker\n' +
            '17  * * * * curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sweep\n' +
            '30 4 * * 1  curl -sX POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/consolidate'}
        </pre>
      </div>

      <div className="row">
        <form action={finishSetup}>
          <button type="submit">{t('setup.done.goToInbox')}</button>
        </form>
        {blocked.length === 0 && (
          <form action={syncNow}>
            <button type="submit">{t('setup.done.fetchMail')}</button>
          </form>
        )}
        {state.untouched && (
          <form action={loadDemo}>
            <button type="submit">{t('setup.done.loadSample')}</button>
          </form>
        )}
        <span className="grow meta">
          {t('setup.done.comeBackBefore')} <code>/setup</code>
          {t('setup.done.comeBackAfter')}
        </span>
      </div>
    </>
  );
}
