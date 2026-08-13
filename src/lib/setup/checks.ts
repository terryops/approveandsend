import { callAI } from '../ai';
import { RESOURCES, readable, stripeKey, stripeMode, stripeRestricted } from '../billing/stripe';
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

/**
 * The subjects with something to connect to, which is what a Test button needs.
 *
 * Named here rather than in the page, because the verdict is stored under this
 * word (`setup.check.<name>`) and the button, the storage key and the banner
 * that reads it back all have to agree on the spelling.
 */
export type Checkable = 'model' | 'mailbox' | 'stripe';

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
 * Reads all three lists, and reports each one separately.
 *
 * Not one call. A restricted key is granted permission by permission, and the
 * ordinary mistake is granting two of the three — which authenticates, passes
 * any check that stops at "the key works", and then quietly produces a billing
 * screen with no payments on it for a customer who has paid twelve times.
 * Naming the resource that was refused turns a support mystery into a line in
 * the Stripe dashboard the operator can go and tick.
 */
export async function checkStripe(): Promise<CheckResult> {
  if (!stripeKey()) return { ok: false, detail: 'No key is set.' };

  const results = await Promise.all(
    RESOURCES.map(async resource => {
      try {
        await readable(resource);
        return { resource, error: null as string | null };
      } catch (error) {
        return { resource, error: summarise(error) };
      }
    }),
  );

  const mode = stripeMode();
  // A test key on a live desk finds nobody and says so in every draft, so the
  // mode belongs in the verdict even when everything passed.
  const where = mode ? `${mode} mode` : 'an unrecognised key';
  const refused = results.filter(result => result.error !== null);

  if (refused.length === RESOURCES.length) {
    return { ok: false, detail: refused[0]!.error! };
  }
  if (refused.length > 0) {
    return {
      ok: false,
      detail: `Connected in ${where}, but cannot read ${refused
        .map(result => result.resource)
        .join(' or ')}: ${refused[0]!.error}`,
    };
  }

  const narrow = stripeRestricted()
    ? ''
    : ' This is a full secret key — a restricted key with read on those three would do.';

  // A fourth permission, and deliberately not a fourth requirement. Without it
  // the desk still learns from the charge that a chargeback exists — that flag
  // needs no permission — and still refuses to promise a refund over it. What
  // it loses is the amount, the reason and the evidence deadline, which is the
  // difference between a caution and an answer. Worth one sentence here, where
  // granting it is two clicks away, rather than a failed check on every install
  // that set this up before disputes were read at all.
  const disputes = await readable('disputes')
    .then(() => '')
    .catch(
      () =>
        ' Disputes are not readable with this key; chargebacks will show as a warning without their details.',
    );

  return {
    ok: true,
    detail: `Connected in ${where}. Customers, subscriptions and charges all readable.${disputes}${narrow}`,
  };
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
