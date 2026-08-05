import { normalizeMessageId } from './address';
import type { MailMessage } from './types';

/**
 * Thread reconstruction for backends that have no server-side threads.
 *
 * A simplified JWZ: union messages that reference each other via Message-ID /
 * In-Reply-To / References, then — only as a fallback — union messages with
 * an identical normalized subject and a shared participant.
 *
 * The subject fallback is deliberately conservative. Plenty of unrelated mail
 * shares a subject ("Invoice", "Question"), and merging two customers into one
 * thread would leak one customer's mail into the other's prompt. Requiring a
 * shared participant makes that essentially impossible.
 */

/** Strip Re:/Fwd:/[list] prefixes so replies match their parent. */
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return '';
  let s = subject.trim();
  let changed = true;
  while (changed) {
    changed = false;
    // Re:, RE:, Re[2]:, Fwd:, FW:, Antwoord:, 回复:, 答复: …
    const stripped = s.replace(
      /^\s*(?:re|rif|aw|sv|vs|antw|antwoord|fwd?|tr|回复|答复|轉寄|轉發|转发)\s*(?:\[\d+\])?\s*[:：]\s*/i,
      '',
    );
    if (stripped !== s) {
      s = stripped;
      changed = true;
    }
    const unlisted = s.replace(/^\s*\[[^\]]{1,40}\]\s*/, '');
    if (unlisted !== s) {
      s = unlisted;
      changed = true;
    }
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

class DisjointSet {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== this.parent.get(root)) {
      root = this.parent.get(root)!;
    }
    // Path compression, so repeated lookups stay cheap on long threads.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function participants(m: MailMessage): Set<string> {
  const out = new Set<string>();
  if (m.from?.address) out.add(m.from.address.toLowerCase());
  for (const a of m.to ?? []) out.add(a.address.toLowerCase());
  for (const a of m.cc ?? []) out.add(a.address.toLowerCase());
  return out;
}

function shareParticipant(a: MailMessage, b: MailMessage): boolean {
  const pa = participants(a);
  for (const addr of participants(b)) {
    if (pa.has(addr)) return true;
  }
  return false;
}

const byTime = (a: MailMessage, b: MailMessage) =>
  new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime();

/**
 * Group messages into conversations, each sorted oldest → newest.
 * The returned groups are ordered by their most recent message, newest first,
 * which is the order an inbox wants to display them in.
 */
export function groupIntoThreads<T extends MailMessage>(messages: T[]): T[][] {
  if (messages.length === 0) return [];

  const set = new DisjointSet();
  const key = (m: T) => `msg:${m.id}`;

  // Pass 1: a server-side threadId is authoritative when present.
  // Pass 2: header references.
  for (const m of messages) {
    const k = key(m);
    set.find(k);

    if (m.threadId) set.union(k, `thread:${m.threadId}`);

    const own = normalizeMessageId(m.messageIdHeader);
    if (own) set.union(k, `mid:${own}`);

    const parent = normalizeMessageId(m.inReplyTo);
    if (parent) set.union(k, `mid:${parent}`);

    for (const ref of m.references ?? []) {
      const id = normalizeMessageId(ref);
      if (id) set.union(k, `mid:${id}`);
    }
  }

  // Pass 3: subject fallback, only for messages that share a participant.
  const bySubject = new Map<string, T[]>();
  for (const m of messages) {
    const subject = normalizeSubject(m.subject);
    if (!subject) continue;
    const list = bySubject.get(subject);
    if (list) list.push(m);
    else bySubject.set(subject, [m]);
  }

  for (const list of bySubject.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (set.find(key(a)) === set.find(key(b))) continue;
        // A server-side threadId outranks a subject guess. Without this, a
        // customer who reuses one subject line ("Invoice") across months of
        // separate tickets collapses into a single unbounded thread.
        if (a.threadId && b.threadId && a.threadId !== b.threadId) continue;
        if (shareParticipant(a, b)) set.union(key(a), key(b));
      }
    }
  }

  const groups = new Map<string, T[]>();
  for (const m of messages) {
    const root = set.find(key(m));
    const list = groups.get(root);
    if (list) list.push(m);
    else groups.set(root, [m]);
  }

  const result = [...groups.values()];
  for (const g of result) g.sort(byTime);
  result.sort((a, b) => byTime(b[b.length - 1]!, a[a.length - 1]!));
  return result;
}

/** The conversation containing `target`, oldest first. */
export function findThreadFor<T extends MailMessage>(target: MailMessage, pool: T[]): T[] {
  for (const group of groupIntoThreads(pool)) {
    if (group.some(m => m.id === target.id)) return group;
  }
  return [];
}

/**
 * The References header for a reply: the parent's chain plus the parent
 * itself, capped because some servers reject very long headers. Keeping the
 * first and the most recent preserves both the thread root and the immediate
 * context, which is what clients actually use.
 */
export function buildReferences(
  parentMessageId: string | undefined,
  parentReferences: string[] = [],
  maxIds = 20,
): string[] {
  const chain = [...parentReferences.map(normalizeMessageId).filter(Boolean)];
  const parent = normalizeMessageId(parentMessageId);
  if (parent && !chain.includes(parent)) chain.push(parent);

  if (chain.length <= maxIds) return chain;
  return [chain[0]!, ...chain.slice(chain.length - (maxIds - 1))];
}
