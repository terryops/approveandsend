import { callAI } from '../ai';
import { getWorkspaceConfig } from '../config/workspace';

/**
 * Rendering mail into the language the reviewer reads.
 *
 * This is not the same feature as `replyLanguage`, and conflating the two is
 * the mistake worth avoiding. `replyLanguage` decides what the customer
 * receives; this decides what the person approving it can read. A team in
 * Guangzhou answering a French customer needs both: a reply in French, and a
 * Chinese rendering of that reply so that clicking Send is a decision rather
 * than a leap of faith.
 *
 * Nothing produced here is ever sent to anyone.
 */

/** The marker the model returns instead of translating text already in target. */
const ALREADY = 'SAME';

export function reviewLanguage(): string {
  return getWorkspaceConfig().reviewLanguage.trim();
}

export function translationEnabled(): boolean {
  return reviewLanguage() !== '';
}

function prompt(text: string, language: string): string {
  return [
    `Translate the text below into ${language}.`,
    '',
    'It is being read by a support agent who is about to approve or reject it.',
    'They will never send your translation to anyone — it exists only so they',
    'understand what they are approving.',
    '',
    'Rules:',
    `- If the text is already written in ${language}, reply with exactly: ${ALREADY}`,
    // A regional variant of the target is the target. Without this the tag
    // `zh-CN` reads as an instruction to convert, so a letter from Taipei came
    // back rewritten into Simplified — a paid model call whose entire output
    // was a script change, and which cost the reviewer the customer's own
    // wording on the panel that exists to show them exactly that. The rule is
    // written for any language, not just Chinese: Brazilian and European
    // Portuguese are the same story.
    '- A different regional variant or script of the same language counts as',
    `  already being ${language}: answer ${ALREADY} for it. Traditional and`,
    '  Simplified Chinese are one language here. Never convert between them,',
    '  and never transliterate one script into another.',
    '- Otherwise reply with the translation and nothing else: no preamble, no',
    '  notes, no explanation of your choices, no quotation marks around it.',
    '- Keep the line breaks and paragraph structure of the original.',
    '- Leave order numbers, error codes, URLs, email addresses, file names and',
    '  product names exactly as they are.',
    '',
    '--- TEXT ---',
    text,
  ].join('\n');
}

/**
 * Returns the translation, or `null` when there is nothing to translate.
 *
 * "Nothing to translate" covers empty input and text the model says is already
 * in the target language. Asking the model rather than guessing is deliberate:
 * the system this replaced decided with a regex counting CJK characters, in
 * five copies that had drifted apart, and its own comments admit it
 * "misclassifies kanji-heavy Japanese as Chinese" — so Japanese mail reached a
 * Chinese-reading reviewer untranslated. One cheap call, on the `translator`
 * role so it can be pointed at a small model, buys the whole class of bug.
 */
export async function translateForReview(
  text: string,
  language: string = reviewLanguage(),
): Promise<string | null> {
  const source = text?.trim() ?? '';
  if (!source || !language) return null;

  const answer = (await callAI(prompt(source, language), { role: 'translator' })).trim();

  if (!answer || answer === ALREADY) return null;
  // Models like to be helpful about it. "SAME — this is already in Chinese."
  if (answer.startsWith(ALREADY) && answer.length < ALREADY.length + 80) return null;

  return answer;
}
