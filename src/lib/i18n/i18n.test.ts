import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetWorkspaceConfig } from '../config/workspace';
import {
  LOCALES,
  deskLanguage,
  isLocale,
  locale,
  operatorLanguage,
  t,
  type Dictionary,
  type Locale,
} from './index';
import { de } from './de';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { ja } from './ja';
import { zhCN } from './zh-CN';

const TRANSLATIONS: Record<Exclude<Locale, 'en'>, Dictionary> = {
  'zh-CN': zhCN,
  ja,
  es,
  fr,
  de,
};

function speak(tag: string | undefined): void {
  if (tag === undefined) delete process.env.AAS_LANGUAGE;
  else process.env.AAS_LANGUAGE = tag;
  resetWorkspaceConfig();
}

// "Nothing asks otherwise" has to mean nothing, and the config file is read
// from the working directory — so without this the suite passes or fails
// depending on whether whoever is running it has configured their own
// checkout. It did fail that way, on a file added the same afternoon.
beforeEach(() => {
  process.env.AAS_CONFIG = '/nonexistent/aas.config.json';
  speak(undefined);
});
afterEach(() => {
  delete process.env.AAS_CONFIG;
  speak(undefined);
});

describe('choosing a language', () => {
  it('speaks English when nothing asks otherwise', () => {
    expect(locale()).toBe('en');
  });

  it('takes the tag from the environment', () => {
    speak('ja');
    expect(locale()).toBe('ja');
  });

  it('accepts the tag people actually type', () => {
    // Rejecting `zh` for not being `zh-CN` would reject the first thing most
    // people reach for.
    for (const [tag, expected] of [
      ['zh', 'zh-CN'],
      ['zh-TW', 'zh-CN'],
      ['zh_CN', 'zh-CN'],
      ['en-GB', 'en'],
      ['de-AT', 'de'],
      ['  fr  ', 'fr'],
    ] as const) {
      speak(tag);
      expect(locale(), tag).toBe(expected);
    }
  });

  it('falls back to English rather than failing on a language it does not have', () => {
    speak('sv');
    expect(locale()).toBe('en');
  });

  it('names the language for a model, and names it the same way in a job', () => {
    speak('zh-CN');
    // The name a prompt uses, rather than the name the language calls itself:
    // "write in 简体中文" is an instruction half in the answer.
    expect(operatorLanguage()).toBe('Simplified Chinese');
    // And the settled one, which has to agree wherever it is asked. A card
    // rendering is stored by a worker under this name and looked up by a page
    // under it; two answers to the same question is a row that can never be
    // found and, because the job's own check finds it perfectly well, is never
    // made again.
    expect(deskLanguage()).toBe(operatorLanguage());
  });

  it('settles on English for a job when nobody has chosen a language', () => {
    speak(undefined);
    // `locale()` would ask the browser at this point, which is right for a
    // screen and impossible for a worker — there is no request to ask. So this
    // stops one step earlier, and stops in the same place every time.
    expect(deskLanguage()).toBe('English');
  });

  it('knows which tags it can honour', () => {
    expect(isLocale('ja')).toBe(true);
    expect(isLocale('sv')).toBe(false);
    // Guards against a `LOCALES` entry that no dictionary answers.
    expect(Object.keys(LOCALES).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'zh-CN']);
  });
});

describe('rendering a message', () => {
  it('returns the string for the current language', () => {
    expect(t('nav.inbox')).toBe(en['nav.inbox']);
    speak('ja');
    expect(t('nav.inbox')).toBe(ja['nav.inbox']);
  });

  it('substitutes named values', () => {
    expect(t('task.noTranslation', { language: 'Chinese' })).toContain('Chinese');
  });

  it('leaves a placeholder alone when nothing was passed for it', () => {
    // Better a visible `{language}` than a sentence with a hole where the
    // subject used to be.
    expect(t('task.noTranslation', { nothing: 'x' })).toContain('{language}');
  });

  it('ignores extra values', () => {
    expect(() => t('nav.inbox', { unused: 1 })).not.toThrow();
  });
});

describe('the translations themselves', () => {
  const keys = Object.keys(en) as (keyof Dictionary)[];

  it('has something to say for every key in every language', () => {
    for (const [tag, dictionary] of Object.entries(TRANSLATIONS)) {
      const blank = keys.filter(key => !dictionary[key]?.trim());
      expect(blank, `${tag} is missing: ${blank.join(', ')}`).toEqual([]);
    }
  });

  it('keeps every placeholder the English sentence had', () => {
    // A dropped `{count}` is invisible in review and reads as a missing number
    // to whoever is using that language.
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

    for (const [tag, dictionary] of Object.entries(TRANSLATIONS)) {
      for (const key of keys) {
        expect(placeholders(dictionary[key]), `${tag} · ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it('carries no markup, because the JSX lives in the component', () => {
    for (const [tag, dictionary] of Object.entries({ en, ...TRANSLATIONS })) {
      for (const key of keys) {
        expect(dictionary[key], `${tag} · ${key}`).not.toMatch(/<\/?[a-z]|&[a-z]+;/i);
      }
    }
  });

  it('is actually translated, not copied from English', () => {
    // Not every string differs — "Email" is "Email" in three of these — but a
    // language that matches English almost everywhere was never translated.
    for (const [tag, dictionary] of Object.entries(TRANSLATIONS)) {
      const same = keys.filter(key => dictionary[key] === en[key]);
      expect(same.length / keys.length, `${tag} is ${same.length}/${keys.length} English`).toBeLessThan(0.3);
    }
  });

  /*
   * The cost of having no plurals engine, and the one thing that has to be paid
   * for it.
   *
   * English writes "3 new email(s)" because it cannot do better without a CLDR
   * rule table, and the argument for skipping that table is that every other
   * language phrases around the count the way it actually does. French had
   * instead copied the parenthesis and then agreed it three times in a row —
   * "{count} tâche(s) bloquée(s) récupérée(s)" — which is not a translation of
   * the English so much as a translation of its shrug.
   *
   * English is exempt, because it is where the shrug belongs.
   */
  it('phrases around counts instead of copying the English hedge', () => {
    for (const [tag, dictionary] of Object.entries(TRANSLATIONS)) {
      for (const key of keys) {
        expect(dictionary[key], `${tag} · ${key}`).not.toMatch(/\w\((?:s|es|n|e|en|a|as|os)\)/i);
      }
    }
  });

  /*
   * Punctuation set the way each language sets it.
   *
   * Every one of these was mixed in the same file before it was a test: the
   * typewriter apostrophe on one French line and the typographic one on the
   * next, a half-width colon after Japanese, a space wedged against a Chinese
   * full-width comma — which already carries its own. None of it is visible in
   * a diff and all of it is visible on the screen.
   */
  it('sets its punctuation the way its own language does', () => {
    const CJK = '一-鿿';

    for (const key of keys) {
      // French has one apostrophe and it is not the typewriter's.
      expect(TRANSLATIONS.fr[key], `fr · ${key}`).not.toMatch(/'/);

      // A colon after Japanese is a full-width colon.
      expect(TRANSLATIONS.ja[key], `ja · ${key}`).not.toMatch(/[぀-ヿ一-鿿] *:/);

      // Chinese full-width punctuation is its own whitespace; a space beside it
      // sets the line twice as loose as the ones around it.
      expect(TRANSLATIONS['zh-CN'][key], `zh-CN · ${key}`).not.toMatch(/[，。、；：？！“”（）] | [，。、；：？！“”（）]/);

      // …and a Latin word or a number inside a Chinese sentence takes one.
      expect(TRANSLATIONS['zh-CN'][key], `zh-CN · ${key}`).not.toMatch(
        new RegExp(`[${CJK}][A-Za-z0-9{]|[A-Za-z0-9}][${CJK}]`),
      );
    }
  });
});
