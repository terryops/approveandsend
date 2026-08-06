import { requirePage } from '@/lib/auth/guard';
import { consolidationGate } from '@/lib/rules/consolidate';
import { listRules } from '@/lib/rules/store';
import { RULE_CATEGORIES } from '@/lib/rules/types';

import { addRule, editRule, removeRule, tidyRulebook, toggleRule } from '../actions';

export const dynamic = 'force-dynamic';

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

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <span className="grow meta">
          {active} active {showDisabled ? `of ${rules.length}` : ''}
          {gate.changed > 0 && ` · ${gate.changed} written since the last tidy`}
        </span>
        <div className="filters" style={{ margin: 0 }}>
          <a href="/rules" className={showDisabled ? '' : 'active'}>
            Active
          </a>
          <a href="/rules?show=all" className={showDisabled ? 'active' : ''}>
            Including retired
          </a>
        </div>
        <form action={tidyRulebook}>
          <button type="submit">Tidy the rulebook</button>
        </form>
      </div>

      {typeof query.tidy === 'string' && (
        <p className="banner" style={{ borderColor: 'var(--line)' }}>
          {query.tidy === 'already'
            ? 'A tidy is already queued.'
            : 'Queued. It merges near-duplicates in the background — run the queue, then reload.'}
        </p>
      )}

      <form className="card stack" action={addRule}>
        <h2>Write a rule</h2>
        <input type="text" name="content" placeholder="One sentence the drafter must obey" />
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
            placeholder="scope — blank means every kind of mail"
            style={{ width: 280 }}
          />
          <button type="submit">Add</button>
        </div>
      </form>

      {rules.length === 0 ? (
        <p className="empty">No rules yet. They appear as you edit drafts before sending them.</p>
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
                placeholder="all mail"
                style={{ width: 200 }}
              />
              <span className="grow meta">
                #{rule.seq} · used {rule.appliedCount}×
                {rule.sourceTaskId ? (
                  <>
                    {' · from '}
                    <a href={`/tasks/${rule.sourceTaskId}`}>the email that taught it</a>
                  </>
                ) : (
                  ' · written by hand'
                )}
                {rule.enabled ? '' : ' · retired'}
              </span>
              <button type="submit">Save</button>
              <button type="submit" formAction={toggleRule} name="enabled" value={String(!rule.enabled)}>
                {rule.enabled ? 'Retire' : 'Restore'}
              </button>
              <button className="danger" type="submit" formAction={removeRule}>
                Delete
              </button>
            </div>
            {rule.rationale && <p className="meta">{rule.rationale}</p>}
          </form>
        ))
      )}
    </>
  );
}
