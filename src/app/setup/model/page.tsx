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
        <h2>2. Pick a model</h2>
        <p className="meta">
          Anything that speaks the OpenAI chat API works — OpenAI, an Anthropic key, OpenRouter,
          Together, or Ollama and vLLM on your own hardware. One model does all four jobs unless you
          split them later.
        </p>

        <div className="row">
          <select name="provider" defaultValue={provider} style={{ width: 200 }}>
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <input
            className="grow"
            type="text"
            name="model"
            defaultValue={model}
            placeholder="Model name, e.g. gpt-4o-mini or claude-sonnet-4-5"
          />
        </div>

        <input
          type="text"
          name="baseUrl"
          defaultValue={baseUrl}
          placeholder="Base URL — blank for the provider default, or http://localhost:11434/v1 for Ollama"
        />

        <input
          type="password"
          name="apiKey"
          autoComplete="off"
          placeholder={hasKey ? 'A key is saved — leave blank to keep it' : 'API key (blank for a local model)'}
        />

        <div className="row">
          <span className="grow meta">
            Saved keys are never sent back to this page, which is why the box looks empty.
          </span>
          <button type="submit">Save</button>
        </div>
      </form>

      <LastCheck step="model" />

      <div className="row">
        <form action={testModel}>
          <button type="submit" disabled={!model}>
            Test it
          </button>
        </form>
        <span className="grow meta">
          Asks the model for one word, through the same code path that writes drafts. A pass here
          means drafting will run.
        </span>
        <a className="meta" href="/setup/mailbox">
          Next: the mailbox →
        </a>
      </div>
    </>
  );
}
