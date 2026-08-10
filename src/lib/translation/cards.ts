import { callAI } from '../ai';
import type { ContextField } from '../context/types';
import { extractJson } from '../json-repair';

/**
 * The context cards, in the language the desk reads.
 *
 * A source writes its own prose — that is the rule the whole context interface
 * is built on — and the prose it writes is whatever language its author was
 * thinking in. The built-in ones are English because this repository is; a
 * declarative source is English because the config file it lives in was
 * written next to an internal endpoint whose fields are called `plan` and
 * `credits`. Neither had any way of knowing that the person reading the card
 * runs the desk in Chinese, and until this file the answer was that they read
 * "They registered on April 3, 2025 and are user 191566" in English, on a
 * screen where every other word had been translated.
 *
 * So this is not the same job as `translate.ts`, and the difference is the
 * language each targets. That file renders *mail* into `reviewLanguage` — what
 * the customer wrote and what we are about to send back. This renders the
 * desk's own furniture into the interface language, because a card is a piece
 * of the interface that happens to have been written somewhere else.
 *
 * Nothing here touches what the model was told. The card is the human's copy;
 * `prompt` as stored still goes into the drafting prompt in the words the
 * source wrote it in.
 */

/** The translatable half of a stored context block. */
export interface Card {
  sourceId: string;
  title: string;
  fields: ContextField[];
  prompt: string;
}

export interface RenderedCard {
  title: string;
  fields: { label: string; value: string }[];
  prompt: string;
}

/** Rendered cards by source id, which is how they are stored and looked up. */
export type RenderedCards = Record<string, RenderedCard>;

/**
 * The exact text a rendering was made from.
 *
 * Fingerprinted like every other translation, so a card that changed — a
 * subscription that lapsed between one lookup and the next — reads as
 * untranslated rather than as last week's answer with this week's numbers
 * missing. Field order and source id are in it: two cards that swapped places
 * are not the same card.
 */
export function cardsSource(cards: Card[]): string {
  return JSON.stringify(
    cards.map(card => [card.sourceId, card.title, card.fields.map(f => [f.label, f.value]), card.prompt]),
  );
}

/**
 * Whether there is anything here for a translator to do.
 *
 * `200`, `100%` and `2026-05-10` are values, not words, and sending them costs
 * a token to be told what we already knew — or worse, comes back as
 * `百分之一百`. Anything with a letter in it goes, including `Pro` and
 * `zh-TW`: those are for the model to leave alone, and it is told to.
 */
function translatable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return !/^[\p{N}\p{P}\p{S}\s]+$/u.test(trimmed);
}

function prompt(texts: string[], language: string): string {
  return [
    `Translate each string below into ${language}.`,
    '',
    'They are the labels and sentences on a card shown to a support agent: what',
    'another system knows about the person who wrote in. Nothing here is ever',
    'sent to anyone.',
    '',
    'Rules:',
    '- Reply with the same number of strings, in the same order. One in, one out.',
    `- A string already written in ${language} comes back unchanged.`,
    // The same rule `translate.ts` carries, and for the same reason: a card
    // looked up for a customer in Taipei must not have their own name and plan
    // converted to Simplified on the way to a Simplified-reading desk.
    '- A different regional variant or script of the same language counts as',
    `  already being ${language}. Traditional and Simplified Chinese are one`,
    '  language here: never convert between them, and never transliterate one',
    '  script into another.',
    "- Leave people's names, account ids, order numbers, error codes, language",
    '  tags, plan names, product names, URLs and email addresses exactly as they',
    '  are. A value like "Pro" or "191566" is not a word to translate.',
    '- No preamble, no notes, no quotation marks around anything.',
    '',
    'JSON only, no prose around it:',
    '{"text": ["...", "..."]}',
    '',
    '--- TEXT ---',
    JSON.stringify({ text: texts }),
  ].join('\n');
}

/**
 * One call for every card on the task, or nothing.
 *
 * Deduplicated first: three sources with a `Plan` row each is one string, and
 * translating it once is both cheaper and the only way the three of them come
 * back reading the same. The answer has to line up exactly — same count, same
 * order — because the strings are matched back by position, and a model that
 * merged two of them would otherwise put the second card's label on the first.
 * A mismatch returns null and the caller stores nothing, which shows the
 * reviewer the card as its source wrote it: the behaviour of yesterday, rather
 * than a card with a word from somewhere else in it.
 */
export async function translateCards(cards: Card[], language: string): Promise<RenderedCards | null> {
  if (cards.length === 0 || !language.trim()) return null;

  const texts = [
    ...new Set(
      cards
        .flatMap(card => [card.title, ...card.fields.flatMap(f => [f.label, f.value]), card.prompt])
        .filter(translatable),
    ),
  ];

  // A card of nothing but numbers is rendered as itself rather than as a
  // failure: there was nothing to ask, and the row saying so is what stops the
  // next job asking again.
  const into = new Map(texts.map(text => [text, text]));

  if (texts.length > 0) {
    const answer = extractJson<Record<string, unknown>>(await callAI(prompt(texts, language), { role: 'translator' }));
    const rendered = Array.isArray(answer?.text) ? answer.text : null;
    if (!rendered || rendered.length !== texts.length) return null;

    texts.forEach((text, i) => {
      const answered = rendered[i];
      if (typeof answered === 'string' && answered.trim() !== '') into.set(text, answered.trim());
    });
  }

  return Object.fromEntries(
    cards.map(card => [
      card.sourceId,
      {
        title: into.get(card.title) ?? card.title,
        fields: card.fields.map(field => ({
          label: into.get(field.label) ?? field.label,
          value: into.get(field.value) ?? field.value,
        })),
        prompt: into.get(card.prompt) ?? card.prompt,
      },
    ]),
  );
}

/** What was stored, or null. A garbled row costs the reviewer a rendering. */
export function parseCards(content: string | undefined): RenderedCards | null {
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RenderedCards;
  } catch {
    return null;
  }
}

/**
 * A card as it should appear, falling back a field at a time.
 *
 * Merged by index rather than replaced wholesale, because `href` is not
 * translated and must not move: the link to the billing record belongs to the
 * row it was looked up for, and a rendering one field short would otherwise
 * hand it to the row below.
 */
export function renderCard(
  card: Card,
  cards: RenderedCards | null,
): { title: string; fields: ContextField[]; prompt: string } {
  const into = cards?.[card.sourceId];
  if (!into) return { title: card.title, fields: card.fields, prompt: card.prompt };

  return {
    title: typeof into.title === 'string' && into.title.trim() !== '' ? into.title : card.title,
    fields: card.fields.map((field, i) => {
      const to = into.fields?.[i];
      return {
        ...field,
        label: typeof to?.label === 'string' && to.label.trim() !== '' ? to.label : field.label,
        value: typeof to?.value === 'string' && to.value.trim() !== '' ? to.value : field.value,
      };
    }),
    prompt: typeof into.prompt === 'string' && into.prompt.trim() !== '' ? into.prompt : card.prompt,
  };
}
