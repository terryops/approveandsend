#!/bin/sh
# The one thing a bind mount breaks.
#
# The image gives /app/data to uid 1000, and then `-v ./data:/app/data`
# replaces that directory with one from the host, owner and all. Docker fixes
# this for named volumes and cannot for bind mounts: the host directory is
# usually root-owned, the app is not root, and the first thing anyone sees is
# SQLITE_CANTOPEN under a stack trace — on their first run, before the product
# has shown them anything.
#
# So the container starts as root for exactly as long as it takes to hand the
# directory back, and drops to `node` before a line of application code runs.
# This is what the postgres and redis images do, for this reason.
set -e

if [ "$(id -u)" = '0' ]; then
  # Only when it is actually wrong. A correct mount — a named volume, or a host
  # directory somebody already chowned — is left untouched, and a chown of a
  # large data directory on every restart is not free.
  if [ "$(stat -c '%u' /app/data)" != '1000' ]; then
    chown node:node /app/data
  fi

  # --init-groups so the process gets node's supplementary groups rather than
  # root's leftovers. exec so PID 1 stays the app and docker stop still works.
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# Already unprivileged: somebody passed --user, and second-guessing that would
# be worse than failing loudly if the mount is wrong.
exec "$@"
