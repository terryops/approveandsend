import type { NextConfig } from 'next';

const config: NextConfig = {
  // Without this Turbopack walks up to the nearest lockfile, which in a
  // monorepo or a checkout inside another project is the wrong root.
  turbopack: { root: import.meta.dirname },
  // better-sqlite3 is a native addon; bundling it produces a binary that
  // cannot find its own .node file at runtime.
  serverExternalPackages: ['better-sqlite3', 'imapflow', 'nodemailer', 'mailparser'],
  // Emits .next/standalone — the server plus only the node_modules actually
  // reached — which is what the Docker image ships.
  //
  // Opt-in, and it has to be. A standalone build is served by
  // `node .next/standalone/server.js`, and `next start` against one prints a
  // warning and then quietly fails to run server actions: forms post and
  // nothing happens, with no error anywhere. Since `npm start` is what the
  // README tells people to run, making this unconditional broke the documented
  // path to save a flag. The Dockerfile sets NEXT_STANDALONE=1.
  ...(process.env.NEXT_STANDALONE ? { output: 'standalone' as const } : {}),
};

export default config;
