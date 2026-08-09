import Link from 'next/link';
import type { ReactNode } from 'react';

import { requirePage } from '@/lib/auth/guard';
import { appName } from '@/lib/brand';
import { t } from '@/lib/i18n';
import {
  SETTINGS_PANES,
  isSettingsPane,
  paneHref,
  setupState,
  settingsMode,
  type SettingsPane,
} from '@/lib/setup/state';

import { type Query, one } from './notice';
import {
  AccessSection,
  BillingSection,
  CronCard,
  MailboxSection,
  ModelSection,
  VoiceSection,
  sectionTitle,
} from './sections';
import { Steps, StepNav, stepNote } from './steps';

export const dynamic = 'force-dynamic';

/**
 * Two screens at one address.
 *
 * `/setup` is where a desk is configured, and it is asked that question twice
 * in its life by two different people. The first has just started the server
 * and does not know what the four things are, so they get a wizard: numbered,
 * one subject per page, a forward move at the bottom. The second is the same
 * person a month later who came to change the model, and they get a settings
 * screen: no numbers, no sequence, all four subjects on one page under the
 * screen's own name, each opening with what it is set to rather than with an
 * explanation of what it is. See `settingsMode`.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requirePage();
  const query = await searchParams;

  return settingsMode() ? <Settings query={query} /> : <Wizard query={query} />;
}

/**
 * Step one, and deliberately the password rather than a welcome screen.
 *
 * The window between "the server is up" and "the server has a password" is the
 * only genuinely dangerous state this app has: it is a machine that can read
 * and send someone's mail, on an open port. So the first screen closes that
 * window, and the welcome text is a paragraph on the same page rather than a
 * click in front of it.
 */
function Wizard({ query }: { query: Query }) {
  return (
    <>
      <Steps current="access" />

      <div className="card stack">
        {/* The step's own name, promoted to `h1`: each step of the wizard is a
            page and opened its outline at `h2`. Unchanged visually. */}
        <h1>{t('setup.access.pageTitle', { app: appName() })}</h1>
        <p className="meta">{t('setup.access.intro', { app: appName() })}</p>
        <p className="meta">{t('setup.access.privacy')}</p>
      </div>

      <AccessSection query={query} />

      <StepNav current="access" />
    </>
  );
}

/**
 * Everything the desk was told: a directory on the left, one subject at a time
 * on the right.
 *
 * It was all six subjects down one page with a row of pills at the top that
 * jumped between them. The pills were the honest half of that — they admit the
 * page has parts — and what they could not do is stay put: the moment you
 * pressed one they scrolled off the top with everything else, so the only way
 * from the mailbox to the model was back up through four hundred pixels of
 * somebody else's settings. A menu that does not move is the whole difference,
 * and once it does not move there is no reason for the other five subjects to
 * be under the one you came for.
 *
 * So the pane is a page load rather than a jump — see `paneHref`, and the note
 * there about why a fragment could not survive this. That is one round trip to
 * a server that is already rendering these forms per request, in exchange for a
 * screen whose address says what is on it: `?where=billing` is a link somebody
 * can send a colleague, and `#billing` was a link that landed them at the top.
 *
 * It keeps one habit from the wizard's last page, which is the honest one: what
 * is still unset is named at the top, in the words the sections use, rather than
 * left to be discovered as an empty box behind a menu item nobody clicked.
 */
function Settings({ query }: { query: Query }) {
  const { steps } = setupState();
  const missing = steps.filter(step => !step.done);
  // Which subject is showing, which is also which form a save notice belongs
  // to — one question now, where the long page had two. Anything unrecognised
  // falls to the first pane: a hand-edited `?where=`, or a redirect written
  // before this screen had panes at all, is a screen that opens rather than a
  // screen that is blank.
  const asked = one(query, 'where');
  const here: SettingsPane = isSettingsPane(asked) ? asked : 'access';

  return (
    <>
      {/* Hidden, for the reason the inbox's is — see the note there. */}
      <h1 className="visually-hidden">{t('nav.settings')}</h1>

      {/* Both of these are about the screen rather than about the pane, so they
          sit above the two columns instead of inside the right one — where they
          would be repeated under every one of the six menu items, and the
          "still unset" line would be repeated next to the very setting it was
          complaining about. */}
      <p className="meta settings-intro">{t('settings.intro', { app: appName() })}</p>

      {missing.length > 0 && (
        <p className="banner quiet">
          {t('settings.missing')}{' '}
          {missing.map((step, index) => (
            <span key={step.step}>
              {index > 0 && ' · '}
              <Link href={paneHref(step.step)}>{sectionTitle(step.step)}</Link>
              {stepNote(step)}
            </span>
          ))}
        </p>
      )}

      <div className="settings">
        {/* Six places to be, and nothing else. The long page ended in a link
            back to the inbox, which was worth having at the bottom of four
            hundred pixels of settings; in a menu it is a seventh item competing
            with the six, saying what the first link in the header already says
            on every screen of this application. */}
        <nav className="settings-menu" aria-label={t('settings.jump.aria')}>
          <ul>
            {SETTINGS_PANES.map(pane => (
              <li key={pane}>
                <Link
                  href={paneHref(pane)}
                  className={pane === here ? 'active' : undefined}
                  aria-current={pane === here ? 'page' : undefined}
                >
                  {sectionTitle(pane)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Still `id` and `.setting`: the Test buttons redirect to a fragment
            inside the pane they belong to — `#model-check` — and it is the
            section's own scroll margin that keeps that verdict off the top edge
            of the window. */}
        <section id={here} className="setting settings-pane">
          <Pane here={here} query={query} />
        </section>
      </div>
    </>
  );
}

/**
 * The one subject the menu is pointing at.
 *
 * A switch rather than a lookup table, so that adding a seventh name to
 * `SettingsPane` is a type error here rather than a menu item that renders
 * nothing. Billing takes no `settings` flag because it has no other shape to be
 * in — see `SettingsSection` — and running is a report rather than a form.
 */
function Pane({ here, query }: { here: SettingsPane; query: Query }): ReactNode {
  switch (here) {
    case 'access':
      return <AccessSection query={query} settings />;
    case 'model':
      return <ModelSection query={query} settings />;
    case 'mailbox':
      return <MailboxSection query={query} settings />;
    case 'voice':
      return <VoiceSection query={query} settings />;
    case 'billing':
      return <BillingSection query={query} />;
    case 'running':
      return <CronCard settings />;
  }
}
