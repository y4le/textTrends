/**
 * Package-scoped Vitest config. Authoritative for BOTH entry points: the root
 * vitest.config.ts `projects` list consumes it, and it stops Vitest's upward
 * config discovery so the package-local `pnpm --filter @texttrends/extractors
 * test` keeps working from this directory (without it, the root config's
 * relative project paths would resolve against this cwd and abort).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'development|production'] },
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
