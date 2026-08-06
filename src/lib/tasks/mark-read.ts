import { mailProvider } from '../mail/config';
import type { MailProvider } from '../mail/types';
import type { Task } from './types';

/**
 * Clearing the unread flag in the mailbox once a task has been dealt with.
 *
 * The mailbox is not this app's storage, it is a second screen that somebody
 * still opens — and an inbox showing 340 unread messages that have all been
 * answered from here is worse than no signal at all, because the one genuinely
 * unhandled mail is invisible in it. So the flag is kept meaning what it looks
 * like it means: unread is mail nobody has dealt with.
 *
 * Deliberately not on open. Reading a task is not handling it — a reviewer who
 * opens something, decides it needs a colleague and closes the tab has changed
 * nothing, and marking it read there would hide it from the colleague. It runs
 * where the task actually leaves the queue: sent, or dismissed.
 *
 * Best-effort, always. A mail that went out and a flag that did not clear is a
 * cosmetic problem; an exception here would tell the reviewer their send
 * failed, and they would send it twice.
 */
export async function markHandled(
  task: Task,
  options: { provider?: MailProvider } = {},
): Promise<boolean> {
  // Demo rows, seeded tasks and anything ingested by other means carry no
  // provider id. Nothing to clear, and not worth opening a connection for.
  if (!task.messageId) return false;

  try {
    const provider = options.provider ?? mailProvider();
    await provider.markAsRead(task.messageId);
    return true;
  } catch (error) {
    console.warn(`[tasks] could not mark ${task.id} read in the mailbox:`, error);
    return false;
  }
}
