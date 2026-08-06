import type { NextConfig } from 'next';

const config: NextConfig = {
  // Without this Turbopack walks up to the nearest lockfile, which in a
  // monorepo or a checkout inside another project is the wrong root.
  turbopack: { root: import.meta.dirname },
  // better-sqlite3 is a native addon; bundling it produces a binary that
  // cannot find its own .node file at runtime.
  serverExternalPackages: ['better-sqlite3', 'imapflow', 'nodemailer', 'mailparser'],
};

export default config;
