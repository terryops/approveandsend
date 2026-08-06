#!/bin/sh
# The scheduler, for people running `docker compose up` and nothing else.
#
# Not cron. cron in a container means a second init system, a second log
# destination and a crontab that has to be baked into an image to be edited.
# This is a loop that wakes once a minute and posts to four endpoints on a
# schedule, which is all cron was being asked to do.
#
# On a host that already has cron, delete this service and point the host's
# crontab at the published port instead. The endpoints are the same.
set -eu

BASE="${APP_URL:-http://app:3000}"
TOKEN="${CRON_TOKEN:-}"

post() {
  # Failures are reported and swallowed on purpose: the app being down for a
  # deploy must not take the scheduler with it.
  if curl -fsS -m 300 -X POST -H "Authorization: Bearer ${TOKEN}" "${BASE}$1" >/dev/null 2>&1; then
    echo "$(date -u +%H:%M:%S) $1 ok"
  else
    echo "$(date -u +%H:%M:%S) $1 failed"
  fi
}

# Wait for the app rather than spending the first minute failing.
until curl -fsS -m 5 "${BASE}/api/health" >/dev/null 2>&1; do
  echo "waiting for ${BASE}"
  sleep 2
done

# Minutes since start. Everything fires on the first pass, which is what you
# want after a deploy — including the weekly pass, which counts what has
# changed since the last one and does nothing in a quiet week.
i=0
while :; do
  [ $((i % 2)) -eq 0 ] && post /api/worker
  [ $((i % 5)) -eq 0 ] && post /api/sync
  [ $((i % 60)) -eq 0 ] && post /api/sweep
  [ $((i % 10080)) -eq 0 ] && post /api/consolidate
  i=$((i + 1))
  sleep 60
done
