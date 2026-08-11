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
export const ALREADY = 'SAME';

/**
 * The two rules both prompts in this directory need, written once.
 *
 * `cards.ts` asks a different question of a different shape — a batch of labels
 * rather than a letter — but it needs these two answers to be the same, and for
 * a while it got them by keeping its own copy. Both copies were arrived at by
 * the same bug and annotated with the same paragraph, which is exactly the pair
 * that drifts: the Portuguese wording the comment below anticipates would have
 * landed in one file and silently not the other, leaving the mail half fixed
 * and the cards half not.
 *
 * The first rule is the expensive one. A regional variant of the target is the
 * target: without saying so, the tag `zh-CN` reads as an instruction to
 * convert, and a letter from Taipei came back rewritten into Simplified — a
 * paid model call whose entire output was a script change, and which cost the
 * reviewer the customer's own wording on the panel that exists to show them
 * exactly that. Written for any language rather than for Chinese: Brazilian and
 * European Portuguese are the same story.
 *
 * What neither rule says is how to *answer*, and that is on purpose: one of
 * these prompts translates a letter and the other a list, so "already in the
 * target language" is a whole reply in one and one item among ten in the other.
 * Each states its own; naming `SAME` here would have told the card prompt to
 * answer for a batch what was true of a single string in it.
 */
export function preservationRules(language: string): string[] {
  return [
    '- A different regional variant or script of the same language counts as',
    `  already being ${language} and does not need translating. Traditional and`,
    '  Simplified Chinese are one language here. Never convert between them,',
    '  and never transliterate one script into another.',
    "- Leave order numbers, error codes, account ids, people's names, language",
    '  tags, plan names, product names, URLs, email addresses and file names',
    '  exactly as they are.',
  ];
}

export function reviewLanguage(): string {
  return getWorkspaceConfig().reviewLanguage.trim();
}

export function translationEnabled(): boolean {
  return reviewLanguage() !== '';
}

/** The language part of a tag, or the whole of anything that is not one. */
function primarySubtag(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * Whether a reply this desk writes could be in a language the reviewer does not
 * read.
 *
 * The one question `translateForReview` cannot answer without being paid for.
 * Asking the model is right for the customer's letter: it arrives in whatever
 * language a stranger chose, and the regex that used to guess called
 * kanji-heavy Japanese Chinese. A reply is not that. This desk wrote it, and
 * `replyLanguage` is the instruction it was written to — so when that
 * instruction names the language the reviewer already reads, the answer is
 * `SAME` before the call is made.
 *
 * That call was neither free nor once. A no-op for mail stores nothing — see
 * `cardsAwaitingRendering`, which exists because of the same gap — so there is
 * no row afterwards saying "this needed nothing", and every edit to the draft
 * asked again, forever, on a desk whose replies were never going to be in
 * another language.
 *
 * `match` is the case that has to stay honest: it mirrors whatever the customer
 * wrote, so the language of the reply is not knowable from the config and the
 * model is the only thing that can say.
 *
 * Compared by primary subtag, which is the rule the prompt already gives the
 * model: `zh-TW` and `zh-CN` are one language here and neither is ever
 * converted into the other. The wizard takes free text, so "Chinese" is a
 * perfectly good answer to either field — that compares whole, and two fields
 * that disagree in shape simply fall through to asking.
 *
 * The trade, said out loud: a model that ignores `replyLanguage` and answers in
 * some third language leaves a reviewer with no rendering and no note saying
 * why. What is bought is that a single-language desk stops paying a model call
 * per draft edit to be told what its own configuration already says.
 */
export function repliesNeedRendering(): boolean {
  const review = reviewLanguage();
  if (!review) return false;

  const reply = getWorkspaceConfig().replyLanguage.trim();
  if (!reply || reply.toLowerCase() === 'match') return true;
  return primarySubtag(reply) !== primarySubtag(review);
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
    ...preservationRules(language),
    '- Otherwise reply with the translation and nothing else: no preamble, no',
    '  notes, no explanation of your choices, no quotation marks around it.',
    '- Keep the line breaks and paragraph structure of the original.',
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
