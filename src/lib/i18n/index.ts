import { getWorkspaceConfig } from '../config/workspace';

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
 * `AAS_LANGUAGE`, then `language` in the workspace file, then English.
 *
 * Deliberately not `Accept-Language`. A support desk is a room of people who
 * share a language, and a UI that changes shape depending on whose laptop is
 * open makes "the second field on the mailbox screen" impossible to say out
 * loud to a colleague.
 *
 * Not cached, deliberately. `getWorkspaceConfig()` already caches the read,
 * so a second cache here would save one `trim()` and cost the wizard its
 * ability to change the language without a restart.
 */
export function locale(): Locale {
  const fromEnv = process.env.AAS_LANGUAGE?.trim();
  return (fromEnv ? normalise(fromEnv) : null) ?? normalise(getWorkspaceConfig().language) ?? 'en';
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
