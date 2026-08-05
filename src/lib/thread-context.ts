/**
 * Thread context builder.
 *
 * The naive version of this dumps the entire thread — raw HTML, every message —
 * straight into the prompt. In production one support thread reached 1.4 MB
 * (10 messages, largest 193 KB) and every generation on it died with
 * `fetch failed` after 60-80s. Trimming here keeps prompts to a sane size:
 * strip HTML to text, keep only the most recent messages, cap per-message and
 * total length. On that same thread it took the prompt from 1237 KB to 26 KB.
 */

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#160': ' ',
};

/** Best-effort HTML → plain text. Not a parser; good enough to feed a model. */
export function htmlToText(input: string): string {
  if (!input) return '';
  if (!/<[a-z!/]/i.test(input)) return input.replace(/[ \t]+\n/g, '\n').trim();

  return input
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-z]+|#\d+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // Keep the tail: in a quoted email the newest content sits at the end.
  const omitted = text.length - max;
  return `…(${omitted} characters omitted)\n` + text.slice(omitted);
}

export interface ThreadMessage {
  from?: string;
  body?: string;
  /** ISO timestamp; used to interleave inbound and outbound messages. */
  receivedAt: string;
}

export interface ThreadContextOptions {
  /** How many of the most recent messages to keep. */
  maxMessages?: number;
  /** Per-message character cap after HTML stripping. */
  maxCharsPerMessage?: number;
  /** Cap for the whole rendered block. */
  maxTotalChars?: number;
  /** Label for messages from the other party. */
  inboundLabel?: string;
  /** Label for messages we sent. */
  outboundLabel?: string;
  /** Text appended after the history block. */
  footer?: string;
}

export const THREAD_DEFAULTS = {
  maxMessages: 4,
  maxCharsPerMessage: 8000,
  maxTotalChars: 40000,
  inboundLabel: 'Customer',
  outboundLabel: 'Support',
  footer: '**--- end of conversation history ---**',
} as const;

/**
 * Render the conversation history for a follow-up email, oldest → newest.
 * Returns '' when there is nothing to show.
 */
export function buildThreadContext(
  inbound: ThreadMessage[] | undefined,
  outbound: ThreadMessage[] | undefined,
  options: ThreadContextOptions = {},
): string {
  const {
    maxMessages = THREAD_DEFAULTS.maxMessages,
    maxCharsPerMessage = THREAD_DEFAULTS.maxCharsPerMessage,
    maxTotalChars = THREAD_DEFAULTS.maxTotalChars,
    inboundLabel = THREAD_DEFAULTS.inboundLabel,
    outboundLabel = THREAD_DEFAULTS.outboundLabel,
    footer = THREAD_DEFAULTS.footer,
  } = options;

  const all = [
    ...(inbound ?? []).map(m => ({ role: inboundLabel, body: m.body ?? '', time: m.receivedAt })),
    ...(outbound ?? []).map(m => ({ role: outboundLabel, body: m.body ?? '', time: m.receivedAt })),
  ].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  if (all.length === 0) return '';

  const dropped = Math.max(0, all.length - maxMessages);
  const kept = all.slice(-maxMessages);

  const rendered = kept
    .map(m => `[${m.role}] (${m.time}):\n${clip(htmlToText(m.body), maxCharsPerMessage)}`)
    .join('\n\n---\n\n');

  const notice =
    dropped > 0 ? `(${dropped} older messages omitted; showing the latest ${kept.length})\n` : '';

  return `\n**This is a follow-up. Earlier messages in this thread:**\n${notice}${clip(rendered, maxTotalChars)}\n${footer}\n`;
}

/** Same trimming for a single email body (the latest inbound message). */
export function trimEmailBody(body: string, maxChars = 20000): string {
  return clip(htmlToText(body || ''), maxChars);
}
