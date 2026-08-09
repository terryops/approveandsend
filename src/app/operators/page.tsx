import { currentOperator, requireAdminPage } from '@/lib/auth/guard';
import { adminPassword } from '@/lib/auth/session';
import { t } from '@/lib/i18n';
import { listOperators } from '@/lib/operators/store';

import {
  addOperator,
  changeOperatorPassword,
  setOperatorAccess,
  setOperatorRole,
} from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Who is on the desk.
 *
 * One switch per person and no permission matrix, because there is one bit in
 * the database and not a grid of them. The list answers two questions — whose
 * name can appear on a reply, and who can change how the desk runs — and
 * everything else it shows (last seen, retired) is in service of reading an old
 * attribution six weeks later.
 *
 * Admin-only, and it is the one screen where that is worth stating out loud: a
 * page whose buttons hand out the settings cannot be a page the settings are
 * handed out from.
 */
export default async function OperatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();

  const query = await searchParams;
  const operators = listOperators();
  const me = await currentOperator();
  const shared = adminPassword() !== null;

  const error = typeof query.error === 'string' ? query.error : '';
  // What the last press did.
  //
  // Both of these actions already redirected with the news and the page threw it
  // away: `?changed=1` rendered nothing at all, and since the new password is
  // never echoed back into the box, a successful change left the screen
  // byte-identical to the one before it. A button that does its job and says
  // nothing is a button people press twice and then report as broken — which is
  // exactly what happened. `?added=1` was the same silence, on the one action
  // whose whole point is that somebody else can now get in.
  const changed = typeof query.changed === 'string';
  // The name travels in the query rather than being looked up here: the list is
  // ordered by name, not by when a row was written, so "the last one" is not the
  // one just added — and the sentence is about a person, so it says which.
  const added = typeof query.added === 'string' ? query.added : '';

  return (
    <>
      {/* Hidden, for the reason the inbox's is — see the note there. */}
      <h1 className="visually-hidden">{t('nav.operators')}</h1>

      <p className="meta" style={{ marginBottom: 16 }}>
        {t('operators.intro')} {t('operators.adminIntro')}
      </p>

      {error && (
        <p className="banner">
          {error === 'taken'
            ? t('operators.errorTaken')
            : error === 'last'
              ? t('operators.errorLast')
              : error === 'lastAdmin'
                ? t('operators.errorLastAdmin')
                : t('operators.errorBlank')}
        </p>
      )}

      {/* The news from the last press, in the same bar the errors use and in the
          colour of good news rather than of a problem — see `.banner.quiet`. */}
      {changed && <p className="banner quiet">{t('operators.passwordChanged')}</p>}
      {added && <p className="banner quiet">{t('operators.added', { name: added })}</p>}

      {operators.length === 0 && (
        <p className="banner quiet">
          {shared ? t('operators.onlySharedPassword') : t('operators.noneYet')}
        </p>
      )}

      <form className="card stack" action={addOperator}>
        <h2>{t('operators.addHeading')}</h2>
        <div className="row">
          <input type="text" name="name" placeholder={t('operators.namePlaceholder')} style={{ width: 220 }} />
          <input
            type="password"
            name="password"
            placeholder={t('operators.passwordPlaceholder')}
            autoComplete="new-password"
            className="grow"
          />
          <button type="submit">{t('operators.addButton')}</button>
        </div>
        <span className="meta">{t('operators.addNote')}</span>
      </form>

      {operators.map((operator) => (
        <form key={operator.id} className="card stack" action={changeOperatorPassword}>
          <input type="hidden" name="operatorId" value={operator.id} />
          <div className="row">
            <strong className="grow">
              {operator.name}
              {me?.id === operator.id && ` · ${t('operators.you')}`}
              {/* Said on the row rather than shown as a column of ticks: on a
                  list of four people, two of whom are admins, a column is four
                  cells to read and three of them are empty. */}
              {operator.admin && ` · ${t('operators.adminTag')}`}
              {operator.disabledAt && ` · ${t('operators.retiredTag')}`}
            </strong>
            <span className="meta">
              {operator.lastSeenAt
                ? t('operators.lastSeen', { when: operator.lastSeenAt.slice(0, 10) })
                : t('operators.neverSignedIn')}
            </span>
          </div>
          <div className="row">
            <input
              type="password"
              name="password"
              placeholder={t('operators.newPasswordPlaceholder')}
              autoComplete="new-password"
              className="grow"
            />
            <button type="submit">{t('operators.changePasswordButton')}</button>
            {/* Not offered on a retired row. Nothing they can reach changes
                while they cannot sign in, so the only thing the button would do
                is make the row longer and ask a question about somebody who has
                left. Bringing them back brings the choice back with them. */}
            {!operator.disabledAt && (
              <button type="submit" formAction={setOperatorRole.bind(null, !operator.admin)}>
                {operator.admin
                  ? t('operators.removeAdminButton')
                  : t('operators.makeAdminButton')}
              </button>
            )}
            {/* Retire, never delete. The name is on replies that have already
                gone out, and a row that disappears turns those into a question
                nobody can answer. */}
            <button
              type="submit"
              formAction={setOperatorAccess.bind(null, Boolean(operator.disabledAt))}
              className={operator.disabledAt ? '' : 'danger'}
            >
              {operator.disabledAt ? t('operators.restoreButton') : t('operators.retireButton')}
            </button>
          </div>
        </form>
      ))}
    </>
  );
}
