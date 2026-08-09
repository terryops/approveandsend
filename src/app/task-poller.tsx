'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Watching a job that is already running.
 *
 * The review screen is a server component reading the row straight out of
 * SQLite, so there is nothing to subscribe to and nothing to invent an API for:
 * `router.refresh()` re-runs the page on the server and patches in whatever it
 * finds. When the drafting job writes the new reply and moves the task off
 * `pending`, the next refresh renders it and the panel this sits inside stops
 * being rendered at all — which is how the waiting state ends, without anything
 * here having to know what it was waiting for.
 *
 * Two seconds because that is the scale of the thing being watched: a model
 * call is tens of seconds, and a refresh costs one cheap read of a local file.
 * Polling only exists while this component is mounted, and it is only mounted
 * while a job is actually in flight — nothing here runs on an idle screen.
 */
export function TaskPoller({ intervalMs = 2000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);

  return null;
}
