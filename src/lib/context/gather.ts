import { getDb, type Db } from '../db';
import type { Task } from '../tasks/types';
import { listContextSources } from './registry';
import { listContext, saveContext } from './store';
import { coerceBlock, type ContextSource, type StoredContext } from './types';

/**
 * Running every source over one email.
 *
 * In parallel, and independently: a CRM that is down must not stop the billing
 * lookup, and neither must stop the draft. A source that throws is recorded as
 * a failure in the job result and otherwise ignored — the reply gets written
 * with less information, which is exactly what would have happened before the
 * source existed.
 */

export interface GatherResult {
  /** Sources that returned something. */
  found: string[];
  /** Sources that had nothing to say. Not a problem. */
  empty: string[];
  /** Sources that broke, with why. Surfaced in the queue view. */
  failed: { id: string; error: string }[];
}

export interface GatherOptions {
  db?: Db;
  /** Override the registry. */
  sources?: ContextSource[];
}

export async function gatherContext(task: Task, options: GatherOptions = {}): Promise<GatherResult> {
  const db = options.db ?? getDb();
  const sources = options.sources ?? (await listContextSources());

  const result: GatherResult = { found: [], empty: [], failed: [] };
  if (!task.fromAddress) return result;

  const subject = {
    taskId: task.id,
    email: task.fromAddress,
    name: task.fromName,
    subject: task.subject,
  };

  const settled = await Promise.all(
    sources.map(async source => {
      try {
        // `coerceBlock` rather than trusting the return value: an external
        // source is code this repository has never seen.
        const block = coerceBlock(await source.lookup(subject));
        return { source, block, error: null as string | null };
      } catch (error) {
        return { source, block: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  for (const { source, block, error } of settled) {
    if (error) result.failed.push({ id: source.id, error });
    else if (!block) result.empty.push(source.id);
    else {
      saveContext(task.id, source.id, source.label, block, db);
      result.found.push(source.id);
    }
  }

  return result;
}

/**
 * The block of the drafting prompt that says who this person is.
 *
 * Sources that returned display-only fields contribute nothing here, which is
 * the point of them being separable: an internal ticket id is worth showing a
 * human and worth no tokens at all.
 */
export function describeContext(blocks: StoredContext[]): string {
  const usable = blocks.filter(block => block.prompt.trim() !== '');
  if (usable.length === 0) return '';

  return (
    '\n\n## What we already know about this person\n' +
    'From our own records, not from their email. Treat it as true, and do not repeat it back to them unprompted.\n' +
    usable.map(block => `\n### ${block.title}\n${describeFields(block.fields)}${block.prompt}`).join('')
  );
}

/**
 * The card's own values, on the line above its prose.
 *
 * A source writes a sentence for the model and a handful of labelled values
 * for the reviewer, and until now only the sentence was spent tokens on. That
 * held as long as the two said the same thing, and they do not: the account
 * card names the customer, and a drafter that greeted them by that name was
 * marked down for inventing it, because the name was on the card and not in
 * the paragraph. A source should not have to write every value twice to get it
 * read.
 *
 * Cheap, because these are already short — a name, a plan, a number of
 * credits. One line, in the order the source chose, which is the order it
 * considered them worth.
 */
function describeFields(fields: StoredContext['fields']): string {
  const said = fields
    .filter(field => field.label.trim() !== '' && field.value.trim() !== '')
    .map(field => `${field.label.trim()}: ${field.value.trim()}`);

  return said.length === 0 ? '' : `${said.join(' · ')}\n`;
}

export function contextForPrompt(taskId: string, db: Db = getDb()): string {
  return describeContext(listContext(taskId, db));
}
