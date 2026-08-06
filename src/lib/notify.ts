/**
 * Telling somebody the software changed something by itself.
 *
 * Almost nothing here needs this. A draft waiting for review announces itself
 * by being in the queue the reviewer already looks at; a failed job is a red
 * row on a page. The exception is work that runs while nobody is watching and
 * edits something a human wrote — the weekly tidy of the rulebook is the whole
 * of that category today. Nobody opens the rules page on a Sunday night, so
 * without this the first anyone knows of a merge is a reply that quotes a
 * policy in words they do not recognise.
 *
 * One environment variable, no configuration file, no per-event switches. A
 * notification system with a settings screen is a second product; this is a
 * URL and a sentence.
 */

/**
 * Posts to `NOTIFY_WEBHOOK_URL`, if there is one.
 *
 * The body carries the text under both `content` and `text`, which is what
 * Discord and Slack respectively read, and each ignores the other's key. That
 * covers the two webhooks people actually have without asking anyone to
 * declare which one they are pointing at.
 *
 * Never throws and never returns a failure anyone has to handle: this is the
 * last thing that happens after work that has already succeeded, and a
 * notification that can fail a job would make the alerting the outage.
 */
export async function notify(text: string): Promise<boolean> {
  const url = process.env.NOTIFY_WEBHOOK_URL?.trim();
  if (!url || !text.trim()) return false;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) console.error(`[notify] webhook returned ${response.status}`);
    return response.ok;
  } catch (error) {
    console.error('[notify] could not post:', error);
    return false;
  }
}
