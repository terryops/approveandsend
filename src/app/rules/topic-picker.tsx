/**
 * The topic checkboxes for one rule.
 *
 * Checkboxes rather than the free-text box this replaced, and that is the point
 * of the whole change: a typed scope was a name nobody else used, so it quietly
 * excluded the rule from every reply instead of narrowing it. Ticking nothing
 * is a real and common answer — it means the rule applies to everything — so
 * there is no "all mail" option to tick.
 *
 * Its own file because two screens now write rules: the box at the top of the
 * rulebook, which starts one, and the rule's own page, which edits one. A copy
 * on each is two lists of topics that drift apart, and the way that failure
 * shows up is a rule that stops matching after somebody edits it.
 */

import type { Topic } from '@/lib/config/workspace';

export function TopicPicker({
  topics,
  selected,
}: {
  topics: Topic[];
  selected: string[];
}) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: '4px 12px' }}>
      {topics.map((topic) => (
        // Both the slug and the description on the tooltip: the label says
        // which topic this is, and the slug is what the rule will be stored
        // under, which is the thing you need when a rule is not matching.
        <label
          key={topic.slug}
          className="meta"
          title={topic.description ? `${topic.slug} — ${topic.description}` : topic.slug}
        >
          <input
            type="checkbox"
            name="topics"
            value={topic.slug}
            defaultChecked={selected.includes(topic.slug)}
          />{' '}
          {topic.label || topic.slug}
        </label>
      ))}
    </div>
  );
}
