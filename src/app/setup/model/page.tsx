import { t } from '@/lib/i18n';
import { envFilePath } from '@/lib/setup/env-file';

import { saveModel, testModel } from '../actions';
import { LastCheck, Notice, type Query } from '../notice';

export const dynamic = 'force-dynamic';

/** The one required step: without a model there is nothing to draft with. */
export default async function ModelPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;

  const provider = process.env.AI_PROVIDER?.trim() || 'openai-compatible';
  const model = process.env.AI_MODEL?.trim() ?? '';
  const baseUrl = process.env.AI_BASE_URL?.trim() ?? '';
  const hasKey = (process.env.AI_API_KEY?.trim() ?? '') !== '';

  return (
    <>
      <Notice query={query} path={envFilePath()} />

      <form className="card stack" action={saveModel}>
        <h2>{t('setup.model.title')}</h2>
        <p className="meta">{t('setup.model.intro')}</p>

        <div className="row">
          <select name="provider" defaultValue={provider} style={{ width: 200 }}>
            <option value="openai-compatible">{t('setup.model.providerOpenAiCompatible')}</option>
            <option value="anthropic">{t('setup.model.providerAnthropic')}</option>
          </select>
          <input
            className="grow"
            type="text"
            name="model"
            defaultValue={model}
            placeholder={t('setup.model.namePlaceholder')}
          />
        </div>

        <input
          type="text"
          name="baseUrl"
          defaultValue={baseUrl}
          placeholder={t('setup.model.baseUrlPlaceholder')}
        />

        <input
          type="password"
          name="apiKey"
          autoComplete="off"
          placeholder={hasKey ? t('setup.model.apiKeySavedPlaceholder') : t('setup.model.apiKeyPlaceholder')}
        />

        <div className="row">
          <span className="grow meta">{t('setup.model.savedKeyNote')}</span>
          <button type="submit">{t('setup.model.save')}</button>
        </div>
      </form>

      <LastCheck step="model" />

      <div className="row">
        <form action={testModel}>
          <button type="submit" disabled={!model}>
            {t('setup.model.test')}
          </button>
        </form>
        <span className="grow meta">{t('setup.model.testNote')}</span>
        <a className="meta" href="/setup/mailbox">
          {t('setup.model.next')}
        </a>
      </div>
    </>
  );
}
