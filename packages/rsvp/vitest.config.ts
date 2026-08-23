/**
 * Package-scoped Vitest config. Authoritative for both the root project list
 * and `pnpm --filter @texttrends/rsvp test`; without it, Vitest would discover
 * the root config relative to this package and misresolve its project paths.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
