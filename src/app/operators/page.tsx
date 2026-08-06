import { currentOperator, requirePage } from '@/lib/auth/guard';
import { adminPassword } from '@/lib/auth/session';
import { t } from '@/lib/i18n';
import { listOperators } from '@/lib/operators/store';

import { addOperator, changeOperatorPassword, setOperatorAccess } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Who is on the desk.
 *
 * There is no role column and no permission matrix on this page, because there
 * is none in the database either. The list answers one question — whose name
 * can appear on a reply — and everything else it shows (last seen, retired) is
 * in service of reading an old attribution six weeks later.
 */
export default async function OperatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();

  const query = await searchParams;
  const operators = listOperators();
  const me = await currentOperator();
  const shared = adminPassword() !== null;

  const error = typeof query.error === 'string' ? query.error : '';

  return (
    <>
      <p className="meta" style={{ marginBottom: 16 }}>
        {t('operators.intro')}
      </p>

      {error && (
        <p className="banner">
          {error === 'taken'
            ? t('operators.errorTaken')
            : error === 'last'
              ? t('operators.errorLast')
              : t('operators.errorBlank')}
        </p>
      )}

      {operators.length === 0 && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
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
            {/* Retire, never delete. The name is on replies that have already
                gone out, and a row that disappears turns those into a question
                nobody can answer. */}
            <button
              type="submit"
              formAction={setOperatorAccess}
              name="enabled"
              value={String(Boolean(operator.disabledAt))}
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
