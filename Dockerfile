# Approve & Send
#
# Two things make this image less boring than the usual Next.js Dockerfile:
#
#   better-sqlite3 is a native addon. It is compiled in a builder stage that
#   shares a base image with the runtime, because a binary built against a
#   different libc loads fine on the machine that built it and nowhere else.
#   Debian both times, deliberately — Alpine would mean musl and a rebuild.
#
#   The database is a file. It lives in /app/data on a volume, and nothing
#   else in the image is writable by the user we run as.

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# node-gyp's toolchain, needed only to compile better-sqlite3 and left behind
# in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_STANDALONE switches on `output: standalone`, which is what makes the
# runner stage small. It is off by default because `next start` — the command
# the README gives — cannot serve a standalone build.
#
# This step needs the network, and for one reason beyond npm: `next/font` fetches
# Inter and Source Serif from fonts.gstatic.com here and bakes them into
# `.next/static`. That is what buys a running desk with no outbound requests at
# all — the fonts are served from this origin — but it does mean an air-gapped
# *build* fails at this line rather than quietly shipping fallback faces. Behind a
# proxy, pass `HTTPS_PROXY` as a build arg; `next/font` reads it.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_STANDALONE=1
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/app/data/aas.db

# curl is here for HEALTHCHECK and for driving the API endpoints from `docker
# exec`, which is the difference between a container you can operate and one
# you can only restart.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# `node` (uid 1000) ships with the base image. The data directory is the only
# thing it owns: a compromised process should not be able to rewrite the app.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=builder --chown=root:root /app/.next/standalone ./
COPY --from=builder --chown=root:root /app/.next/static ./.next/static
# No `public/` COPY: there is no public directory, and the App Router serves
# the icons from src/app. Add one back here if you add one to the project —
# standalone output does not include it.

USER node
EXPOSE 3000
VOLUME /app/data

# /api/health answers without touching the model or the mailbox, so an
# unreachable mail server does not make the container look dead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
