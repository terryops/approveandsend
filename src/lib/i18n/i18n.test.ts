import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetWorkspaceConfig } from '../config/workspace';
import { LOCALES, isLocale, locale, t, type Dictionary, type Locale } from './index';
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

beforeEach(() => speak(undefined));
afterEach(() => speak(undefined));

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
});
