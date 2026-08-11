import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import { getWorkspaceConfig } from '@/lib/config/workspace';
import { t } from '@/lib/i18n';
import { getRule, revisionsByRule } from '@/lib/rules/store';
import { RULE_CATEGORIES } from '@/lib/rules/types';
import { stamp } from '@/lib/time';

import { editRule, removeRule, toggleRule } from '../../actions';
import { TopicPicker } from '../topic-picker';

export const dynamic = 'force-dynamic';

/**
 * How many earlier wordings are worth reading. Beyond about five the question
 * stops being "what did this used to say" and starts being "why does this rule
 * keep changing", which the count in the heading already answers.
 */
const HISTORY_SHOWN = 5;

/**
 * One rule, with room to work on it.
 *
 * The rulebook used to be one page of open forms — a textarea, a select and
 * three buttons per rule, times two hundred and thirteen. That is the shape of
 * editing, and nine tenths of the time this screen is used for finding. So the
 * list became a list and the editing came here, where a rule gets the width to
 * be read in full, its own history under it, and the three buttons that change
 * it with nothing else on the page competing for the same click.
 *
 * The server actions are the ones the list used to call, unchanged. They all
 * redirect back to `/rules`, which is the right place to land: you came here to
 * change one sentence, and once it is changed the rulebook is what you wanted.
 */
export default async function RulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePage();
  // Only for the archive link in a rule's provenance line, below.
  const admin = await isAdmin();

  const { id } = await params;
  const rule = getRule(id);
  // A deleted rule is a real way to arrive here — the browser back button after
  // pressing Delete does exactly this — so it is a 404 and not a crash.
  if (!rule) notFound();

  const { topics } = getWorkspaceConfig();
  const history = revisionsByRule([rule.id]).get(rule.id) ?? [];

  return (
    <>
      <p className="meta">
        <Link href="/rules">{t('rules.backToRulebook')}</Link>
      </p>

      {/* The rule itself is the heading. A rule is a sentence, and a page about
          a sentence that puts something else at the top is a page about
          something else. */}
      <h1 className="rule-heading">{rule.summary ?? rule.content}</h1>

      <form className="card stack" action={editRule}>
        <input type="hidden" name="ruleId" value={rule.id} />
        <textarea name="content" aria-label={t('rules.contentLabel')} defaultValue={rule.content} rows={4} />

        <div className="row">
          <select
            name="category"
            aria-label={t('rules.categoryLabel')}
            defaultValue={rule.category}
            style={{ width: 160 }}
          >
            {RULE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`rules.category.${category}`)}
              </option>
            ))}
          </select>
          <span className="grow meta">
            #{rule.seq} · {t('rules.usedTimes', { n: rule.appliedCount })}
            {/* A backfill rule's source is an archived exchange, not a task, so
                it cannot link into the review screen — there is no row there to
                link to. */}
            {rule.sourceTaskId?.startsWith('backfill:') ? (
              <>
                {` · ${t('rules.sourceFrom')} `}
                {/* A link only for whoever can open the archive. See the same
                    line on the rules list. */}
                {admin ? (
                  <Link href="/backfill">{t('rules.sourceArchiveLink')}</Link>
                ) : (
                  t('rules.sourceArchiveLink')
                )}
              </>
            ) : rule.sourceTaskId ? (
              <>
                {` · ${t('rules.sourceFrom')} `}
                <Link href={`/tasks/${rule.sourceTaskId}`}>{t('rules.sourceTaskLink')}</Link>
              </>
            ) : (
              ` · ${t('rules.writtenByHand')}`
            )}
            {rule.enabled ? '' : ` · ${t('rules.retiredTag')}`}
          </span>
          <button className="primary" type="submit">
            {t('rules.saveButton')}
          </button>
          {/* The target state arrives bound rather than as a form field: React
              needs a submit button's `name` to say which action to invoke, so
              it overwrites one we set — see the note on `toggleRule`. */}
          <button type="submit" formAction={toggleRule.bind(null, !rule.enabled)}>
            {rule.enabled ? t('rules.retireButton') : t('rules.restoreButton')}
          </button>
          <button className="danger" type="submit" formAction={removeRule}>
            {t('rules.deleteButton')}
          </button>
        </div>

        {topics.length > 0 ? (
          <>
            <p className="meta" style={{ margin: 0 }}>{t('rules.topicsHint')}</p>
            <TopicPicker topics={topics} selected={rule.topics} />
          </>
        ) : (
          rule.topics.length > 0 && (
            /* Tags left over from a vocabulary that has since been removed from
               the config. Shown, because they are still narrowing this rule,
               and not editable here — the fix is to put the topic back in the
               config or clear it in the DB. */
            <p className="meta">{t('rules.topicsUnknown', { list: rule.topics.join(', ') })}</p>
          )
        )}

        {/* Why the extractor thought this was worth keeping. Often the most
            useful thing on the page for deciding whether to keep it. */}
        {rule.rationale && <p className="meta">{rule.rationale}</p>}
      </form>

      {/* The only thing that answers "who changed this, and what did it say
          before". A rule that drifts one edit at a time is indistinguishable
          from a rule that was always wrong unless the earlier wording is still
          readable. Open here rather than folded away: on the rule's own page
          there is nothing for it to be in the way of. */}
      {history.length > 0 && (
        <div className="card stack">
          <h2>{t('rules.historyHeading', { n: history.length })}</h2>
          {history.slice(0, HISTORY_SHOWN).map((revision) => (
            <div key={revision.id}>
              <p className="meta" style={{ margin: 0 }}>
                {stamp(revision.createdAt)} ·{' '}
                {t(`rules.historyReason.${revision.reason}`)}
                {revision.actor ? ` · ${t('rules.historyBy', { who: revision.actor })}` : ''}
              </p>
              <pre className="email">{revision.previousContent}</pre>
            </div>
          ))}
          {history.length > HISTORY_SHOWN && (
            <p className="meta" style={{ margin: 0 }}>
              {t('rules.historyOlder', { n: history.length - HISTORY_SHOWN })}
            </p>
          )}
        </div>
      )}
    </>
  );
}
