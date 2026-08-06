import type { NextConfig } from 'next';

const config: NextConfig = {
  // Without this Turbopack walks up to the nearest lockfile, which in a
  // monorepo or a checkout inside another project is the wrong root.
  turbopack: { root: import.meta.dirname },
  // better-sqlite3 is a native addon; bundling it produces a binary that
  // cannot find its own .node file at runtime.
  serverExternalPackages: ['better-sqlite3', 'imapflow', 'nodemailer', 'mailparser'],
  // Emits .next/standalone: the server plus only the node_modules actually
  // reached, which is what the Docker image ships. `next start` is unaffected,
  // so this costs non-Docker users nothing but a directory they can ignore.
  output: 'standalone',
};

export default config;
