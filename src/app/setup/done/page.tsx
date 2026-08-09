import Link from 'next/link';

import { requirePage } from '@/lib/auth/guard';
import { appName } from '@/lib/brand';
import { t } from '@/lib/i18n';
import { setupState } from '@/lib/setup/state';

import { STARTER_RULES } from '@/lib/rules/starter';
import { listRules } from '@/lib/rules/store';

import { addStarterRules, loadDemo, syncNow } from '../../actions';
import { finishSetup } from '../actions';
import { CronCard } from '../sections';
import { Steps, stepNote, stepTitle } from '../steps';

export const dynamic = 'force-dynamic';

/**
 * The last screen, and the one that has to be honest.
 *
 * A wizard that ends in a green tick regardless of what was skipped teaches
 * the operator to distrust the next tick it shows them. So this lists what is
 * still undone, in the same words the steps used, says what each omission
 * costs, and lets them leave anyway — the password and the voice are genuinely
 * skippable, the model and the mailbox are the desk itself.
 */
export default async function DonePage() {
  await requirePage();
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
      <Steps current="done" />

      <div className="card stack">
        {/* The verdict is this page's name — see the note on the first step. */}
        <h1>{blocked.length > 0 ? t('setup.done.almost') : t('setup.done.ready')}</h1>
        {missing.length === 0 ? (
          <p className="meta">{t('setup.done.allConfigured', { app: appName() })}</p>
        ) : (
          <>
            <p className="meta">{t('setup.done.stillUndone')}</p>
            <ul className="meta" style={{ margin: 0, paddingLeft: 20 }}>
              {missing.map(step => (
                <li key={step.step}>
                  <Link href={step.href}>{stepTitle(step.step)}</Link>
                  {stepNote(step)}
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

      <CronCard />

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
