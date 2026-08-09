import { type MessageKey } from '../i18n';

import { type CliKind } from './providers/cli';

/**
 * The services somebody might already have an account with, by name.
 *
 * The menu above the model box used to ask which *dialect* the endpoint speaks —
 * "OpenAI-compatible" or "Anthropic" — which is a question about wire formats
 * asked of somebody who wants to use the DeepSeek key they already have. They
 * then had to know that DeepSeek is one of the compatible ones, and go and find
 * `https://api.deepseek.com/v1` to paste into the box below. Two facts to look
 * up before the first draft, both of which are written down right here.
 *
 * So the menu names services and this table holds what each one implies: the
 * dialect (`AI_PROVIDER`), the address (`AI_BASE_URL`) and a shortlist of models
 * worth offering by name. Nothing in `.env` changed shape — the id below is a
 * fact about the menu, and `endpointFor` reads it back off the two variables
 * that were already there, so an `.env` written by hand or by an older version
 * still lands on the right line.
 *
 * The shortlists are shortlists on purpose. Nobody choosing a model here wants
 * to scroll past eighty ids to find the three that write English, no list in a
 * repository can be complete, and several of these services are only honest
 * with an empty one — what an Ollama has is whatever was pulled onto that
 * machine. Every model menu therefore ends in a way to type a name, and the
 * Test button is what says whether the name was right.
 */

/** What goes in `AI_PROVIDER`: the dialect, not the vendor. */
export type Wire = 'openai-compatible' | 'anthropic' | 'cli';

export interface Endpoint {
  /** The menu's own value. A fact about this screen; never written to `.env`. */
  id: string;
  /** What the service calls itself — a proper noun, so not in the dictionary. */
  name: string;
  /** For the two entries that are a sentence rather than a name. */
  label?: MessageKey;
  /**
   * Which side of the Great Firewall, for the services that run two.
   *
   * Appended to the name rather than folded into it, because "Moonshot Kimi" is
   * the proper noun in every language and "mainland China" is not. Only on the
   * services that are genuinely two doors — a separate account, a separate key,
   * a separate bill — where picking the wrong one fails as a 401 on a key the
   * console swears is valid.
   */
  region?: MessageKey;
  wire: Wire;
  /** Which local CLI, for the two entries whose wire is one. */
  cli?: CliKind;
  /** What goes in `AI_BASE_URL`. Empty where there is no one address. */
  baseUrl: string;
  /** Models worth offering by name, best first. */
  models: string[];
}

export const ENDPOINTS: Endpoint[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    wire: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    // Best first, cheapest last: the critic and the translator are two of the
    // four roles and neither of them needs the good model. Since 5.6 that is
    // one family in three sizes rather than three generations stacked up, so
    // the three lines differ in price and not in age. `gpt-4o` and
    // `gpt-4o-mini`, which were the bottom two, are retired.
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    // `deepseek-chat` and `deepseek-reasoner` stood here until DeepSeek retired
    // both names on 2026-07-24. They were also a thinking switch, which V4 is
    // not: one id takes both modes, so the menu is a size and not a mode.
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    wire: 'openai-compatible',
    // Alibaba's OpenAI-shaped door, which is a different path from DashScope's
    // own API and the one this app can speak.
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // The three standing tiers rather than whatever the flagship is called this
    // quarter. `qwen-max` is Alibaba's own name for its best text model and has
    // survived three generations of what sits behind it, which makes these the
    // only names in this table that cannot go stale.
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  /*
   * Two lines each for Moonshot and Zhipu, and it is not a courtesy.
   *
   * Both run a mainland platform and an international one, and the two are
   * separate products: separate sign-up, separate key, separate bill. A key
   * issued by one is rejected by the other — as a 401, which is
   * indistinguishable from a mistyped key and sends people to check the one
   * thing that is not wrong. One line with the other address in a comment left
   * exactly half the world guessing, and the address is the only part of this
   * screen a person cannot work out from what is on it.
   *
   * The model names are the same on both sides, so the shortlists are too.
   */
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    region: 'setup.model.regionChina',
    wire: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    // The K series. `moonshot-v1-8k` and its two siblings still answer, but
    // they are a generation back and differ from each other only in context
    // length — three lines of menu that say one thing, and not the useful one.
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'],
  },
  {
    id: 'moonshot-global',
    name: 'Moonshot Kimi',
    region: 'setup.model.regionGlobal',
    wire: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'],
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    region: 'setup.model.regionChina',
    wire: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // Flagship, workhorse, and the free 30B one at the bottom.
    models: ['glm-5.2', 'glm-4.7', 'glm-4.7-flash'],
  },
  {
    // Zhipu abroad is Z.ai, down to the name on the invoice — so the menu says
    // both, or somebody who signed up at z.ai never finds their own line.
    id: 'zhipu-global',
    name: 'Z.ai GLM',
    region: 'setup.model.regionGlobal',
    wire: 'openai-compatible',
    // The same path as the mainland one, on the other host.
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-5.2', 'glm-4.7', 'glm-4.7-flash'],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    wire: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    // Empty for OpenRouter's reason, arrived at the hard way: this is a host
    // rather than a model, its ids are `org/Model-Name` copied from whichever
    // repository it serves, and it had been offering DeepSeek-V3 and Qwen2.5
    // for two generations after both stopped being what anybody would pick.
    // The list is on the console, one paste away, and always right.
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    wire: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Deliberately empty: this one is a shop rather than a model, its ids are
    // `vendor/model` and the list turns over weekly. Typing the one you came
    // for beats picking from three that have gone.
    models: [],
  },
  {
    id: 'groq',
    name: 'Groq',
    wire: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    // The open-weight pair Groq points at now. `llama-3.3-70b-versatile` was
    // the one line here and is switched off on 2026-08-16.
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  {
    id: 'together',
    name: 'Together',
    wire: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    models: [],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    wire: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    // Whatever was pulled onto this machine, which no table here can know.
    models: [],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    wire: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
  },
  {
    // The escape hatch, and the reason none of the above has to be complete: a
    // gateway of your own, a region-specific address, a service that shipped
    // last week.
    id: 'custom',
    name: 'OpenAI-compatible',
    label: 'setup.model.providerOpenAiCompatible',
    wire: 'openai-compatible',
    baseUrl: '',
    models: [],
  },
  // Both halves of "which CLI" in one id, so the form does not grow a second
  // menu that means nothing for every line above.
  {
    id: 'cli:claude',
    name: 'Claude Code',
    label: 'setup.model.providerCliClaude',
    wire: 'cli',
    cli: 'claude',
    baseUrl: '',
    // Claude's CLI takes an alias for the latest of a family as well as a full
    // id — `--model opus`, per its own `--help` — and an alias is the better
    // name to offer, because it is the one here that cannot go stale.
    models: ['opus', 'sonnet', 'fable'],
  },
  {
    id: 'cli:codex',
    name: 'Codex',
    label: 'setup.model.providerCliCodex',
    wire: 'cli',
    cli: 'codex',
    baseUrl: '',
    // The same three sizes the OpenAI line above offers, because they are the
    // same three models — this route pays for them with a seat instead of a
    // key. No alias to hide behind here, unlike Claude's CLI: `gpt-5.3-codex`
    // stood in this list until it was deprecated for a CLI signed in with
    // ChatGPT, which is how this mode signs in.
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  },
];

/** The menu line with this id, if it is one we still offer. */
export function endpoint(id: string): Endpoint | undefined {
  return ENDPOINTS.find(entry => entry.id === id);
}

/** Trailing slashes and casing are not a difference between two addresses. */
function sameAddress(a: string, b: string): boolean {
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
}

/**
 * Which line of the menu an existing `.env` is already on.
 *
 * The id is never stored, so it has to be recovered from the two variables that
 * are: the dialect and the address. An address we do not recognise is not an
 * error — it is somebody's own gateway — and it lands on the custom entry with
 * their address still in the box beside it.
 */
export function endpointFor(wire: string, baseUrl: string, cli: string | null): string {
  if (wire === 'cli') return cli ? `cli:${cli}` : 'cli:claude';
  // One Anthropic entry, so any address on that dialect belongs to it — a
  // proxy in front of Anthropic is still Anthropic, and the box below keeps
  // whatever address was typed.
  if (wire === 'anthropic') return 'anthropic';
  if (!baseUrl) return 'openai';
  return (
    ENDPOINTS.find(
      entry =>
        entry.wire === 'openai-compatible' && entry.baseUrl && sameAddress(entry.baseUrl, baseUrl),
    )?.id ?? 'custom'
  );
}

/** What to offer in the model menu for a given line, best first. */
export function modelNames(id: string): string[] {
  return endpoint(id)?.models ?? [];
}

/**
 * The one to open the model menu on: the first, being the best each service has.
 *
 * Also what the one-click subscription button writes, so that pressing "use
 * this" and choosing the same subscription from the menu land on one model
 * rather than on two answers that both happen to work.
 */
export function suggestedModel(id: string): string {
  return modelNames(id)[0] ?? '';
}
