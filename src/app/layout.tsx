import type { Metadata } from 'next';
import { Inter, Source_Serif_4 } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { appName } from '@/lib/brand';
import { hasSession, isAdmin } from '@/lib/auth/guard';
import { isProtected } from '@/lib/auth/session';
import { THEMES, theme, themeAttribute } from '@/lib/desk/theme';
import { LOCALES, locale, localePinned, resolveRequestLocale, t, type MessageKey } from '@/lib/i18n';
import { settingsMode } from '@/lib/setup/state';
import { reviewLayout } from '@/lib/tasks/layout';

import { logout, setInterfaceLanguage, setReviewLayout, setTheme } from './actions';
import { ReturnTo, ReviewingTaskId, WhileReviewing } from './here';
import { NavLinks } from './nav';
import { CarryDraft } from './tasks/[id]/review-keys';
import { WorkingStrip } from './working';

import './globals.css';

/**
 * The two faces this desk brings with it, and the reason it brings any.
 *
 * Everything else here is a system font, which is free, instant and different on
 * every machine — the same screen is SF Pro on a Mac, Segoe on Windows and
 * whatever the distribution picked on Linux, and the last of those three is where
 * "looks like an internal tool" comes from. Two files fix the Latin half of that
 * for everybody. The CJK half stays on the system faces on purpose: the matching
 * companions here are Source Han Serif and Source Han Sans, which are megabytes
 * per weight, and a support desk cannot subset ahead of time for text a stranger
 * has not written yet.
 *
 * `next/font` downloads both at build time and serves them from this origin, so
 * a running install makes no request to Google and works with no internet at all
 * — which matters more here than usual, because this thing is self-hosted next to
 * somebody's mailbox.
 *
 * Variable rather than a list of weights: the stylesheet asks for 550 and 650 in
 * a dozen places and those are real weights on a variable face, where on a static
 * one they round to the nearest of four.
 *
 * `variable` rather than `className`, because these are two fonts doing two jobs
 * and the stylesheet decides which lands where. `className` would set
 * `font-family` on `<html>` and settle it here instead.
 */
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-inter',
  display: 'swap',
});

/**
 * The reading face, for the mail and nothing else.
 *
 * A serif for the letter and the reply, a sans for the application around them —
 * so the two are told apart by their type before either is read, which is the
 * half of "where do I look first" that size alone was doing on its own.
 *
 * Source Serif is a screen serif rather than a book one: low contrast, sturdy
 * stems, a large x-height, and it holds together at 16px on a bad monitor where
 * a Didone would break up into hairlines. Italic is included because a customer
 * quoting a product name gets one.
 */
const serif = Source_Serif_4({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-serif',
  display: 'swap',
});

/**
 * Generated rather than declared, because both halves of it are now settings.
 * A `const metadata` is evaluated once when the module is first loaded, so the
 * tab kept whatever name and language the process happened to start with —
 * renaming the desk in the wizard left the browser tab saying the old one until
 * somebody restarted the server.
 */
export async function generateMetadata(): Promise<Metadata> {
  await resolveRequestLocale();
  return { title: appName(), description: t('brand.tagline') };
}

/**
 * The seven places the header can send you, in the order they are shown.
 *
 * Writing a new email is not among them, and that is the one entry here that is
 * an action rather than a place. Every other link answers "where do I go"; that
 * one answered "what do I do next", asked on every screen of the app by a header
 * that has no idea what you are in the middle of. It is on the inbox now, beside
 * the button that pulls mail in — the two things you can do to the desk itself,
 * on the screen the desk is about. `/compose` is still lit through the inbox's
 * `also` list, so the header does not go blank while you are writing one.
 */
/**
 * The last four are marked `admin`, and a reviewer without the flag is not
 * shown them at all rather than shown them greyed out.
 *
 * Greying out is the right answer when the thing is yours and is currently
 * unavailable — a Send button on an empty draft. It is the wrong answer here:
 * these four are not going to become available by waiting, and a permanent row
 * of dead words at the top of every screen is four daily reminders of a
 * conversation the reader cannot have with the interface. What they can see is
 * the whole of what they can do.
 *
 * The nav is the courtesy; `requireAdminPage` on each of those pages is the
 * check. Nothing here is load-bearing — a hidden link is still a link somebody
 * can type.
 */
const NAV: { href: string; label: MessageKey; also?: string[]; admin?: true }[] = [
  // A task and a sender both belong to the inbox: you got there from it, and
  // Back goes to it. Nothing in the nav says "task", so without this the header
  // goes blank exactly where a reviewer spends most of their day.
  { href: '/', label: 'nav.inbox', also: ['/tasks', '/senders', '/billing', '/compose'] },
  { href: '/rules', label: 'nav.rules' },
  { href: '/catalog', label: 'nav.catalog' },
  { href: '/backfill', label: 'nav.archive', admin: true },
  { href: '/queue', label: 'nav.queue', admin: true },
  { href: '/operators', label: 'nav.operators', admin: true },
  { href: '/setup', label: 'nav.setup', admin: true },
];

// `isHere` moved to `nav.tsx`, where the pathname it needs is the live one. See
// the note there: a root layout does not re-render on navigation, so anything
// decided from `headers()` up here is decided once per document load.

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Before the first `t()` on the page, and the reason this is async: an
  // install that has not chosen an interface language yet takes the browser's,
  // and `Accept-Language` can only be read from an async context.
  await resolveRequestLocale();
  // Nothing here reads the path any more, for one reason: this function does not
  // run again when you navigate, so what it knows is what was true when the
  // document loaded. Every consumer has moved into a client component — see
  // `nav.tsx` and `here.tsx` — and `proxy.ts`, which existed only to forward the
  // path on `x-pathname` for the reader that used to be up here, has gone with
  // them rather than stay as a header set on every request that nothing reads.

  // Everything past the name is for somebody who is already in.
  //
  // This header is rendered by the root layout, so it wraps the login page too,
  // and it was printing "Sent 7 today · learned 2 rules" and the state of the
  // queue above the password box — readable by anyone who could reach the port,
  // which is the whole of the population `isProtected()` exists to worry about.
  // The nav and the language menu came along for the same ride, and the menu was
  // worse than useless there: every one of its forms posts to an action that
  // opens with `requireApi()`, so choosing a language while logged out raised an
  // error instead of switching. Signed out, this is a name and a tagline.
  const signedIn = await hasSession();
  // Which half of the nav this person gets. Read once here rather than in
  // `NavLinks`, which is a client component and has no database to ask.
  const admin = await isAdmin();
  // The switch belongs to the review screen, so it is rendered only there — but
  // it is a header control, because it governs the whole screen and has to be
  // reachable from the top of a long task. Which screen that is gets decided in
  // `LayoutSwitch`, for the same reason as everything else on this list.
  const layout = await reviewLayout();
  const here = locale();
  // Read even when signed out. The switch is not offered on the login page —
  // nothing up there is — but the palette still has to be the one this reader
  // chose, or signing in flips the screen at them.
  const chosen = await theme();
  // The last item in the nav is one address wearing two names. While `/setup`
  // is still a wizard it is called what it is; once it is a settings screen,
  // calling it Setup sends people looking for a screen they have already used.
  const configured = signedIn && settingsMode();

  return (
    // Rendered into the markup rather than set by a script once the page is up.
    // A theme applied after first paint is a white flash on a dark desk, every
    // navigation, and this app has no client state to apply it from anyway.
    //
    // Both font variables land on `<html>`, where `globals.css` composes them
    // into the stacks — see `--font-latin` and `--font-read`. Neither class sets
    // a `font-family` by itself.
    <html
      lang={here}
      data-theme={themeAttribute(chosen)}
      className={`${inter.variable} ${serif.variable}`}
    >
      <body>
        {/* Above everything, and outside the shell, because what it reports is
            not about the screen underneath it: a draft kicked off on one task
            lands while the reviewer is three tasks further on. Words translated
            here — the dictionary is server-only, so a client component gets
            sentences rather than keys. */}
        {signedIn && (
          <WorkingStrip
            labels={{
              busy: t('working.busy'),
              ready: t('working.ready'),
              open: t('working.open'),
              dismiss: t('working.dismiss'),
            }}
          />
        )}
        <div className="shell">
          <header className="top">
            {/* The name is the way home. It is the first thing in the header on
                every screen, it is what people already reach for out of habit
                from every other application they use, and it was the one thing
                up here that did nothing at all. */}
            <Link className="brand" href="/">
              {appName()}
            </Link>
            {/* The slogan, on the one screen with room for a slogan.

                It used to be here on every screen and hidden by a media query
                below 1560px, which was an honest attempt at a promise the header
                cannot keep: `.shell` stops at 1360px however wide the window
                gets, and inside 1360 the name, seven links, the layout switch
                and the desk already leave nothing. All the breakpoint bought was
                a slogan that appeared on a big monitor by pushing the controls
                onto a second line.

                Signed out there is nothing else up here at all, and it is also
                the one moment somebody might not yet know what this is. */}
            {!signedIn && <span className="tagline">{t('brand.tagline')}</span>}
            {signedIn && (
              <nav>
                {/* Translated here, lit there. The words are a server-only lookup
                    and never change while you are on a screen; which one is lit
                    changes on every navigation, and this component has stopped
                    re-rendering by then. See `nav.tsx`. */}
                <NavLinks
                  items={NAV.filter(item => admin || !item.admin).map(item => ({
                    href: item.href,
                    label: t(configured && item.href === '/setup' ? 'nav.settings' : item.label),
                    ...(item.also ? { also: item.also } : {}),
                  }))}
                />
              </nav>
            )}

            {/* Everything to the right of the nav, in one group and in one
                order: how this screen is arranged, what the desk is doing, what
                you can tell it to do, and the drawer holding what you set once
                and then leave alone.

                Only the drawer is on every screen. The middle two belong to the
                inbox and the first to a task, so most screens carry a wordmark,
                seven links and a `⋯` — which is what a header should cost a
                screen that is about something else.

                It was eight things in a flat row — seven links, a language menu,
                a three-way theme switch, a status pill and three outlined
                buttons — all at the same size and all equally loud, so the
                header read as a hedge of chips with no way in. Nothing here has
                been taken away; it has been sorted by how often a hand actually
                lands on it. See `.desk` in globals.css. */}
            {signedIn && (
              <div className="desk">
                {/* Columns or side by side, at the top of the screen it governs.

                    Rendered by a client component, and that is not a preference
                    — it is the only way it can be correct. Which screen you are
                    on is the whole of its condition, and this layout stopped
                    re-rendering the moment the document finished loading: the
                    switch appeared when a task was loaded directly and never
                    when one was clicked into, which is how a reviewer actually
                    opens one. See `here.tsx`.

                    Inside this group rather than beside it, because the group is
                    where the auto margin is: left out on its own it was the one
                    control in the header with nothing holding it to either end,
                    and it drifted into the middle of the row on the exact screen
                    — a long task — where the header has the least attention to
                    spare.

                    Its own form, outside the draft — so `CarryDraft` copies the
                    boxes across before it posts. It creates those fields as well
                    as filling them, and there are deliberately none in the
                    markup here: an empty `draft` in this POST is
                    indistinguishable from a draft somebody cleared, and
                    `keepEdits` would write it. */}
                <WhileReviewing>
                  <div className="layout-switch" role="group" aria-label={t('task.layout.label')}>
                    {(['columns', 'compare'] as const).map(option => (
                      <form action={setReviewLayout.bind(null, option)} key={option}>
                        <CarryDraft />
                        <ReviewingTaskId />
                        <button
                          type="submit"
                          className={layout === option ? 'active' : undefined}
                          aria-current={layout === option ? 'true' : undefined}
                          title={t(`task.layout.hint.${option}`)}
                        >
                          {t(`task.layout.${option}`)}
                        </button>
                      </form>
                    ))}
                  </div>
                </WhileReviewing>

                {/* The desk's own state and the two buttons that drive it are
                    not here any more; they are on the inbox, which is the screen
                    they were already gated to.

                    Gating them here needed a client component, because this
                    function does not run again when you navigate — and the gate
                    only ever hid the markup. The four counts behind it ran on
                    every render of every screen and were thrown away on all but
                    one of them, and on that one they were whatever had been true
                    when the document loaded: send five replies by soft
                    navigation and the header still reported the count from when
                    the tab was opened. Signing out is in the drawer below for
                    the same reason it was moved there — it is the end of the
                    day, not work. */}

                {/* The drawer: the palette, the language, and the way out.

                    All three are settings in the sense that matters here — you
                    touch them on your first afternoon and then not again for
                    weeks — and all three were spending header width every minute
                    of every day to say so. A `details` costs one click to open
                    and nothing at all to ignore.

                    Still no client state and still no script: a disclosure and a
                    form per option is plain HTML that submits itself, which is
                    the same reason the language menu was a `details` when it
                    lived out in the nav. */}
                <details className="desk-menu">
                  <summary title={t('chrome.more')} aria-label={t('chrome.more')}>
                    <span aria-hidden="true">⋯</span>
                  </summary>
                  <div className="desk-drawer">
                    {/* Light, dark, or the machine's answer.

                        A form per option rather than one button that cycles:
                        three states do not cycle in an order anybody can
                        predict, and a control whose label is its *next* state is
                        a control you have to press to read. Three labels, one of
                        them lit. */}
                    <p className="drawer-label">{t('chrome.theme')}</p>
                    <div className="theme-switch" role="group" aria-label={t('chrome.theme')}>
                      {THEMES.map(option => (
                        <form action={setTheme.bind(null, option)} key={option}>
                          <ReturnTo />
                          <button
                            type="submit"
                            className={chosen === option ? 'active' : undefined}
                            aria-current={chosen === option ? 'true' : undefined}
                            title={t(`chrome.theme.hint.${option}`)}
                          >
                            {t(`chrome.theme.${option}`)}
                          </button>
                        </form>
                      ))}
                    </div>

                    {/* The language, changed where it is read rather than four
                        screens into the wizard.

                        Unless `AAS_LANGUAGE` has already decided — see
                        `localePinned`. Then it is a label, because a menu that
                        writes the file and comes back in the same language reads
                        as a broken control rather than as a setting being
                        overruled. */}
                    <p className="drawer-label">{t('chrome.language')}</p>
                    {localePinned() ? (
                      <p className="drawer-pinned" title={t('chrome.languagePinned')}>
                        {LOCALES[here]}
                      </p>
                    ) : (
                      <div className="drawer-langs">
                        {(Object.keys(LOCALES) as (keyof typeof LOCALES)[]).map(tag => (
                          <form action={setInterfaceLanguage.bind(null, tag)} key={tag}>
                            <ReturnTo />
                            <button
                              type="submit"
                              className={tag === here ? 'active' : undefined}
                              aria-current={tag === here ? 'true' : undefined}
                            >
                              {LOCALES[tag]}
                            </button>
                          </form>
                        ))}
                      </div>
                    )}

                    <form action={logout} className="drawer-out">
                      <button type="submit">{t('inbox.signOut')}</button>
                    </form>
                  </div>
                </details>
              </div>
            )}
          </header>
          {!isProtected() && (
            <p className="banner">
              <strong>{t('brand.unprotectedLabel')}</strong> {t('brand.unprotectedLead')}{' '}
              <code>ADMIN_PASSWORD</code> {t('brand.unprotectedRest')}{' '}
              {/* The full stop is a message rather than a character in the
                  markup, and it is the only one on this banner that was not.
                  Japanese and Chinese end a sentence with 。, so a hard-coded
                  `.` put a Latin dot against a Japanese verb on every screen
                  of an install with no password — the one banner nobody can
                  dismiss. Every other split sentence in this app already keeps
                  its tail in the dictionary; see `setup.done.comeBackAfter`,
                  which is a full stop in four languages and half a clause in
                  the other two. */}
              <Link href="/setup">{t('brand.unprotectedSetOne')}</Link>
              {t('brand.unprotectedEnd')}
            </p>
          )}
          {children}
        </div>
      </body>
    </html>
  );
}
