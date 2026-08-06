import { callAI } from '../ai';
import { getWorkspaceConfig } from '../config/workspace';
import { mailProvider } from '../mail/config';

/**
 * Does it actually work?
 *
 * A setup form that only stores what you typed has not helped: the first sign
 * of a wrong password or a misread port is a failed job at 4am, by which time
 * the thing you changed is four screens behind you. So each step ends by using
 * the credentials for real — one small completion, one inbox listing — and
 * reports what came back.
 *
 * Every check returns rather than throws. A failed check is expected output,
 * not an exception: it is the reason the user is on this page.
 */

export interface CheckResult {
  ok: boolean;
  /** One line, shown verbatim. Says what happened, not what to feel about it. */
  detail: string;
}

/** Provider errors are long, multi-line and often carry a whole HTML page. */
function summarise(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n').find(line => line.trim() !== '')?.trim() ?? 'Unknown error';
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}…` : firstLine;
}

/**
 * Asks the model to say one word back.
 *
 * Deliberately not a canned health-check endpoint: those exist on some
 * providers and not others, and they answer a different question. This is the
 * same code path drafting uses — key, base URL, model name, the JSON shape of
 * the response — so a pass here means a draft will run.
 */
export async function checkAi(): Promise<CheckResult> {
  try {
    const started = Date.now();
    const reply = await callAI('Reply with the single word: ready', {
      role: 'utility',
      maxTokens: 16,
      temperature: 0,
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const said = reply.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!said) return { ok: false, detail: 'The model connected but returned nothing.' };

    return { ok: true, detail: `Answered in ${seconds}s: "${said}"` };
  } catch (error) {
    return { ok: false, detail: summarise(error) };
  }
}

/**
 * Opens the mailbox and reads the top of the inbox.
 *
 * Listing rather than merely connecting, because IMAP will authenticate you
 * happily and then fail on a mailbox name that does not exist — and a wrong
 * `IMAP_INBOX` is exactly the kind of mistake this screen is for.
 */
export async function checkMailbox(): Promise<CheckResult> {
  try {
    const messages = await mailProvider().listInbox({ limit: 3 });
    if (messages.length === 0) {
      return { ok: true, detail: 'Connected. The inbox is empty, which is a fine place to start.' };
    }

    const newest = messages[0]!;
    return {
      ok: true,
      detail: `Connected. Newest: "${newest.subject || '(no subject)'}" from ${newest.from.address}`,
    };
  } catch (error) {
    return { ok: false, detail: summarise(error) };
  }
}

/**
 * Not a connection test — a readback.
 *
 * The voice step has nothing to connect to, so what it can usefully show is
 * the persona block as the drafter will receive it. Someone who mis-typed
 * their company name sees it here rather than in a customer's inbox.
 */
export function checkWorkspace(): CheckResult {
  const config = getWorkspaceConfig();
  const facts = config.facts.length;
  return {
    ok: config.organization !== 'our company',
    detail:
      config.organization === 'our company'
        ? 'Still using the placeholder organisation name.'
        : `Replying as ${config.organization}, with ${facts} fact${facts === 1 ? '' : 's'} the model may rely on.`,
  };
}
