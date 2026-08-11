import Link from 'next/link';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import { getWorkspaceConfig } from '@/lib/config/workspace';
import { t } from '@/lib/i18n';
import { consolidationGate } from '@/lib/rules/consolidate';
import { STARTER_RULES } from '@/lib/rules/starter';
import { getMeta } from '@/lib/db/meta';
import { getRule, listRules } from '@/lib/rules/store';
import { RULE_CATEGORIES } from '@/lib/rules/types';
import { day } from '@/lib/time';

import { addRule, addStarterRules, approveProposedRule, askTidy, removeRule, tidyRulebook } from '../actions';
import { DismissOnEscape } from '../dismiss-on-escape';
import { TopicPicker } from './topic-picker';

export const dynamic = 'force-dynamic';

/**
 * How many rules the v24 upgrade moved into the queue, if it moved any.
 *
 * The operator meets this days after the upgrade, on a desk whose replies have
 * quietly stopped using rules it had been using for months. Without a line
 * saying why, the only available reading is that something broke.
 */
function quarantineCount(): number {
  const raw = getMeta('rules.quarantined_at_v24');
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    const count = (parsed as { count?: unknown }).count;
    return typeof count === 'number' ? count : 0;
  } catch {
    return 0;
  }
}

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
 * The rulebook, in the open.
 *
 * A learned rule you cannot read is indistinguishable from a model that has
 * quietly gone wrong, so every rule shows what taught it, why, and how often it
 * has been used — the three things you need to decide whether to keep it.
 *
 * One line each, and the editing lives on the rule's own page. This used to be
 * two hundred and thirteen open forms stacked down one screen, which is the
 * shape of writing a rule; what this page is used for is finding one, and a
 * page of textareas cannot be scanned at all.
 */
export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage();
  // Only for the archive link in a rule's provenance line, below.
  const admin = await isAdmin();

  const query = await searchParams;
  const showDisabled = query.show === 'all';
  /* This page with no panel over it — where dismissing the tidy panel goes, and
     the one thing it must not lose on the way is which filter is in force. */
  const here = showDisabled ? '/rules?show=all' : '/rules';
  const rules = listRules({ ...(showDisabled ? {} : { enabledOnly: true }) });
  const proposals = listRules({ proposed: 'only' });
  const active = rules.filter((rule) => rule.enabled).length;
  const gate = consolidationGate();
  const { topics } = getWorkspaceConfig();
  const quarantined = quarantineCount();

  // Most-used first, and only on the screen. The order rules are *emitted* in
  // has to stay insertion order or two runs of the same prompt cannot be
  // compared — see DESIGN.md, "Selection is by priority; emission is by
  // insertion order". This sorts a copy, and nothing downstream sees it.
  //
  // It also puts the rules used zero times on the last screen, which is the
  // only place anybody reads carefully. A rule that has never fired is either
  // written too narrowly or ready to retire, and both of those need somebody to
  // notice before they can happen.
  const shown = [...rules].sort((a, b) => b.appliedCount - a.appliedCount);

  return (
    <>
      {/* Hidden, for the reason the inbox's is — see the note there. */}
      <h1 className="visually-hidden">{t('nav.rules')}</h1>

      <div className="row" style={{ marginBottom: 16 }}>
        <span className="grow meta">
          {t('rules.activeCount', { n: active })}{' '}
          {showDisabled ? t('rules.ofTotal', { n: rules.length }) : ''}
          {gate.changed > 0 && ` · ${t('rules.writtenSinceTidy', { n: gate.changed })}`}
        </span>
        <div className="filters" style={{ margin: 0 }}>
          <Link href="/rules" className={showDisabled ? '' : 'active'}>
            {t('rules.filterActive')}
          </Link>
          <Link href="/rules?show=all" className={showDisabled ? 'active' : ''}>
            {t('rules.filterIncludingRetired')}
          </Link>
        </div>
        {/* Asks first. What the button starts is a model pass that rewords
            rules and switches others off, and the panel behind it is where that
            is said. */}
        <form action={askTidy}>
          {/* So the panel's way out lands on the list that is on screen now
              rather than on the other one. */}
          {showDisabled && <input type="hidden" name="show" value="all" />}
          <button type="submit">{t('rules.tidyButton')}</button>
        </form>
      </div>

      {/* What "tidy" means, before it happens.
          Every claim here is a property of the pass rather than a reassurance:
          groups of one are left byte-identical, absorbed rules are disabled and
          never deleted, the old wording goes to `rule_revisions`, and proposals
          and retired rules are outside `planConsolidation`'s query. See
          `lib/rules/consolidate.ts`. */}
      {query.tidy === 'ask' && (
        <div className="confirm-scrim">
          <form className="confirm card stack" action={tidyRulebook} role="dialog" aria-labelledby="tidy-title">
            <DismissOnEscape href={here} />

            <h2 id="tidy-title">{t('rules.tidyAsk.title')}</h2>
            <p className="meta">
              {t('rules.tidyAsk.scope', {
                n: active,
                when: gate.since === 'never' ? t('rules.tidyAsk.never') : day(gate.since),
              })}
            </p>
            <p>{t('rules.tidyAsk.what')}</p>
            <p>{t('rules.tidyAsk.effect')}</p>
            <p>{t('rules.tidyAsk.reversible')}</p>
            <p className="meta">{t('rules.tidyAsk.queued')}</p>

            <div className="actions">
              <button className="primary" type="submit">
                {t('rules.tidyAsk.go')}
              </button>
              <Link className="button-link" href={here}>
                {t('rules.tidyAsk.back')}
              </Link>
            </div>
          </form>
        </div>
      )}

      {typeof query.starter === 'string' && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
          {query.starter === '0'
            ? t('rules.starterNothingAdded')
            : t('rules.starterAdded', { n: Number(query.starter) })}
        </p>
      )}

      {/* The two outcomes, and only those. `?tidy` used to have one meaning —
          the pass has been queued — so "anything but `already`" was a fair
          reading of it. It now also carries `ask`, and left as it was this
          banner announced that a tidy had been queued underneath the panel
          still asking whether to queue one. */}
      {(query.tidy === 'queued' || query.tidy === 'already') && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
          {query.tidy === 'already' ? t('rules.tidyAlreadyQueued') : t('rules.tidyQueued')}
        </p>
      )}

      {/* Stays put rather than being dismissable: there is nowhere else on the
          desk that explains why a rulebook that worked yesterday is empty. */}
      {quarantined > 0 && proposals.length > 0 && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
          {t('rules.quarantineNotice', { n: quarantined })}
        </p>
      )}

      {/* Above the rulebook, because a proposal nobody looks at is the failure
          mode this whole thing exists to avoid: the learning pass reads mail
          written by strangers, and a rule it wrote from that mail steers every
          reply afterwards. Kept, so nothing is lost — inert, until somebody
          here reads it and presses the button. */}
      {proposals.length > 0 && (
        // A block of its own rather than rows in the list, and on olive ground:
        // this is the one thing on the desk that changes what every future
        // reply says, and it changes it only if somebody here reads it.
        <div className="proposals">
          <h2>{t('rules.proposedHeading', { n: proposals.length })}</h2>
          <p className="meta">{t('rules.proposedExplainer')}</p>
          {proposals.map((rule) => {
            // A proposal aimed at an existing rule replaces its wording on
            // approval. Approving that without seeing which rule, or what it
            // says today, is a gate in name only — the operator would be
            // agreeing to a deletion nothing on the page mentions.
            const target = rule.replaces ? getRule(rule.replaces) : null;
            return (
              <form key={rule.id} className="proposal" action={approveProposedRule}>
                <input type="hidden" name="ruleId" value={rule.id} />

                {rule.replaces && target && (
                  <>
                    <p className="meta">{t('rules.proposedRewrite')}</p>
                    {/* Struck through and green are how these two are told
                        apart at a glance, and neither reaches a screen reader,
                        so each keeps the words it used to be labelled with. */}
                    <p className="was">
                      <span className="visually-hidden">{t('rules.proposedCurrent')} </span>
                      {target.content}
                    </p>
                    <p className="becomes">
                      <span className="visually-hidden">{t('rules.proposedReplacement')} </span>
                      {rule.content}
                    </p>
                  </>
                )}

                {/* Simply new — or aimed at a rule that has been deleted since,
                    which has to be said, because approving it then adds a rule
                    rather than rewriting one, and that is a different thing to
                    agree to. */}
                {(!rule.replaces || !target) && (
                  <>
                    {rule.replaces && !target && (
                      <p className="meta">{t('rules.proposedTargetGone')}</p>
                    )}
                    {/* Shown, not offered for editing: what is being approved
                        is this sentence. Rewording it is what the rule's own
                        page is for, and an edit made there is recorded in
                        `rule_revisions` — one made in a box here would leave
                        nothing behind at all. */}
                    <p className="text">{rule.content}</p>
                  </>
                )}

                <div className="row">
                  <span className="grow meta">
                    {t(`rules.category.${rule.category}`)} · {t('rules.proposedTag')}
                    {rule.sourceTaskId && !rule.sourceTaskId.startsWith('backfill:') && (
                      <>
                        {` · ${t('rules.sourceFrom')} `}
                        <Link href={`/tasks/${rule.sourceTaskId}`}>{t('rules.sourceTaskLink')}</Link>
                      </>
                    )}
                  </span>
                  <button className="primary" type="submit">
                    {t('rules.approveButton')}
                  </button>
                  <button className="danger" type="submit" formAction={removeRule}>
                    {t('rules.deleteButton')}
                  </button>
                </div>

                {/* The model's own reason. Often says more about whether to
                    keep this than the rule does. */}
                {rule.rationale && <p className="meta">{rule.rationale}</p>}
              </form>
            );
          })}
        </div>
      )}

      <form className="card stack" action={addRule}>
        <h2>{t('rules.writeHeading')}</h2>
        <input
          type="text"
          name="content"
          aria-label={t('rules.contentLabel')}
          placeholder={t('rules.contentPlaceholder')}
        />
        <div className="row">
          <select name="category" aria-label={t('rules.categoryLabel')} defaultValue="general" style={{ width: 160 }}>
            {RULE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`rules.category.${category}`)}
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
        // One line each, in a single card, ordered by how much work each rule
        // is doing. Category and uses hold their own columns so the eye runs
        // down one instead of re-finding it on every row.
        <div className="rulebook">
          {shown.map((rule) => (
            <div key={rule.id} className={`rule-row${rule.enabled ? '' : ' retired'}`}>
              <div>
                <p className="headline">
                  <Link href={`/rules/${rule.id}`}>{headline(rule)}</Link>
                </p>
                <p className="provenance">
                  {/* A backfill rule's source is an archived exchange, not a
                      task, so it cannot link into the review screen — there is
                      no row there to link to. */}
                  {rule.sourceTaskId?.startsWith('backfill:') ? (
                    <>
                      {t('rules.sourceFrom')}{' '}
                      {/* Where it came from is provenance and belongs to
                          everyone reading the rulebook; the archive screen it
                          came from is an admin's. Without the flag this is the
                          same sentence with nothing to click. */}
                      {admin ? (
                        <Link href="/backfill">{t('rules.sourceArchiveLink')}</Link>
                      ) : (
                        t('rules.sourceArchiveLink')
                      )}
                    </>
                  ) : rule.sourceTaskId ? (
                    <>
                      {t('rules.sourceFrom')}{' '}
                      <Link href={`/tasks/${rule.sourceTaskId}`}>{t('rules.sourceTaskLink')}</Link>
                    </>
                  ) : (
                    t('rules.writtenByHand')
                  )}
                  {rule.enabled ? '' : ` · ${t('rules.retiredTag')}`}
                </p>
              </div>

              <span className="tag">{t(`rules.category.${rule.category}`)}</span>

              {/* Never-used rules are not hidden. One that has never fired is
                  either written too narrowly or ready to retire, and sorting by
                  use puts all of them on the last screen — which is the only
                  screen anybody reads properly. */}
              <span className={`uses${rule.appliedCount === 0 ? ' never' : ''}`}>
                {t('rules.usedTimes', { n: rule.appliedCount })}
              </span>

              <span className="row-actions">
                <Link className="button-link" href={`/rules/${rule.id}`}>
                  {t('rules.editButton')}
                </Link>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
