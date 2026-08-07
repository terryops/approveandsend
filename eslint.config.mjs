import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * Next's own two configs, plus two deliberate narrowings.
 *
 * `core-web-vitals` is the set that catches things a reviewer would not: an
 * `<img>` where the framework wants `<Image>`, a hook called conditionally.
 * `typescript` adds the rules `tsc --noEmit` has no opinion about. Neither
 * overlaps the type check, which is why `npm run typecheck` still exists and
 * still runs first.
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'data/**'],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Job payloads are named after their job even when they add nothing to
      // the input type they extend, because the handler signature is where
      // anyone reads them: `LearnFromSentPayload` says which queue this is,
      // `LearningInput` does not. The rule still fires on `{}` written out.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
    },
  },
];

export default config;
