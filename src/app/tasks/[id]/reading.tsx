'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Asks for the reply's rendering a moment after the panel is on screen, rather
 * than as part of the response that puts it there.
 *
 * `DraftReading` sits behind a boundary precisely so the panel need not wait for
 * a model call, and on an ordinary page load it does not: the shell arrives in
 * about a tenth of a second and the rendering lands under it seconds later. But
 * Preview does not arrive by an ordinary page load. It is a server action that
 * ends in `redirect`, and React hands back an action's payload in one piece —
 * every boundary inside it resolved — so the boundary bought nothing on the one
 * route anybody reaches this panel by. Measured on the desk: 130ms for the same
 * page fetched, 3.9 seconds for the same page reached by pressing the button.
 *
 * So the first render does not ask. It draws the waiting line, and this asks
 * again as a navigation, which does stream. The reviewer gets the panel at the
 * speed of a database read and the rendering arrives underneath when the
 * translator is finished, which is the behaviour the boundary was for.
 *
 * `replace`, and `scroll: false`: this is the same page with one more thing
 * known about it, not somewhere the reviewer went. An entry in the history or a
 * jump to the top would both be this component admitting itself to a person who
 * pressed one button and is reading one letter.
 */
export function AskForReading() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  useEffect(() => {
    if (params.get('reading') === '1') return;
    const next = new URLSearchParams(params);
    next.set('reading', '1');
    router.replace(`${pathname}?${next}`, { scroll: false });
  }, [params, pathname, router]);

  return null;
}
