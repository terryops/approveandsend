/**
 * What the system knows about the person who wrote in, from somewhere other
 * than the email itself.
 *
 * A support reply is only as good as what the writer knows. "Have you tried
 * logging out?" to someone whose subscription lapsed yesterday is worse than
 * no reply at all, and the model cannot know that from the email — the fact
 * lives in Stripe, or a billing admin, or a CRM.
 *
 * So: a source is a read-only lookup that turns an email address into a small
 * block of facts, which goes two places — a card the reviewer can see, and a
 * paragraph in the drafting prompt.
 *
 * Two rules hold this interface together.
 *
 * **A source cannot act.** There is no `refund()`, no `cancel()`, no
 * `issueCredit()`, and there will not be one. The product's entire claim is
 * that a human approves what goes out; a model that could quietly cancel a
 * subscription while drafting a sentence about it would make that claim false.
 * Actions belong to buttons a person presses.
 *
 * **A source writes its own prose.** The obvious implementation hands back a
 * blob and lets the prompt `JSON.stringify` it, which is how the system this
 * replaced did it. It means the model spends tokens guessing whether
 * `"level": 2` is good or bad. A source knows; it should say so in a sentence.
 */

export interface ContextField {
  label: string;
  value: string;
  /** Links the value out to the system of record, for the reviewer. */
  href?: string;
}

export interface ContextBlock {
  /** Card heading. "Billing", not "StripeContextSourceResult". */
  title: string;
  /** What the reviewer sees. Short: this is a sidebar, not a report. */
  fields: ContextField[];
  /**
   * What the model reads — plain sentences, already interpreted.
   *
   * "Pro subscriber since March 2024, renews 12 August, has paid $418 in
   * total" beats the JSON it came from, and costs fewer tokens than it too.
   * Empty is fine where the `fields` already say it plainly — they are in the
   * prompt as well, and a sentence that only restates them is one both a
   * reviewer and a model read twice.
   */
  prompt: string;
  /** Opens the record itself. */
  href?: string;
}

/** Everything a source gets to work with. Deliberately little. */
export interface LookupSubject {
  taskId: string;
  /** The address that wrote in. The only field most sources need. */
  email: string;
  name: string | null;
  subject: string;
}

export interface ContextSource {
  /**
   * Stable slug. It is the storage key, so renaming one orphans whatever it
   * has already looked up rather than corrupting it.
   */
  id: string;
  /** Shown in the setup screen and in queue results. */
  label: string;
  /**
   * False when the source has no credentials and should be skipped silently.
   *
   * Built-in sources are always registered, so this is how Stripe stays out of
   * the way of an install that does not use Stripe. Absent means always on.
   */
  configured?(): boolean;
  /** Null when there is nothing to say about this person. Not an error. */
  lookup(subject: LookupSubject): Promise<ContextBlock | null>;
}

/** A block as stored, once a source has produced it. */
export interface StoredContext extends ContextBlock {
  taskId: string;
  sourceId: string;
  label: string;
  createdAt: string;
}

export function isContextSource(value: unknown): value is ContextSource {
  const source = value as ContextSource | null;
  return (
    !!source &&
    typeof source.id === 'string' &&
    source.id.trim() !== '' &&
    typeof source.label === 'string' &&
    typeof source.lookup === 'function'
  );
}

/**
 * Trust a source's shape no further than this.
 *
 * A source may be a file on disk that this repository has never seen, written
 * against an older version of the interface. It gets to fail its own lookup;
 * it does not get to put `undefined` into a template string on the review
 * screen.
 */
/**
 * A link the review screen may put in an `href`, or nothing.
 *
 * React escapes text; it does not sanitise URLs, so `javascript:alert(1)` in a
 * field a source returned runs with the reviewer's session the moment they
 * click it. The route that writes context takes these over HTTP, and a source
 * may be reflecting a string a customer typed, so this is reachable by someone
 * who never had an account. An allowlist of the two schemes a system-of-record
 * link is ever written in, and nothing else: not `data:`, not `vbscript:`, not
 * a bare word a browser would resolve into a scheme it knows.
 *
 * A path into this app is allowed too, because the built-in sources link that
 * way — but one leading slash only. `//evil.example` is a URL to another host
 * wearing a path's clothes, and it is the one that gets past a reader checking
 * for "starts with /".
 */
function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  // A backslash counts as a slash: URL parsers treat `/\evil.example` exactly
  // like `//evil.example`, so checking only for the second forward slash lets
  // the off-site link straight through.
  if (/^\/(?![/\\])/.test(trimmed)) return trimmed;
  return undefined;
}

export function coerceBlock(value: unknown): ContextBlock | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return null;

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  const fields = Array.isArray(raw.fields)
    ? raw.fields.flatMap((entry): ContextField[] => {
        const field = entry as Record<string, unknown> | null;
        if (!field || typeof field.label !== 'string') return [];
        const href = safeHref(field.href);
        return [
          {
            label: field.label.trim(),
            value: field.value == null ? '' : String(field.value).trim(),
            ...(href ? { href } : {}),
          },
        ];
      })
    : [];

  // Nothing to show and nothing to say is the same as no result at all.
  if (!title || (fields.length === 0 && !prompt)) return null;

  const href = safeHref(raw.href);
  return { title, fields, prompt, ...(href ? { href } : {}) };
}
