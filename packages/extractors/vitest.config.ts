/**
 * Package-scoped Vitest config. Authoritative for BOTH entry points: the root
 * vitest.config.ts `projects` list consumes it, and it stops Vitest's upward
 * config discovery so the package-local `pnpm --filter @texttrends/extractors
 * test` keeps working from this directory (without it, the root config's
 * relative project paths would resolve against this cwd and abort).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
