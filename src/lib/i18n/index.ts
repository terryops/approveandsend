import { cache } from 'react';

import { getWorkspaceConfig, type WorkspaceConfig } from '../config/workspace';

import { de } from './de';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { ja } from './ja';
import { zhCN } from './zh-CN';

/**
 * The interface, in the language of the person using it.
 *
 * No i18n framework. The whole UI is fourteen server components and a few
 * hundred strings, and next-intl would add a middleware, a routing convention
 * and a provider to solve a problem that a lookup table solves — the same
 * argument as the missing CSS framework in globals.css.
 *
 * Three properties are worth more than the features that were skipped:
 *
 * **A missing translation cannot ship.** Every locale is typed as
 * `Dictionary`, so a key added to English and forgotten in Japanese is a
 * compile error, not a screen that reads `setup.mailbox.imapHost` at someone
 * in Tokyo.
 *
 * **No plurals engine.** English writes "3 new email(s)", so the source has
 * nothing for one to do. Translators phrase around counts the way that
 * language does. Chinese and Japanese have no plural agreement at all, and
 * inventing a CLDR rule table to serve two European languages that mostly
 * append -s would be the framework in miniature.
 *
 * **Server-only.** Every page here is server-rendered, so the language is
 * resolved once per request and the browser is never sent a dictionary.
 */

/** The languages with a translation, and what each one calls itself. */
export const LOCALES = {
  en: 'English',
  'zh-CN': '简体中文',
  ja: '日本語',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
} as const;

export type Locale = keyof typeof LOCALES;

/**
 * The same languages, named the way a prompt should name them.
 *
 * `LOCALES` is for a dropdown, where a language calls itself what its own
 * speakers call it. A model is told which language to write in in English,
 * because "write in 简体中文" is an instruction half in the answer — and
 * "Simplified Chinese" is unambiguous in a way that the bare tag `zh-CN` is
 * not.
 */
const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': 'Simplified Chinese',
  ja: 'Japanese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

/**
 * What language the people running this desk read.
 *
 * Used for the parts of a task that are written *about* an email rather than
 * *to* its sender: the one-line intent, the key points, the suggested actions.
 * Those are notes to a colleague, and a colleague who reads Chinese should not
 * have to read a Portuguese summary of a Portuguese complaint to find out
 * whether it is theirs. The reply itself still goes out in the customer's
 * language — that is a different question with a different answer.
 */
export function operatorLanguage(): string {
  return LOCALE_NAMES[locale()];
}

/**
 * English is the source; every other locale must answer every key it does.
 *
 * Keys from `en`, values widened to `string` — `typeof en` alone would carry
 * the English literals into the type and demand that German say "Inbox".
 */
export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;

export function isLocale(value: string): value is Locale {
  return Object.hasOwn(LOCALES, value);
}

/**
 * `zh` and `zh-TW` both mean the Chinese dictionary here, and `en-GB` means
 * English. Accepting only exact tags would reject the tag most people reach
 * for first.
 */
function normalise(tag: string): Locale | null {
  const clean = tag.trim().replace('_', '-');
  if (!clean) return null;
  if (isLocale(clean)) return clean;

  const base = clean.split('-')[0]?.toLowerCase() ?? '';
  if (base === 'zh') return 'zh-CN';
  if (isLocale(base)) return base;
  return null;
}

/**
 * Where the request's own language preference is kept while it renders.
 *
 * `cache()` gives one cell per request — React's own request scope, not a
 * module global, so two people loading the wizard at once do not overwrite
 * each other's browser language. Outside a render it is not memoised at all
 * and every caller gets a fresh empty cell, which is exactly the right answer
 * for the worker and the cron routes: they have no browser to ask.
 */
const requestCell = cache((): { locale: Locale | null } => ({ locale: null }));

function requestLocale(): Locale | null {
  try {
    return requestCell().locale;
  } catch {
    return null;
  }
}

/**
 * Read `Accept-Language` once, before anything on the page is translated.
 *
 * Awaited at the top of the root layout, which is the one component guaranteed
 * to run before every other. It has to be a separate step because `headers()`
 * is async and `t()` is not, and making `t()` async would put an `await` in
 * front of several hundred call sites to answer a question that changes once
 * per request.
 */
export async function resolveRequestLocale(): Promise<void> {
  let cell;
  try {
    cell = requestCell();
  } catch {
    return;
  }
  if (cell.locale) return;

  try {
    // Imported here rather than at the top of the file: this module is also
    // reached from the prompt builders, and those run in tests and workers
    // where `next/headers` has no request to talk to.
    const { headers } = await import('next/headers');
    cell.locale = fromAcceptLanguage((await headers()).get('accept-language'));
  } catch {
    // No request scope. English, then, unless the workspace says otherwise.
  }
}

/**
 * The best match for `zh-CN,zh;q=0.9,en;q=0.8`.
 *
 * Ordered by the browser's own q-values rather than by the order the tags
 * appear, because those disagree often enough to matter — and stably, so that
 * two tags of equal weight keep the order the browser sent them in.
 */
function fromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;

  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.split(';').map(piece => piece.trim());
      const q = params.find(piece => piece.startsWith('q='))?.slice(2);
      const weight = q === undefined ? 1 : Number.parseFloat(q);
      return { tag: tag ?? '', weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter(entry => entry.tag !== '' && entry.tag !== '*' && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  for (const entry of ranked) {
    const match = normalise(entry.tag);
    if (match) return match;
  }
  return null;
}

/**
 * `AAS_LANGUAGE`, then `language` in the workspace file, then the browser, then
 * English.
 *
 * The browser is consulted last and only while nobody has answered the question
 * — a fresh install, on its way through the wizard. Once someone picks a
 * language it is the desk's language and stays put: a support desk is a room of
 * people who share one, and a UI that changes shape depending on whose laptop is
 * open makes "the second field on the mailbox screen" impossible to say out loud
 * to a colleague. But *before* anyone has picked, the alternative to asking the
 * browser is not a stable shared language — it is English at a room that may not
 * read it, on the one screen whose whole job is being followed.
 *
 * Not cached, deliberately. `getWorkspaceConfig()` already caches the read,
 * so a second cache here would save one `trim()` and cost the wizard its
 * ability to change the language without a restart.
 */
export function locale(): Locale {
  const fromEnv = process.env.AAS_LANGUAGE?.trim();
  return (
    (fromEnv ? normalise(fromEnv) : null) ??
    normalise(getWorkspaceConfig().language) ??
    requestLocale() ??
    'en'
  );
}

/**
 * Whether the environment has already decided, and the in-app switch cannot.
 *
 * `AAS_LANGUAGE` outranks the workspace file, so on a desk that sets it the
 * header's language menu would write the file, reload, and come back in the same
 * language — a control that looks broken because it is being overruled. The
 * header shows the language as a fact instead of offering a choice it cannot
 * keep. Whoever set the variable can unset it.
 *
 * Set at all, not set to something this app understands. `loadWorkspaceConfig`
 * takes the variable over the file for any non-empty value, so `AAS_LANGUAGE=xx`
 * silences the file just as thoroughly as `AAS_LANGUAGE=ja` does — it just goes
 * on to fall through to the browser's header. Asking whether it *normalises*
 * offered the full menu on exactly that desk, and every choice in it was a
 * no-op: the file was written and the environment kept winning.
 */
export function localePinned(): boolean {
  return Boolean(process.env.AAS_LANGUAGE?.trim());
}

const DICTIONARIES: Record<Locale, Dictionary> = { en, 'zh-CN': zhCN, ja, es, fr, de };

/**
 * `t('inbox.synced', { count: 3 })`.
 *
 * An empty string in a locale falls back to English rather than rendering
 * blank — a half-finished translation should look unfinished, not broken.
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[locale()];
  const template = dictionary[key] || en[key] || key;

  return vars
    ? template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : whole,
      )
    : template;
}

/**
 * What to print where a topic appears, in the reader's language.
 *
 * Three answers, in order, and the order is the argument:
 *
 * 1. **The `label` in aas.config.json**, if this desk set one. Somebody who has
 *    written down what they call this topic has said the last word on it, and a
 *    dictionary shipped with the app does not get to overrule them.
 * 2. **A translation**, for the vocabulary a support desk usually has. `bug`,
 *    `refund`, `presales` — a Chinese reviewer was reading English slugs on
 *    every row of an otherwise Chinese screen, on the one cell that says what a
 *    message is *about*.
 * 3. **The slug**, unchanged. Scopes are free-form when no vocabulary is
 *    configured — the model writes them — so no dictionary can be complete, and
 *    a slug shown as itself is the honest answer rather than a wrong guess.
 *
 * Lives here and not beside `topicLabel` in `config/workspace` because it needs
 * both halves and that module cannot have this one: this file already imports
 * it, and the other direction would close the circle.
 *
 * The lookup is by slug, never by label — labels are edited and translated, and
 * a topic must not change what it is called because somebody renamed it.
 */
export function topicName(slug: string, config: WorkspaceConfig = getWorkspaceConfig()): string {
  const configured = config.topics.find(topic => topic.slug === slug)?.label;
  if (configured) return configured;

  const key = `topic.${slug}`;
  const dictionary: Record<string, string> = DICTIONARIES[locale()];
  return dictionary[key] || (en as Record<string, string>)[key] || slug;
}

/**
 * Slug to what it is called, for the search box — every name it answers to.
 *
 * Both the configured label and the translated one, because both are on the
 * screen: the label is what a desk with a vocabulary sees, the translation is
 * what everyone else sees, and somebody typing what they can read should find
 * the rows they are looking at. Slugs are left out on purpose — the scope
 * column is already matched directly, so listing them here would make the
 * search do the same work twice.
 */
export function topicNameMap(
  config: WorkspaceConfig = getWorkspaceConfig(),
): Record<string, string> {
  const map: Record<string, string> = {};
  const dictionary: Record<string, string> = DICTIONARIES[locale()];

  for (const topic of config.topics) {
    if (topic.label) map[topic.slug] = topic.label;
  }
  for (const key of Object.keys(en)) {
    if (!key.startsWith('topic.')) continue;
    const slug = key.slice('topic.'.length);
    if (map[slug]) continue;
    const name = dictionary[key] || (en as Record<string, string>)[key];
    if (name) map[slug] = name;
  }
  return map;
}
