import { getWorkspaceConfig, describeWorkspace } from '@/lib/config/workspace';
import { workspaceFilePath } from '@/lib/setup/workspace-file';

import { saveVoice } from '../actions';
import { Notice, type Query } from '../notice';

export const dynamic = 'force-dynamic';

/**
 * The only step with nothing to connect to, so it ends in a readback instead:
 * the persona block exactly as the drafter receives it. A mis-typed company
 * name or a fact that reads as nonsense is visible here rather than in a
 * customer's inbox.
 */
export default async function VoicePage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const config = getWorkspaceConfig();
  const placeholder = config.organization === 'our company';

  return (
    <>
      <Notice query={query} path={workspaceFilePath()} />

      <form className="card stack" action={saveVoice}>
        <h2>4. Say who you are</h2>
        <p className="meta">
          This opens every drafting prompt. The facts matter most: they are the things the model
          would otherwise invent.
        </p>

        <div className="row">
          <input
            className="grow"
            type="text"
            name="organization"
            defaultValue={placeholder ? '' : config.organization}
            placeholder="Company name — who the customer thinks they are writing to"
          />
          <input
            className="grow"
            type="text"
            name="product"
            defaultValue={config.product ?? ''}
            placeholder="What it makes (optional)"
          />
        </div>

        <textarea
          name="voice"
          rows={2}
          defaultValue={config.voice}
          placeholder="How replies should sound"
        />

        <textarea
          name="facts"
          rows={5}
          defaultValue={config.facts.join('\n')}
          placeholder={
            'One fact per line. Refund window, support hours, what the product cannot do —\n' +
            'short and load-bearing, because every one of these goes into every draft.'
          }
        />

        <div className="row">
          <input
            className="grow"
            type="text"
            name="signature"
            defaultValue={config.signature}
            placeholder="Signature, appended verbatim — e.g. — The Acme team"
          />
          <input
            type="text"
            name="replyLanguage"
            defaultValue={config.replyLanguage}
            placeholder="match"
            style={{ width: 110 }}
          />
          <button type="submit">Save</button>
        </div>
        <span className="meta">
          <code>match</code> answers in whatever language the customer wrote in. An ISO code like{' '}
          <code>en</code> forces one.
        </span>
      </form>

      <div className="card stack">
        <h2>What the model will be told</h2>
        <pre className="snippet" style={{ whiteSpace: 'pre-wrap' }}>
          {describeWorkspace(config)}
        </pre>
      </div>

      <div className="row">
        <span className="grow" />
        <a className="meta" href="/setup/done">
          Next: finish →
        </a>
      </div>
    </>
  );
}
