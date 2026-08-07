import { requirePage } from '@/lib/auth/guard';
import { getWorkspaceConfig } from '@/lib/config/workspace';
import { t } from '@/lib/i18n';
import { consolidationGate } from '@/lib/rules/consolidate';
import { STARTER_RULES } from '@/lib/rules/starter';
import { listRules, revisionsByRule } from '@/lib/rules/store';
import { RULE_CATEGORIES } from '@/lib/rules/types';

import {
  addRule,
  addStarterRules,
  approveProposedRule,
  editRule,
  removeRule,
  tidyRulebook,
  toggleRule,
} from '../actions';

export const dynamic = 'force-dynamic';

/**
 * How many earlier wordings are worth reading. Beyond about five the question
 * stops being "what did this used to say" and starts being "why does this rule
 * keep changing", which the count in the summary already answers.
 */
const HISTORY_SHOWN = 5;

/** Below this many rules there is nothing to scan, so nothing is collapsed. */
const SCANNING_STARTS_AT = 12;

/** As much of a rule as fits on one line before it stops being scannable. */
const HEADLINE_CHARS = 100;

/**
 * The one line that stands for a rule in the list.
 *
 * The summary when there is one, and the rule's own opening when there is not
 * — which is worse, and honest about being worse: the first sentence of a rule
 * is usually its trigger condition, so it says when the rule fires and not
 * what it does. An unsummarised rule reads exactly as badly here as it does in
 * a list of four hundred, which is the pressure that gets it summarised.
 */
function headline(rule: { summary: string | null; content: string }): string {
  if (rule.summary) return rule.summary;
  const flat = rule.content.replace(/\s+/g, ' ').trim();
  return flat.length > HEADLINE_CHARS ? `${flat.slice(0, HEADLINE_CHARS - 1)}…` : flat;
}

/**
 * The topic checkboxes for one rule.
 *
 * Checkboxes rather than the free-text box this replaced, and that is the
 * point of the whole change: a typed scope was a name nobody else used, so it
 * quietly excluded the rule from every reply instead of narrowing it. Ticking
 * nothing is a real and common answer — it means the rule applies to
 * everything — so there is no "all mail" option to tick.
 */
function TopicPicker({
  topics,
  selected,
}: {
  topics: { slug: string; description: string }[];
  selected: string[];
}) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: '4px 12px' }}>
      {topics.map((topic) => (
        <label key={topic.slug} className="meta" title={topic.description}>
          <input
            type="checkbox"
            name="topics"
            value={topic.slug}
            defaultChecked={selected.includes(topic.slug)}
          />{' '}
          {topic.slug}
        </label>
      ))}
    </div>
  );
}

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
  const proposals = listRules({ proposed: 'only' });
  const active = rules.filter((rule) => rule.enabled).length;
  const gate = consolidationGate();
  const { topics } = getWorkspaceConfig();
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

      {typeof query.starter === 'string' && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
          {query.starter === '0'
            ? t('rules.starterNothingAdded')
            : t('rules.starterAdded', { n: Number(query.starter) })}
        </p>
      )}

      {typeof query.tidy === 'string' && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
          {query.tidy === 'already' ? t('rules.tidyAlreadyQueued') : t('rules.tidyQueued')}
        </p>
      )}

      {/* Above the rulebook, because a proposal nobody looks at is the failure
          mode this whole thing exists to avoid: the learning pass reads mail
          written by strangers, and a rule it wrote from that mail steers every
          reply afterwards. Kept, so nothing is lost — inert, until somebody
          here reads it and presses the button. */}
      {proposals.length > 0 && (
        <div className="card stack">
          <h2>{t('rules.proposedHeading', { n: proposals.length })}</h2>
          <p className="meta" style={{ margin: 0 }}>{t('rules.proposedExplainer')}</p>
          {proposals.map((rule) => (
            <form key={rule.id} className="stack" action={approveProposedRule}>
              <input type="hidden" name="ruleId" value={rule.id} />
              <textarea name="content" defaultValue={rule.content} rows={2} readOnly />
              <div className="row">
                <span className="grow meta">
                  {rule.category} · {t('rules.proposedTag')}
                  {rule.sourceTaskId && !rule.sourceTaskId.startsWith('backfill:') && (
                    <>
                      {` · ${t('rules.sourceFrom')} `}
                      <a href={`/tasks/${rule.sourceTaskId}`}>{t('rules.sourceTaskLink')}</a>
                    </>
                  )}
                </span>
                <button type="submit">{t('rules.approveButton')}</button>
                <button className="danger" type="submit" formAction={removeRule}>
                  {t('rules.deleteButton')}
                </button>
              </div>
              {rule.rationale && <p className="meta" style={{ margin: 0 }}>{rule.rationale}</p>}
            </form>
          ))}
        </div>
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
          <button type="submit">{t('rules.addButton')}</button>
        </div>
        {topics.length > 0 && (
          <>
            <p className="meta" style={{ margin: 0 }}>{t('rules.topicsHint')}</p>
            <TopicPicker topics={topics} selected={[]} />
          </>
        )}
      </form>

      {rules.length === 0 ? (
        // The empty state used to be a dead end that said "rules appear as you
        // edit drafts" — true, and no help to somebody whose first hundred
        // replies go out before the first rule exists. The starter set is
        // offered here rather than installed, and only where the rulebook is
        // genuinely empty: on a desk that has already written rules, a button
        // that adds fourteen more is noise.
        <div className="card stack">
          <p className="empty" style={{ margin: 0 }}>{t('rules.empty')}</p>
          <p className="meta" style={{ margin: 0 }}>{t('rules.starterOffer', { n: STARTER_RULES.length })}</p>
          <form action={addStarterRules}>
            <button type="submit">{t('rules.starterButton')}</button>
          </form>
        </div>
      ) : (
        rules.map((rule) => (
          <form key={rule.id} className="card stack" action={editRule}>
            <input type="hidden" name="ruleId" value={rule.id} />
            {/* Collapsed, because a rulebook is read by scanning for the one
                rule you came for and a page of open textareas cannot be
                scanned at all. Open on a small rulebook, where there is
                nothing to scan and the extra click is pure friction. */}
            <details className="rule" open={rules.length <= SCANNING_STARTS_AT}>
              <summary>
                {headline(rule)}
                <span className="meta">
                  {' · '}
                  {rule.category}
                  {rule.enabled ? '' : ` · ${t('rules.retiredTag')}`}
                </span>
              </summary>
              <textarea name="content" defaultValue={rule.content} rows={2} />
            <div className="row">
              <select name="category" defaultValue={rule.category} style={{ width: 140 }}>
                {RULE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
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
            {topics.length > 0 ? (
              <TopicPicker topics={topics} selected={rule.topics} />
            ) : (
              rule.topics.length > 0 && (
                /* Tags left over from a vocabulary that has since been
                   removed from the config. Shown, because they are still
                   narrowing this rule, and not editable here — the fix is to
                   put the topic back in the config or clear it in the DB. */
                <p className="meta">{t('rules.topicsUnknown', { list: rule.topics.join(', ') })}</p>
              )
            )}
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
            </details>
          </form>
        ))
      )}
    </>
  );
}
