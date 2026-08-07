import { getWorkspaceConfig, describeWorkspace } from '@/lib/config/workspace';
import { LOCALES, locale, t } from '@/lib/i18n';
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
        <h2>{t('setup.voice.title')}</h2>
        <p className="meta">{t('setup.voice.intro')}</p>

        <div className="row">
          <input
            className="grow"
            type="text"
            name="organization"
            defaultValue={placeholder ? '' : config.organization}
            placeholder={t('setup.voice.organizationPlaceholder')}
          />
          <input
            className="grow"
            type="text"
            name="product"
            defaultValue={config.product ?? ''}
            placeholder={t('setup.voice.productPlaceholder')}
          />
        </div>

        <textarea
          name="voice"
          rows={2}
          defaultValue={config.voice}
          placeholder={t('setup.voice.voicePlaceholder')}
        />

        <textarea
          name="facts"
          rows={5}
          defaultValue={config.facts.join('\n')}
          placeholder={t('setup.voice.factsPlaceholder')}
        />

        <div className="row">
          <input
            className="grow"
            type="text"
            name="signature"
            defaultValue={config.signature}
            placeholder={t('setup.voice.signaturePlaceholder')}
          />
          <input
            type="text"
            name="replyLanguage"
            defaultValue={config.replyLanguage}
            placeholder={t('setup.voice.replyLanguagePlaceholder')}
            style={{ width: 110 }}
          />
          <input
            type="text"
            name="reviewLanguage"
            defaultValue={config.reviewLanguage}
            placeholder={t('setup.voice.reviewLanguagePlaceholder')}
            style={{ width: 110 }}
          />
          {/* Each language names itself, so the list is readable to someone who
              cannot read the language the page is currently in. */}
          <select name="language" defaultValue={locale()}>
            {Object.entries(LOCALES).map(([tag, name]) => (
              <option key={tag} value={tag}>
                {name}
              </option>
            ))}
          </select>
          <button type="submit">{t('setup.voice.save')}</button>
        </div>
        <span className="meta">
          {t('setup.voice.replyLanguageNoteBefore')} <code>match</code>{' '}
          {t('setup.voice.replyLanguageNoteMiddle')} <code>en</code>{' '}
          {t('setup.voice.replyLanguageNoteAfter')}
        </span>
        <span className="meta">
          {t('setup.voice.reviewLanguageNoteBefore')} <em>{t('setup.voice.reviewLanguageNoteYou')}</em>{' '}
          {t('setup.voice.reviewLanguageNoteAfter')}
        </span>
        <span className="meta">{t('setup.voice.uiLanguageNote')}</span>
      </form>

      <div className="card stack">
        <h2>{t('setup.voice.readbackTitle')}</h2>
        <pre className="block">{describeWorkspace(config)}</pre>
      </div>

      <div className="row">
        <span className="grow" />
        <a className="meta" href="/setup/done">
          {t('setup.voice.next')}
        </a>
      </div>
    </>
  );
}
