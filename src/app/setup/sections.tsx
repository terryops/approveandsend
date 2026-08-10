import Link from 'next/link';

import { ENDPOINTS, endpointFor } from '@/lib/ai/endpoints';
import { isCliKind, type CliKind } from '@/lib/ai/providers/cli';
import { isProtected } from '@/lib/auth/session';
import { stripeKey, stripeMode, stripeOn, stripeRestricted } from '@/lib/billing/stripe';
import { DEFAULT_APP_NAME } from '@/lib/brand';
import { getWorkspaceConfig, describeWorkspace } from '@/lib/config/workspace';
import { automation, type Scheduled, type ScheduledJob } from '@/lib/desk/automation';
import { LOCALES, locale, t, type MessageKey } from '@/lib/i18n';
import { MAIL_HOSTS, serviceFor, ZOHO_API_SERVICE } from '@/lib/mail/hosts';
import { ZOHO_REGIONS, ZOHO_SCOPES } from '@/lib/mail/providers/zoho/auth';
import { countActiveOperators } from '@/lib/operators/store';
import { detectClis, type CliStatus } from '@/lib/setup/cli-detect';
import { envFilePath } from '@/lib/setup/env-file';
import { type SettingsPane } from '@/lib/setup/state';
import { workspaceFilePath } from '@/lib/setup/workspace-file';

import {
  saveAccess,
  saveFirstOperator,
  saveMailbox,
  saveModel,
  saveStripe,
  saveVoice,
  testMailbox,
  testModel,
  testStripe,
  useSubscription,
} from './actions';
import { MailboxFields } from './mailbox-fields';
import { ModelFields } from './model-fields';
import { LastCheck, Notice, type Query } from './notice';

/**
 * The four subjects, written once and worn twice.
 *
 * A step of the wizard and a section of the settings screen are the same form
 * over the same fields; what differs is everything around it. The wizard is one
 * of these per page, under a numbered strip, headed by an `h1` and opened by a
 * paragraph explaining what the thing even is. The settings screen is all of
 * them down one page, each an `h2` under the screen's own name, and opened by a
 * line saying what it is set to right now — because somebody who came back to
 * this screen already knows what a model is and is asking which one is loaded.
 *
 * Hence the one prop. `settings` is not a style flag: it picks the heading
 * level, the opening line, and — on access — whether the second form is here at
 * all, since managing people has its own screen once there are people.
 */
interface SectionProps {
  /** The query string of the page this section is on; drives the save notice. */
  query: Query;
  /** True on the settings screen, false in the wizard. */
  settings?: boolean;
}

/**
 * What a subject is called on the settings screen.
 *
 * Not what the wizard calls it. Its four names are instructions — lock the
 * door, pick a model, say who you are — which is the right mood for a step,
 * because a step is a thing you are being asked to do. A section of a settings
 * screen is a thing that is already the case, and heading it with an order
 * reads as being told to redo something you finished a month ago.
 */
const SECTION: Record<SettingsPane, MessageKey> = {
  access: 'settings.nav.access',
  model: 'settings.nav.model',
  mailbox: 'settings.nav.mailbox',
  voice: 'settings.nav.voice',
  billing: 'settings.nav.billing',
  running: 'settings.nav.running',
};

/** One section's name, in the language of the person reading it. */
export function sectionTitle(pane: SettingsPane): string {
  return t(SECTION[pane]);
}

/**
 * Locking the door, both ways it locks.
 *
 * In the wizard the second form is the better half of the step: a name on a
 * reply is worth more than a shared password, and it is offered here rather
 * than left on a screen nobody visits until something has gone wrong. On the
 * settings screen it is a duplicate of `/operators`, which does the same job
 * and three more, so it becomes a sentence pointing there.
 */
export function AccessSection({ query, settings = false }: SectionProps) {
  const locked = isProtected();
  const named = countActiveOperators();

  return (
    <>
      <Notice query={query} path={envFilePath()} />

      {/* The only section whose heading is an `h2` in both shapes: in the
          wizard the `h1` above it is the welcome, which this step carries
          instead of a title of its own. */}
      <form className="card stack" action={saveAccess}>
        <h2>{settings ? sectionTitle('access') : t('setup.access.title')}</h2>
        <p className="meta">{locked ? t('setup.access.hasPassword') : t('setup.access.noPassword')}</p>
        {/* Named, and the eight characters said as an aside rather than as the
            name of the box. A placeholder is the label somebody stops having the
            moment they start typing — the argument the review screen's notes
            field lost, made everywhere on this screen. */}
        <label>
          {t('setup.access.passwordLabel')} <span className="hint">{t('setup.access.passwordPlaceholder')}</span>
          <input type="password" name="password" autoComplete="new-password" />
        </label>
        <div className="row">
          <span className="grow meta">
            {t('setup.access.cronTokenBefore')} <code>CRON_TOKEN</code>{' '}
            {t('setup.access.cronTokenAfter')}
          </span>
          <button type="submit">
            {locked ? t('setup.access.replaceButton') : t('setup.access.setButton')}
          </button>
        </div>
      </form>

      {settings ? (
        <p className="meta">
          {named > 0 ? t('settings.access.named', { n: named }) : t('settings.access.nobodyNamed')}{' '}
          <Link href="/operators">{t('settings.access.people')}</Link>
        </p>
      ) : (
        <form className="card stack" action={saveFirstOperator}>
          <h2>{t('setup.access.operatorTitle')}</h2>
          <p className="meta">
            {named > 0
              ? t('setup.access.operatorSome', { n: named })
              : t('setup.access.operatorNone')}
          </p>
          <label>
            {t('setup.access.operatorNamePlaceholder')}
            <input type="text" name="name" autoComplete="off" />
          </label>
          <label>
            {t('setup.access.operatorPasswordLabel')}{' '}
            <span className="hint">{t('setup.access.operatorPasswordPlaceholder')}</span>
            <input type="password" name="password" autoComplete="new-password" />
          </label>
          <div className="row">
            <span className="grow meta">{t('setup.access.operatorNote')}</span>
            <button type="submit">{t('setup.access.operatorButton')}</button>
          </div>
        </form>
      )}
    </>
  );
}

/** The one required subject: without a model there is nothing to draft with. */
/**
 * What each CLI calls itself. Proper nouns, so they are not in the dictionary —
 * "Codex" is Codex in all six languages, and a key for it would only invite
 * somebody to translate it.
 */
const CLI_NAMES: Record<CliKind, string> = { claude: 'Claude Code', codex: 'Codex' };

/** The state of a login, as the sentence under its name. */
function describeCli(status: CliStatus): string {
  switch (status.state) {
    case 'ready':
      // The plan word comes from the CLI — `max`, `ChatGPT` — and is the part
      // worth reading, because it is what says this is a seat and not a bill.
      return status.account
        ? t('setup.model.cliReady', {
            account: status.account,
            plan: status.plan ?? CLI_NAMES[status.kind],
          })
        : t('setup.model.cliReadyAnon', { plan: status.plan ?? CLI_NAMES[status.kind] });
    case 'api-key':
      return t('setup.model.cliApiKey');
    case 'logged-out':
      return t('setup.model.cliLoggedOut');
    case 'missing':
      return t('setup.model.cliMissing');
  }
}

/**
 * The same three words, in the two places the answer belongs.
 *
 * The screen went looking and found something; until now it said so only in a
 * card at the bottom, while the menu at the top listed both CLIs as if the
 * choice between them were a matter of taste. So the verdict is a badge on the
 * offer *and* the tail of the menu line, from one function — the alternative
 * being a page that says "detected" in one place and offers "Claude
 * subscription" in the other with nothing connecting them.
 */
function cliVerdict(state: CliStatus['state']): { word: string; tone: string } {
  switch (state) {
    case 'ready':
      return { word: t('setup.model.cliTagFound'), tone: 'found' };
    case 'missing':
      return { word: t('setup.model.cliTagAbsent'), tone: 'absent' };
    // Installed and signed in to the wrong thing, or to nothing. Both are "we
    // found it, you cannot use it yet", and both have the fix underneath.
    default:
      return { word: t('setup.model.cliTagNotReady'), tone: 'not-ready' };
  }
}

/**
 * One subscription, as one thing to press.
 *
 * A ready row is a `<button>` the width of the card rather than a sentence with
 * a small button parked at the end of it. The offer *is* the action here — there
 * is nothing else to do with the line "Claude Code 2.1.226 — signed in as you@…,
 * on max" — and a row that is entirely clickable says that in a way a 70px
 * target beside it did not.
 *
 * The rows that are not offers stay `<div>`s. Making "not installed" pressable
 * to be consistent would be a button that does nothing, which is worse than the
 * asymmetry.
 */
function CliOffer({ status, active }: { status: CliStatus; active: CliKind | null }) {
  const inUse = active === status.kind;
  const verdict = cliVerdict(status.state);

  const badge = inUse ? (
    <span className="tag in-use">{t('setup.model.cliInUse')}</span>
  ) : (
    <span className={`tag ${verdict.tone}`}>{verdict.word}</span>
  );

  const name = (
    <span className="grow">
      <span className="cli-name">
        {CLI_NAMES[status.kind]}
        {status.version ? ` ${status.version}` : ''}
      </span>
      <span className="meta"> — {describeCli(status)}</span>
      {status.fix && <code className="cli-fix">{status.fix}</code>}
    </span>
  );

  if (status.state === 'ready' && !inUse) {
    return (
      <form className="cli-offer" action={useSubscription}>
        <input type="hidden" name="cli" value={status.kind} />
        <button type="submit" className="cli-pick">
          {badge}
          {name}
          <span className="cli-go">{t('setup.model.cliUse')} →</span>
        </button>
      </form>
    );
  }

  return (
    <div className="row cli-offer">
      {badge}
      {name}
    </div>
  );
}

/**
 * The subscription somebody is already paying for, offered by name.
 *
 * This exists because the form above it asks for a key that a large number of
 * people do not have and cannot get without opening a second billing account —
 * while the thing that would work is signed in on the same machine, from some
 * afternoon they spent in a terminal. Naming it, with the plan and the address
 * the CLI reports, turns a paragraph of documentation into a button.
 *
 * Shown even when nothing is found, and this is the deliberate part: the whole
 * point is that the option is not discoverable otherwise. Two lines saying
 * "not installed" are the cost of the person who has Claude Max and would never
 * have guessed this was here.
 */
function CliOffers({ statuses, active }: { statuses: CliStatus[]; active: CliKind | null }) {
  return (
    <div className="card stack">
      <h3>{t('setup.model.cliTitle')}</h3>
      <p className="meta">{t('setup.model.cliIntro')}</p>

      {statuses.map(status => (
        <CliOffer key={status.kind} status={status} active={active} />
      ))}

      {/* Both caveats below the offer rather than above them. Someone who has
          not yet seen that this is possible has no use for what it costs, and
          leading with the cost reads as talking them out of the only route
          they have. */}
      <p className="meta">{t('setup.model.cliCaveat')}</p>
      <p className="meta">{t('setup.model.cliUnsafeNote')}</p>
    </div>
  );
}

export async function ModelSection({ query, settings = false }: SectionProps) {
  const H = settings ? 'h2' : 'h1';
  const provider = process.env.AI_PROVIDER?.trim() || 'openai-compatible';
  const model = process.env.AI_MODEL?.trim() ?? '';
  const baseUrl = process.env.AI_BASE_URL?.trim() ?? '';
  const hasKey = (process.env.AI_API_KEY?.trim() ?? '') !== '';

  // `.env` stores the dialect and the address; the menu is a list of services.
  // `endpointFor` reads one back off the other two, so a file written by hand —
  // or by a version of this screen that had four lines on it — still opens on
  // the right one. See `chosenProvider` in actions.ts for the way back.
  const cli = process.env.AI_CLI?.trim().toLowerCase() ?? '';
  const activeCli = provider === 'cli' && isCliKind(cli) ? cli : null;
  const selected = endpointFor(provider, baseUrl, activeCli);

  // One probe for the whole section. The offers below and the menu above are
  // two views of the same answer, and asking twice would let them disagree
  // across the fifteen-second cache.
  const statuses = await detectClis();
  const choices = ENDPOINTS.map(entry => ({
    value: entry.id,
    // The region rides on the end of the name rather than inside it: the name is
    // a proper noun in every language and "mainland China" is not. Two services
    // here have two doors, and the line has to say which.
    label:
      (entry.label ? t(entry.label) : entry.name) +
      (entry.region ? ` · ${t(entry.region)}` : ''),
    found: entry.cli
      ? cliVerdict(statuses.find(status => status.kind === entry.cli)?.state ?? 'missing').word
      : null,
    baseUrl: entry.baseUrl,
    models: entry.models,
    cli: entry.wire === 'cli',
  }));

  return (
    <>
      <Notice query={query} path={envFilePath()} />

      <form className="card stack" action={saveModel}>
        <H>{settings ? sectionTitle('model') : t('setup.model.title')}</H>
        <p className="meta">
          {settings
            ? model
              ? t('settings.model.status', { model })
              : t('settings.model.statusNone')
            : t('setup.model.intro')}
        </p>

        {/* Which service, which model, at which address. All three named on the
            page — the menu had an `aria-label` and the box beside it had an
            example, so a filled-in form said `anthropic` and `claude-sonnet-4-5`
            and left it to be inferred which was which. They are one component
            because the answers are not independent: see `ModelFields`. */}
        <ModelFields
          choices={choices}
          provider={selected}
          model={model}
          baseUrl={baseUrl}
          providerLabel={t('setup.model.providerLabel')}
          modelLabel={t('setup.model.namePlaceholder')}
          otherLabel={t('setup.model.nameOther')}
          cliDefaultLabel={t('setup.model.nameCliDefault')}
          customLabel={t('setup.model.nameCustom')}
          baseUrlLabel={t('setup.model.baseUrlPlaceholder')}
        />

        {/* The hint appears only in the state it is about. "A key is saved —
            leave blank to keep it" is the answer to "why is this box empty when
            I set one last month"; on a fresh install it would be a sentence
            about a key that does not exist. */}
        <label className="model-key">
          {t('setup.model.apiKeyPlaceholder')}{' '}
          {hasKey && <span className="hint">{t('setup.model.apiKeySavedPlaceholder')}</span>}
          <input type="password" name="apiKey" autoComplete="off" />
        </label>

        <div className="row">
          <span className="grow meta">{t('setup.model.savedKeyNote')}</span>
          <button type="submit">{t('setup.model.save')}</button>
        </div>
      </form>

      {/* The button first and the verdict under it, which is the order the two
          happen in. The other way round put last week's result above the control
          that produces one, and a check that has never been run left a gap where
          the answer was going to be. */}
      <div className="check">
        <form action={testModel}>
          <button type="submit" disabled={!model}>
            {t('setup.model.test')}
          </button>
        </form>
        <span className="grow meta">{t('setup.model.testNote')}</span>
      </div>

      <LastCheck step="model" />

      {/* Last, because it is the alternative rather than the answer. Somebody
          holding an API key has already finished by the time they reach it, and
          somebody who is not gets the route that does not need one. */}
      <CliOffers statuses={statuses} active={activeCli} />
    </>
  );
}

/**
 * A password on an IMAP host, or Zoho's API. Not Google's other route.
 *
 * Two of the three ways this app can reach a mailbox fit in a form, and they are
 * both here. The third — a Google service account with domain-wide delegation —
 * is supported by the app and cannot honestly be walked through: it ends in a
 * Workspace admin console, pasting a private key. Sending someone there
 * mid-wizard with no way back is worse than pointing at the documentation, so
 * this covers the two that fit and says plainly where the other one lives.
 *
 * Zoho earns its place rather than being a second name for the same form. Its
 * IMAP route needs a setting an admin has to turn on and an app password to
 * replace the real one, and both failures read as `Invalid credentials`; the API
 * needs neither, and until now it was the one supported provider you could only
 * reach by hand-editing `.env`.
 */
export function MailboxSection({ query, settings = false }: SectionProps) {
  const H = settings ? 'h2' : 'h1';
  const address = process.env.MAIL_USER?.trim() ?? '';
  const imapHost = process.env.IMAP_HOST?.trim() ?? '';
  const smtpHost = process.env.SMTP_HOST?.trim() ?? '';
  const hasPassword = (process.env.MAIL_PASSWORD?.trim() ?? '') !== '';

  const provider = process.env.MAIL_PROVIDER?.trim().toLowerCase() ?? '';
  const zoho = provider === 'zoho';
  const zohoRegion = process.env.ZOHO_REGION?.trim().toLowerCase() || 'com';
  const zohoClientId = process.env.ZOHO_CLIENT_ID?.trim() ?? '';
  const hasZohoSecret = (process.env.ZOHO_CLIENT_SECRET?.trim() ?? '') !== '';
  const hasZohoToken = (process.env.ZOHO_REFRESH_TOKEN?.trim() ?? '') !== '';

  // What the Test button would have to talk to. Pressing it with nothing
  // configured produces a connection error about a blank hostname, which is a
  // worse answer than the button being plainly not ready yet.
  const connectable = zoho ? Boolean(zohoClientId && hasZohoToken) : Boolean(imapHost);

  // `.env` stores four hostnames and ports; the menu is a list of services.
  // `serviceFor` reads the line back off `MAIL_PROVIDER` and `IMAP_HOST`, so a
  // file written by hand — or before this menu existed — still opens on the
  // right line, and one we do not recognise opens on "other" with its own hosts
  // still in the boxes. See `chosenService` in actions.ts for the way back.
  const choices = MAIL_HOSTS.flatMap(entry => {
    const line = { value: entry.id, label: entry.label ? t(entry.label) : entry.name };
    // Above the IMAP line rather than at the end of the menu: it is the route to
    // prefer, and somebody scanning for the word "Zoho" stops at the first one
    // they find rather than reading on to discover there were two.
    return entry.id === 'zoho'
      ? [{ value: ZOHO_API_SERVICE, label: t('setup.mailbox.serviceZohoApi') }, line]
      : [line];
  });

  return (
    <>
      <Notice query={query} path={envFilePath()} />

      <form className="card stack" action={saveMailbox}>
        <H>{settings ? sectionTitle('mailbox') : t('setup.mailbox.title')}</H>
        <p className="meta">
          {settings
            ? zoho && address
              ? t('settings.mailbox.statusZoho', { address, region: zohoRegion })
              : address && imapHost
                ? t('settings.mailbox.status', { address, host: imapHost })
                : t('settings.mailbox.statusNone')
            : t('setup.mailbox.intro')}
        </p>

        {/* Whose mailbox, at whose service, on which hosts. One component
            because the answers are not independent: see `MailboxFields`. The
            password is passed through it rather than held by it — it follows
            from nothing and is never sent back to the browser. */}
        <MailboxFields
          choices={choices}
          service={serviceFor(provider, imapHost)}
          address={address}
          fields={{
            imapHost,
            imapPort: process.env.IMAP_PORT?.trim() ?? '',
            smtpHost,
            smtpPort: process.env.SMTP_PORT?.trim() ?? '',
          }}
          labels={{
            service: t('setup.mailbox.serviceLabel'),
            address: t('setup.mailbox.addressLabel'),
            addressPlaceholder: t('setup.mailbox.addressPlaceholder'),
            imapHost: t('setup.mailbox.imapHostPlaceholder'),
            imapPort: t('setup.mailbox.imapPortLabel'),
            imapPortPlaceholder: t('setup.mailbox.imapPortPlaceholder'),
            smtpHost: t('setup.mailbox.smtpHostPlaceholder'),
            smtpPort: t('setup.mailbox.smtpPortLabel'),
            smtpPortPlaceholder: t('setup.mailbox.smtpPortPlaceholder'),
          }}
          api={
            <>
              {/* The data centre first, because it is the answer that makes the
                  other three work or fail as one. Zoho's regions are separate
                  installations sharing no credentials, so a client minted in the
                  US and pointed at the EU is refused in exactly the words a
                  wrong secret is refused in — see `ZOHO_REGIONS`. */}
              <div className="fields">
                <label className="narrow">
                  {t('setup.mailbox.zohoRegionLabel')}
                  <select name="zohoRegion" defaultValue={zohoRegion}>
                    {Object.entries(ZOHO_REGIONS).map(([id, urls]) => (
                      <option key={id} value={id}>
                        {urls.accounts.replace(/^https:\/\/accounts\./, '')}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('setup.mailbox.zohoClientIdLabel')}
                  <input
                    type="text"
                    name="zohoClientId"
                    defaultValue={zohoClientId}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>

              {/* Both empty on every visit, and both meaning "keep what is
                  stored" when left that way — the same bargain the password
                  above strikes, for the same reason: a stored secret is never
                  sent back to the browser, so a blank box cannot be read as an
                  instruction to wipe one. */}
              <div className="fields">
                <label>
                  {t('setup.mailbox.zohoClientSecretLabel')}{' '}
                  {hasZohoSecret && (
                    <span className="hint">{t('setup.mailbox.zohoSavedPlaceholder')}</span>
                  )}
                  <input type="password" name="zohoClientSecret" autoComplete="off" />
                </label>
                <label>
                  {t('setup.mailbox.zohoRefreshTokenLabel')}{' '}
                  {hasZohoToken && (
                    <span className="hint">{t('setup.mailbox.zohoSavedPlaceholder')}</span>
                  )}
                  <input type="password" name="zohoRefreshToken" autoComplete="off" />
                </label>
              </div>
            </>
          }
        >
          <label>
            {t('setup.mailbox.passwordPlaceholder')}{' '}
            {hasPassword && (
              <span className="hint">{t('setup.mailbox.passwordSavedPlaceholder')}</span>
            )}
            <input type="password" name="password" autoComplete="off" />
          </label>
        </MailboxFields>

        {/* One note per route, and the stylesheet shows whichever route the menu
            is on. "Port 465 is implicit TLS" under a form that has no ports is
            not merely useless — it is the screen answering a question nobody on
            it asked. */}
        <div className="row">
          <span className="grow meta mailbox-imap">
            {t('setup.mailbox.portsNoteBefore')} <code>.env.example</code>
            {t('setup.mailbox.portsNoteAfter')}
          </span>
          <span className="grow meta mailbox-api">
            {t('setup.mailbox.zohoNoteBefore')} <code>{ZOHO_SCOPES.join(' ')}</code>
            {t('setup.mailbox.zohoNoteAfter')}
          </span>
          <button type="submit">{t('setup.mailbox.save')}</button>
        </div>
      </form>

      <div className="check">
        <form action={testMailbox}>
          <button type="submit" disabled={!connectable}>
            {t('setup.mailbox.test')}
          </button>
        </form>
        <span className="grow meta">{t('setup.mailbox.testNote')}</span>
      </div>

      <LastCheck step="mailbox" />
    </>
  );
}

/**
 * The only subject with nothing to connect to, so it ends in a readback
 * instead: the persona block exactly as the drafter receives it. A mis-typed
 * company name or a fact that reads as nonsense is visible here rather than in
 * a customer's inbox — which is worth as much on the settings screen as it is
 * in the wizard, so it is rendered in both.
 */
export function VoiceSection({ query, settings = false }: SectionProps) {
  const H = settings ? 'h2' : 'h1';
  const config = getWorkspaceConfig();
  const placeholder = config.organization === 'our company';

  return (
    <>
      <Notice query={query} path={workspaceFilePath()} />

      <form className="card stack" action={saveVoice}>
        <H>{settings ? sectionTitle('voice') : t('setup.voice.title')}</H>
        <p className="meta">
          {settings
            ? placeholder
              ? t('settings.voice.statusNone')
              : t('settings.voice.status', { organization: config.organization })
            : t('setup.voice.intro')}
        </p>

        <div className="fields">
          <label>
            {t('setup.voice.organizationPlaceholder')}
            <input
              type="text"
              name="organization"
              defaultValue={placeholder ? '' : config.organization}
            />
          </label>
          <label>
            {t('setup.voice.productPlaceholder')}
            <input type="text" name="product" defaultValue={config.product ?? ''} />
          </label>
        </div>

        {/* The one field on this form the model never sees. It sits here anyway
            because this is the "who are you" question, and "what is this desk
            called" is the same question asked about the tool instead of the
            business. Its note is the label's hint rather than a grey column
            beside the box — half a row of empty space, and a sentence that
            wrapped to three lines to fill it. */}
        <label>
          {t('setup.voice.appNamePlaceholder', { fallback: DEFAULT_APP_NAME })}{' '}
          <span className="hint">{t('setup.voice.appNameNote')}</span>
          <input type="text" name="appName" defaultValue={config.appName} />
        </label>

        <label>
          {t('setup.voice.voicePlaceholder')}
          <textarea name="voice" rows={2} defaultValue={config.voice} />
        </label>

        {/* The facts keep their placeholder: it is two lines of instruction about
            how to write the list, which is worth having in the empty box and not
            worth having above a full one. */}
        <label>
          {t('setup.voice.factsLabel')}
          <textarea
            name="facts"
            rows={5}
            defaultValue={config.facts.join('\n')}
            placeholder={t('setup.voice.factsPlaceholder')}
          />
        </label>

        <label>
          {t('setup.voice.signaturePlaceholder')}
          <input type="text" name="signature" defaultValue={config.signature} />
        </label>

        {/*
          The three languages, together, because the whole difficulty of this
          form is that there are three of them and they are not the same
          question. They were four boxes and a Save button on one `.row` with two
          of them pinned at `width: 110`: the row overflowed its own card, and the
          third language was clipped by the card's edge.

          Their three notes are the legend directly under them, rather than the
          last thing on the form below the Save button — where they explained
          fields eight rows further up, and were read, if at all, after the
          decision. They stay full sentences instead of becoming label hints:
          each one is two clauses about what a value *does*, which is more than a
          132px box can carry above itself.
        */}
        <div className="fields">
          <label className="narrow">
            {t('setup.voice.replyLanguageLabel')}
            <input
              type="text"
              name="replyLanguage"
              defaultValue={config.replyLanguage}
              placeholder={t('setup.voice.replyLanguagePlaceholder')}
            />
          </label>
          {/* No placeholder: this field's is "you read", which is the label with
              the noun taken off — a box whose name and whose ghost text are the
              same sentence twice. `match` on the field before it stays, because
              that one is a literal value somebody may want to type. */}
          <label className="narrow">
            {t('setup.voice.reviewLanguageLabel')}
            <input type="text" name="reviewLanguage" defaultValue={config.reviewLanguage} />
          </label>
          {/* Each language names itself, so the list is readable to someone who
              cannot read the language the page is currently in. */}
          <label className="narrow">
            {t('setup.voice.languageLabel')}
            <select name="language" defaultValue={locale()}>
              {Object.entries(LOCALES).map(([tag, name]) => (
                <option key={tag} value={tag}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="meta">
          {t('setup.voice.replyLanguageNoteBefore')} <code>match</code>{' '}
          {t('setup.voice.replyLanguageNoteMiddle')} <code>en</code>{' '}
          {t('setup.voice.replyLanguageNoteAfter')}
        </p>
        <p className="meta">
          {t('setup.voice.reviewLanguageNoteBefore')} <em>{t('setup.voice.reviewLanguageNoteYou')}</em>{' '}
          {t('setup.voice.reviewLanguageNoteAfter')}
        </p>
        <p className="meta">{t('setup.voice.uiLanguageNote')}</p>

        {/* Where every other form on this screen keeps its Save: last, on its own
            row, at the end of the fields it saves. It was inline among the
            language boxes, which made the last field on the form look like part
            of the button. */}
        <div className="row">
          <span className="grow" />
          <button type="submit">{t('setup.voice.save')}</button>
        </div>
      </form>

      <div className="card stack">
        <h2>{t('setup.voice.readbackTitle')}</h2>
        <pre className="block">{describeWorkspace(config)}</pre>
      </div>
    </>
  );
}

/**
 * Billing, which is the one section with no step behind it.
 *
 * Settings-only on purpose — see `SettingsSection`. A desk connects Stripe once
 * it is already answering mail and somebody has noticed that half the questions
 * are about money, which is not a thing to ask on day one in front of somebody
 * who has not yet connected a mailbox.
 *
 * The key and the switch are one form because they are one decision with two
 * halves: what this desk may read, and whether it may read it today. Deleting a
 * credential is a bad way to spell "not this afternoon" — see `stripeOn`.
 */
export function BillingSection({ query }: { query: Query }) {
  const key = stripeKey();
  const mode = stripeMode();
  const on = stripeOn();

  return (
    <>
      <Notice query={query} path={envFilePath()} />

      <form className="card stack" action={saveStripe}>
        <h2>{sectionTitle('billing')}</h2>
        <p className="meta">
          {!key
            ? t('settings.billing.statusNone')
            : !on
              ? t('settings.billing.statusOff')
              : mode
                ? t('settings.billing.status', { mode })
                : t('settings.billing.statusUnknown')}
        </p>

        <label>
          {t('settings.billing.keyPlaceholder')}{' '}
          {key && <span className="hint">{t('settings.billing.keySavedPlaceholder')}</span>}
          <input type="password" name="apiKey" autoComplete="off" />
        </label>

        <label className="switch">
          <input type="checkbox" name="enabled" value="1" defaultChecked={on} />
          {t('settings.billing.enable')}
        </label>
        {/* Paragraphs, not spans. `.switch` is an `inline-flex` and a `span` after
            it is inline too, so `.stack`'s margin bought nothing and the note ran
            on from the end of the tickbox's own label — one sentence to read,
            made of two that are not about the same thing. */}
        <p className="meta">{t('settings.billing.enableNote')}</p>

        {/* Only once there is a key to say it about. On an empty form it would
            be advice about a decision nobody has made yet. */}
        {key && !stripeRestricted() && (
          <p className="meta">{t('settings.billing.unrestricted')}</p>
        )}

        <div className="row">
          <span className="grow meta">{t('settings.billing.keyNote')}</span>
          <button type="submit">{t('settings.billing.save')}</button>
        </div>
      </form>

      <div className="check">
        <form action={testStripe}>
          <button type="submit" disabled={!key}>
            {t('settings.billing.test')}
          </button>
        </form>
        <span className="grow meta">{t('settings.billing.testNote')}</span>
      </div>

      {/* Anchored to the section rather than to the check's own name, because
          this section is called billing and the check is called stripe — and the
          fragment somebody lands on has to be the one the page has. */}
      <LastCheck step="stripe" anchor="billing-check" />

      {key && (
        <p className="meta">
          <Link href="/billing">{t('settings.billing.open')}</Link>
        </p>
      )}
    </>
  );
}

/** What each endpoint is for, and how often it wants calling. */
const SCHEDULE: Record<Scheduled, MessageKey> = {
  sync: 'settings.running.jobSync',
  worker: 'settings.running.jobWorker',
  sweep: 'settings.running.jobSweep',
  consolidate: 'settings.running.jobConsolidate',
};

/**
 * The verdict on one line, wearing the badge the CLI detection wears.
 *
 * Same three tones, and they mean the same three things here: green is usable
 * as it stands, amber is present but not doing its job, and grey is not there
 * at all. A second vocabulary for the same distinction, on the same screen,
 * would be two things to learn instead of one.
 */
const VERDICT: Record<ScheduledJob['state'], { label: MessageKey; tone: string }> = {
  onTime: { label: 'settings.running.tagOnTime', tone: 'found' },
  late: { label: 'settings.running.tagLate', tone: 'not-ready' },
  never: { label: 'settings.running.tagNever', tone: 'absent' },
};

/**
 * How long ago, at the coarseness the answer deserves.
 *
 * A weekly job last called eleven thousand minutes ago is a number nobody can
 * read as "last Monday". Nothing under a minute gets a figure at all: a sync
 * that ran while the page was rendering is "just now", not "0 min ago", which
 * reads like a stopped clock.
 *
 * Null for a call that has never happened — the badge on the row already says
 * so, and printing "never" twice on one line says it no better.
 */
function lastCalled(job: ScheduledJob): string | null {
  if (job.agoMinutes === null) return null;
  if (job.agoMinutes < 1) return t('settings.running.justNow');
  if (job.agoMinutes < 60) return t('settings.running.minutesAgo', { n: job.agoMinutes });

  const hours = Math.floor(job.agoMinutes / 60);
  if (hours < 48) return t('settings.running.hoursAgo', { n: hours });
  return t('settings.running.daysAgo', { n: Math.floor(hours / 24) });
}

/**
 * The crontab, which is the one piece of this app that lives outside it.
 *
 * Two things that were wrong with the block this replaces, both of which cost
 * somebody a desk that looked configured and fetched nothing:
 *
 * `$CRON_TOKEN` with no `CRON_TOKEN=` line above it. cron runs each command
 * through a shell, so the variable was expanded — to nothing — and four calls a
 * minute went out with `Authorization: Bearer ` and came back 401. `.env` is
 * this app's file and cron has never heard of it.
 *
 * `-s` without `-f`. curl exits 0 on a 401, so cron had nothing to mail anybody
 * about. `-fsS` fails on the status and prints why, which is the difference
 * between a silent desk and a message in the crontab owner's inbox.
 */
const CRONTAB = `CRON_TOKEN=your-token-here

*/5 * * * * curl -fsS -m 300 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sync
*/2 * * * * curl -fsS -m 300 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/worker
17  * * * * curl -fsS -m 300 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/sweep
30 4 * * 1  curl -fsS -m 600 -X POST -H "Authorization: Bearer $CRON_TOKEN" localhost:3000/api/consolidate`;

/**
 * On both screens, and for opposite reasons: at the end of the wizard because
 * nothing runs on its own until somebody sets this up, and on the settings
 * screen because the person who needs it again is looking at a desk that has
 * stopped fetching mail and cannot remember which four paths it was.
 *
 * It reports before it instructs. A card that opens with a crontab tells a desk
 * whose crontab already works to read a page in order to discover it did not
 * need to — and tells a desk with no scheduler at all exactly the same thing,
 * in the same tone, which is the failure this app is least able to see and the
 * operator least likely to notice. Four rows saying when each endpoint was last
 * called answer the question the instructions can only imply.
 */
export function CronCard({ settings = false }: { settings?: boolean }) {
  const state = automation();

  return (
    <>
      <div className="card stack">
        <h2>{settings ? sectionTitle('running') : t('setup.done.cronTitle')}</h2>
        <p className="meta">
          {t(
            state.silent
              ? 'settings.running.silent'
              : state.late
                ? 'settings.running.late'
                : 'settings.running.onTime',
          )}
        </p>

        {state.jobs.map(job => {
          const verdict = VERDICT[job.state];
          const ago = lastCalled(job);
          return (
            <div className="row schedule-row" key={job.job}>
              <span className={`tag ${verdict.tone}`}>{t(verdict.label)}</span>
              <span className="grow">
                <code>/api/{job.job}</code>
                <span className="meta"> — {t(SCHEDULE[job.job])}</span>
              </span>
              {ago && <span className="meta schedule-ago">{ago}</span>}
            </div>
          );
        })}

        {/* The one state worth interrupting for. Without a token every call
            below is refused before it opens a mailbox, and nothing on any other
            screen would ever say so — the scheduler gets a 401 and the desk
            gets silence. */}
        <p className="meta">
          {state.tokenSet ? (
            <>
              {t('settings.running.tokenBefore')} <code>CRON_TOKEN</code>{' '}
              {t('settings.running.tokenAfter')}
            </>
          ) : (
            <>
              {t('settings.running.tokenMissingBefore')} <code>CRON_TOKEN</code>{' '}
              {t('settings.running.tokenMissingAfter')}
            </>
          )}
        </p>
      </div>

      <div className="card stack">
        <h3>{t('settings.running.setupTitle')}</h3>
        {/* Docker first, because it is the answer for the largest number of
            people and the answer is "nothing". Somebody who ran `docker compose
            up` has a ticker container doing all four already, and letting them
            paste a crontab beside it would double every call. */}
        <p className="meta">{t('settings.running.docker')}</p>
        <p className="meta">
          {t('settings.running.crontabBefore')} <code>.env</code>
          {t('settings.running.crontabAfter')}
        </p>
        <pre className="block">{CRONTAB}</pre>
        <p className="meta">
          {t('settings.running.docsBefore')} <code>docs/deploying.md</code>
          {t('settings.running.docsAfter')}
        </p>
      </div>
    </>
  );
}
