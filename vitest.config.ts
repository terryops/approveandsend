import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Exists for one line.
 *
 * The library is all relative imports and needed no config at all. Route
 * handlers are not: they use the `@/` alias the rest of a Next app uses, and a
 * test that imports one gets it transitively. Teaching the runner the alias is
 * cheaper than making the routes the only files in the repo that spell their
 * imports differently from every other route in every other Next codebase.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
