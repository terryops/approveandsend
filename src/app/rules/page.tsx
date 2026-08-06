import { requirePage } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';
import { consolidationGate } from '@/lib/rules/consolidate';
import { listRules, revisionsByRule } from '@/lib/rules/store';
import { RULE_CATEGORIES } from '@/lib/rules/types';

import { addRule, editRule, removeRule, tidyRulebook, toggleRule } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * How many earlier wordings are worth reading. Beyond about five the question
 * stops being "what did this used to say" and starts being "why does this rule
 * keep changing", which the count in the summary already answers.
 */
const HISTORY_SHOWN = 5;

/**
 * The rulebook, in the open.
 *
 * A learned rule you cannot read is indistinguishable from a model that has
 * quietly gone wrong, so every rule shows what taught it, why, and how often
 * it has been used — the three things you need to decide whether to keep it.
 */
export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();

  const query = await searchParams;
  const showDisabled = query.show === 'all';
  const rules = listRules({ ...(showDisabled ? {} : { enabledOnly: true }) });
  const active = rules.filter((rule) => rule.enabled).length;
  const gate = consolidationGate();
  const history = revisionsByRule(rules.map((rule) => rule.id));

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <span className="grow meta">
          {t('rules.activeCount', { n: active })}{' '}
          {showDisabled ? t('rules.ofTotal', { n: rules.length }) : ''}
          {gate.changed > 0 && ` · ${t('rules.writtenSinceTidy', { n: gate.changed })}`}
        </span>
        <div className="filters" style={{ margin: 0 }}>
          <a href="/rules" className={showDisabled ? '' : 'active'}>
            {t('rules.filterActive')}
          </a>
          <a href="/rules?show=all" className={showDisabled ? 'active' : ''}>
            {t('rules.filterIncludingRetired')}
          </a>
        </div>
        <form action={tidyRulebook}>
          <button type="submit">{t('rules.tidyButton')}</button>
        </form>
      </div>

      {typeof query.tidy === 'string' && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
          {query.tidy === 'already' ? t('rules.tidyAlreadyQueued') : t('rules.tidyQueued')}
        </p>
      )}

      <form className="card stack" action={addRule}>
        <h2>{t('rules.writeHeading')}</h2>
        <input type="text" name="content" placeholder={t('rules.contentPlaceholder')} />
        <div className="row">
          <select name="category" defaultValue="general" style={{ width: 160 }}>
            {RULE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <input
            type="text"
            name="scope"
            placeholder={t('rules.scopePlaceholder')}
            style={{ width: 280 }}
          />
          <button type="submit">{t('rules.addButton')}</button>
        </div>
      </form>

      {rules.length === 0 ? (
        <p className="empty">{t('rules.empty')}</p>
      ) : (
        rules.map((rule) => (
          <form key={rule.id} className="card stack" action={editRule}>
            <input type="hidden" name="ruleId" value={rule.id} />
            <textarea name="content" defaultValue={rule.content} rows={2} />
            <div className="row">
              <select name="category" defaultValue={rule.category} style={{ width: 140 }}>
                {RULE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <input
                type="text"
                name="scope"
                defaultValue={rule.scope ?? ''}
                placeholder={t('rules.scopeAllMail')}
                style={{ width: 200 }}
              />
              <span className="grow meta">
                #{rule.seq} · {t('rules.usedTimes', { n: rule.appliedCount })}
                {/* A backfill rule's source is an archived exchange, not a
                    task, so it cannot link into the review screen — there is
                    no row there to link to. */}
                {rule.sourceTaskId?.startsWith('backfill:') ? (
                  <>
                    {` · ${t('rules.sourceFrom')} `}
                    <a href="/backfill">{t('rules.sourceArchiveLink')}</a>
                  </>
                ) : rule.sourceTaskId ? (
                  <>
                    {` · ${t('rules.sourceFrom')} `}
                    <a href={`/tasks/${rule.sourceTaskId}`}>{t('rules.sourceTaskLink')}</a>
                  </>
                ) : (
                  ` · ${t('rules.writtenByHand')}`
                )}
                {rule.enabled ? '' : ` · ${t('rules.retiredTag')}`}
              </span>
              <button type="submit">{t('rules.saveButton')}</button>
              <button type="submit" formAction={toggleRule} name="enabled" value={String(!rule.enabled)}>
                {rule.enabled ? t('rules.retireButton') : t('rules.restoreButton')}
              </button>
              <button className="danger" type="submit" formAction={removeRule}>
                {t('rules.deleteButton')}
              </button>
            </div>
            {rule.rationale && <p className="meta">{rule.rationale}</p>}
            {/* Closed by default, and the only thing on this page that answers
                "who changed this, and what did it say before". A rule that
                drifts one edit at a time is indistinguishable from a rule that
                was always wrong unless the earlier wording is still readable. */}
            {(history.get(rule.id)?.length ?? 0) > 0 && (
              <details className="translation">
                <summary>
                  {t('rules.historyHeading', { n: history.get(rule.id)!.length })}
                </summary>
                {history
                  .get(rule.id)!
                  .slice(0, HISTORY_SHOWN)
                  .map((revision) => (
                    <div key={revision.id} style={{ marginTop: 8 }}>
                      <p className="meta" style={{ margin: 0 }}>
                        {revision.createdAt.slice(0, 16).replace('T', ' ')} ·{' '}
                        {t(`rules.historyReason.${revision.reason}`)}
                        {revision.actor
                          ? ` · ${t('rules.historyBy', { who: revision.actor })}`
                          : ''}
                      </p>
                      <pre className="email">{revision.previousContent}</pre>
                    </div>
                  ))}
                {history.get(rule.id)!.length > HISTORY_SHOWN && (
                  <p className="meta">
                    {t('rules.historyOlder', {
                      n: history.get(rule.id)!.length - HISTORY_SHOWN,
                    })}
                  </p>
                )}
              </details>
            )}
          </form>
        ))
      )}
    </>
  );
}
