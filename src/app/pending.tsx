'use client';

import Link, { useLinkStatus } from 'next/link';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * The desk saying it heard the click, before it has anything to show for it.
 *
 * Every screen here is a server component reading SQLite, which means every
 * click — opening an email, picking one of the options — is a round trip. On a
 * warm local install that is under a tenth of a second, and a tenth of a second
 * in which *nothing at all changes on screen* is the whole complaint: the row
 * stays the colour it was, the tab stays where it was, and the only evidence the
 * press landed arrives when the entire page has been replaced. That reads as a
 * hang and then a jump, at any latency, and it gets worse the further the
 * install is from the browser.
 *
 * Neither of these makes the server faster. They make the gap visible, which is
 * the half of "slow" that is about the interface rather than the database.
 *
 * Both are client components because both are subscriptions to something only
 * the browser knows — is a navigation in flight, is this form posting — and
 * both render nothing at all with JavaScript off, where there is no such gap to
 * cover: a plain form post repaints the whole document, and the browser's own
 * loading indicator is already saying so.
 */

/**
 * A navigation that has started but not landed, marked on the thing that
 * started it.
 *
 * `useLinkStatus` is Next's answer to exactly the case this app is: a dynamic
 * route with no `loading.tsx`, where the router cannot prefetch anything useful
 * and so has nothing to show until the server answers. It reports `pending`
 * from the click until the new page commits.
 *
 * Renders an element rather than a class on the row, and the element is always
 * there — see the note on `.opening` in globals.css. An indicator that appears
 * is an indicator that reflows the row it appears in, and a row that jumps a
 * pixel as you click it is worse than one that sits still.
 *
 * `aria-hidden`, because it says nothing a screen reader does not already get:
 * a router navigation moves focus and announces the new page, and a second
 * voice saying "loading" over the top of that is noise.
 */
export function Opening() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={`opening${pending ? ' is-opening' : ''}`} />;
}

/**
 * The one link in this app that is worth fetching before it is clicked.
 *
 * A review screen is a dynamic route, and Next does not prefetch those on its
 * own — there is nothing cacheable to fetch, so a click is a round trip and the
 * `Opening` bar above is the honest best a click can do. `prefetch` overrides
 * that and fetches the whole page ahead of time, which turns the click into a
 * cache read: the screen is simply there.
 *
 * It is not free, which is why it is a component rather than a prop sprinkled
 * on every `<Link>` in the app. Each prefetch is a full render of a task page on
 * the server, and the inbox is a hundred rows. So there are two settings, and
 * which one a list gets depends on how many rows it has:
 *
 * `eager` fetches as the link comes into view, the way Next does for a static
 * route. That is right for the queue rail, which is twelve rows, is the same
 * twelve on every task, and is walked with `J` and `K` — a keyboard has no
 * pointer to read intent from, so waiting for one would mean never prefetching
 * the rows that most need it.
 *
 * Without it, nothing is fetched until the pointer has *stayed* — see the pause
 * below, which is the difference between a row somebody is looking at and the
 * thirty-nine they crossed to get there. That is the documented answer for a
 * long list, and it costs almost nothing while buying almost everything: the
 * distance from noticing a row to clicking it is a few hundred milliseconds of
 * hand movement, and the render it is racing is a read of a local file. Focus
 * counts as intent too, so tabbing through the inbox warms the same rows a mouse
 * would.
 *
 * What a warm click cannot fix is a screen that has moved on since it was
 * fetched. Every mutation in `actions.ts` calls `revalidatePath`, which drops
 * these, so nothing you do yourself can go stale; what is left is the queue
 * writing a draft, or a colleague sending one, in the few minutes between the
 * fetch and the click. The first heals itself — the task was `pending` when it
 * was fetched, so the screen arrives with the poller already mounted — and the
 * second fails safe, because `sendReply` reads the row and refuses a task that
 * has already gone.
 */
export function TaskLink({
  href,
  className,
  current,
  eager = false,
  children,
}: {
  href: string;
  className?: string;
  /** `aria-current`, for the row you are already on. */
  current?: boolean;
  eager?: boolean;
  children: ReactNode;
}) {
  // Armed by the pointer, and never disarmed once armed: a row you have hovered
  // deliberately is a row you may come back to, and the fetch has already been
  // paid for.
  const [wanted, setWanted] = useState(false);
  const intent = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hovering is not the same as meaning to. The pointer cannot reach row 40 of
  // the inbox without entering the thirty-nine rows above it, and each of those
  // is a full render of a review screen on the server — eight queries against
  // SQLite for a page nobody is going to open. A pause is what separates the two
  // and it is the only signal available: 120ms is below the threshold at which a
  // wait is felt, and far above the few milliseconds a row crossed on the way
  // somewhere else is under the cursor.
  const warm = () => {
    if (wanted || intent.current) return;
    intent.current = setTimeout(() => setWanted(true), 120);
  };

  // Focus and touch are already intent — a keyboard has no way to pass over a
  // row, and a finger that has landed on one is not on its way past.
  const warmNow = () => {
    cool();
    setWanted(true);
  };

  const cool = () => {
    if (intent.current) clearTimeout(intent.current);
    intent.current = null;
  };

  // A row unmounted mid-pause — the inbox refreshing under the pointer, a
  // filter changing — must not come back to set state on nothing.
  useEffect(() => cool, []);

  return (
    <Link
      href={href}
      className={className}
      prefetch={eager || wanted}
      aria-current={current ? 'page' : undefined}
      onMouseEnter={warm}
      onMouseLeave={cool}
      onFocus={warmNow}
      onTouchStart={warmNow}
    >
      {/* Every one of these gets the bar, because a warm click is not a
          guaranteed one: the entry may have expired, or the pointer may have
          gone straight from the keyboard to the click without ever hovering. */}
      <Opening />
      {children}
    </Link>
  );
}

/**
 * The button that was pressed, looking pressed, for as long as the post takes.
 *
 * The option tabs and the format tabs are submit buttons in the draft's own
 * form: pressing one posts the whole reply and the server decides which tab is
 * lit. That is the right design — the tab is lit by the row rather than by a
 * guess in the browser — and it has one cost, which is that for the length of a
 * round trip the tab you just pressed looks exactly like the tab you did not.
 * People press it again.
 *
 * So this is an optimistic read of one bit and nothing more: *you pressed this
 * one*. It never claims the switch happened — the styling it turns on is the
 * chosen look plus a dimming, and the moment the server answers, the class goes
 * and the real answer is underneath it. If the action refuses (a sent task, a
 * lost race) the tab snaps back to where it was, which is the truth.
 *
 * A wrapper rather than a component that renders the button, because the button
 * has to stay in the page it belongs to. `formAction={useAlternative.bind(...)}`
 * written in `tasks/[id]/page.tsx` is what `actions.fields.test.ts` reads to
 * check that every field the form posts reaches an action that wants it, and
 * that check works by finding the action's *name* next to the form. Passing the
 * bound action down here as a prop would compile, work, and quietly put it out
 * of a job — the same trade `here.tsx` refused for the same reason.
 *
 * `display: contents` on the wrapper, so a stack of tabs is still a stack of
 * tabs: the span has no box of its own and the button it holds sits in the
 * flex row exactly where it did before.
 *
 * `draft` is the other half of the same idea, and it is what makes an option tab
 * quick rather than merely honest about being slow. A lit tab says the press
 * landed; the reply under it still says what it said a moment ago, and on the
 * one press people make three times in a row — A, then B, then C — that gap is
 * the whole of what "slow" means here. Nothing has to be fetched to close it:
 * the option's text was read out of the database by the render that drew the
 * strip, so it can go in the box on the click.
 *
 * The order below is the whole of it, and it is the reason this is a DOM write
 * rather than an `useOptimistic` value. The box is the one uncontrolled node on
 * this screen — server-rendered, keyed on the text, with no client state to be
 * optimistic *with* — and it is also the field the press is about to post.
 *
 * So: post first, write second. `requestSubmit` dispatches the submit event
 * synchronously and React builds the `FormData` inside it, which means the post
 * carries what the reviewer had in the box rather than what this is about to put
 * there. Write first and every switch posts the option as if somebody had typed
 * it, `keepEdits` files a version under their name, and the drafts panel fills
 * with edits nobody made. `preventDefault` is for the browser's own submit,
 * which would otherwise follow this same click and post the form a second time.
 *
 * What arrives a round trip later is the same text. `useAlternative` writes the
 * option to the row, the page re-renders from it, and the box is keyed on that
 * text — so the remount replaces the value with the value already on screen and
 * nothing moves.
 *
 * A refusal is the case that remount cannot answer, and it is why the old value
 * is kept. `useAlternative` writes nothing to a task that has been sent or is
 * being sent, and the screen that comes back is drawn from `finalReply` — which
 * is, on nearly every task, the same text the draft already held. Same text,
 * same key, no remount, and this guess would have been left sitting under the
 * heading "what went out", claiming the mail said something it did not. So when
 * the post settles with the box still standing and still holding the guess, the
 * guess is taken back out. A box that was replaced has already been answered by
 * the server and is left alone.
 *
 * And with JavaScript off none of this exists: the button is a submit button in
 * a form, the server does every part of the work, and the prop has only ever
 * been in the business of removing a wait.
 */
export function Pressable({ draft, children }: { draft?: string; children: ReactNode }) {
  // Form-scoped: true while *any* button in this form is posting. Which one it
  // was is the part only the click knows, and that is the state below.
  const { pending } = useFormStatus();
  const [armed, setArmed] = useState(false);
  const posting = useRef(false);
  /** The box this press wrote over, and what it said before. */
  const swapped = useRef<{ box: HTMLTextAreaElement; before: string } | null>(null);

  // Disarmed on the falling edge, not on `!pending`. The click and the
  // submission are two renders, and in the first of them this component has
  // already been told it was pressed while the form has not yet been told it is
  // posting — clearing on a bare `!pending` would clear it there, half a frame
  // before the state it exists to show.
  useEffect(() => {
    if (posting.current && !pending) {
      setArmed(false);

      // And the guess is taken back, unless the answer has already replaced it.
      // A box still in the document holding exactly what this press put there is
      // a box the server did not write to; see the note above for the refusal
      // that gets here. `isConnected` is the whole test, because the agreeing
      // case remounts and leaves this node detached.
      const swap = swapped.current;
      swapped.current = null;
      if (swap && swap.box.isConnected && swap.box.value === draft) swap.box.value = swap.before;
    }
    posting.current = pending;
  }, [pending, draft]);

  const press = (event: MouseEvent<HTMLSpanElement>) => {
    setArmed(true);
    if (draft === undefined) return;

    // The button this wrapper exists for, and the form and the box it belongs
    // to. Anything missing — a tab outside the reply form, a box gone read-only
    // because the mail has left — and this returns having done nothing, which
    // leaves the plain submit underneath to do the whole job as before.
    const button = event.currentTarget.querySelector('button');
    const form = button?.form;
    const box = form?.elements.namedItem('draft');
    if (!button || !form || !(box instanceof HTMLTextAreaElement) || box.readOnly) return;

    event.preventDefault();
    form.requestSubmit(button);
    swapped.current = { box, before: box.value };
    box.value = draft;
  };

  return (
    <span className={`pressable${armed && pending ? ' pressing' : ''}`} onClick={press}>
      {children}
    </span>
  );
}
