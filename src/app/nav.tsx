'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Which screen you are on, and the one thing on this desk that cannot be
 * answered on the server.
 *
 * The header lives in the root layout, and a root layout is the one component
 * App Router deliberately does *not* re-render when you navigate: clicking a
 * link fetches the changed page segment and reuses everything above it. So the
 * pathname the layout read out of `headers()` is the pathname of whichever page
 * happened to load the document — and it stays that pathname for the rest of
 * the session. The URL changes, the page changes, the lit link does not.
 *
 * That was true while the marker was a slightly bolder grey and nobody noticed.
 * It stopped being survivable the moment it became a filled accent pill, which
 * is a thing you can see across a room sitting on the wrong word.
 *
 * `usePathname` is a subscription rather than a value read once, so this
 * re-renders on every navigation, soft ones included. It is the fifth client
 * component on this desk and it earns it the way the other four do: there is no
 * server-side answer to "what is the URL *now*" in a component the server has
 * stopped rendering.
 *
 * Nothing is lost with JavaScript off. This still renders on the server, where
 * `usePathname` returns the URL being rendered, so the first paint is correct —
 * and without a router there are no soft navigations to go stale, because every
 * click is a fresh document.
 *
 * The labels arrive as props, already translated. `t()` reads the workspace
 * config off the disk, which is a server-only thing to do, and they do not need
 * to be reactive: the language changes through a server action that redirects,
 * which rebuilds the layout and these props with it.
 */

export interface NavItem {
  href: string;
  /** Already through `t()`. */
  label: string;
  /** Other path prefixes this link should stay lit for. */
  also?: string[];
}

function isHere(pathname: string, item: NavItem): boolean {
  // Exact for the inbox, or it would claim every page in the app.
  if (item.href === '/') {
    return pathname === '/' || (item.also ?? []).some(p => pathname.startsWith(p));
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <>
      {items.map(item => {
        const here = isHere(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={here ? 'active' : undefined}
            aria-current={here ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
