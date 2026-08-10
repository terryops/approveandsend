/**
 * A message cut into the paragraphs it means, rather than the ones it typed.
 *
 * Splitting on a run of newlines was already most of the job, and it was
 * missing the case that actually arrives. Real mail is full of lines that look
 * blank and are not: a space, a tab, a non-breaking space left behind when an
 * HTML signature was flattened into text. `\n \n` is one newline twice over as
 * far as a splitter is concerned, so a gap the sender left between two
 * paragraphs came through as a paragraph — an empty `<p>` carrying a full line
 * box and a 12px margin, and three of them in a row down the middle of a
 * letter. Which is what a lot of customer mail looks like: a footer separated
 * from the message by half a screen, and a reviewer scrolling a pane to reach
 * text that would have fitted in it.
 *
 * So each line is stripped of its trailing whitespace first, which turns the
 * lines that only look blank into lines that are, and then a run of them is one
 * separator however long it ran. Empty blocks are dropped rather than rendered,
 * which covers the leading and trailing ones no split can see.
 *
 * At render, deliberately, not at ingest. What the customer sent is what is
 * stored and stays recoverable — this is about how it is set on a page, the
 * same kind of decision as the 12px gap between blocks, and doing it here means
 * it applies to mail already in the database rather than only to mail that
 * arrives after the change.
 *
 * Only the *blank* lines go. A sender who hard-wrapped their paragraph at 78
 * columns still gets every one of those breaks: they are single newlines inside
 * a block, and `pre-wrap` is what renders them.
 */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+$/u, ''))
    .join('\n')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(block => block !== '');
}
