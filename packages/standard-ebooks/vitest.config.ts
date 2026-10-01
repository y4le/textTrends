/** Package-scoped config for root orchestration and local package test runs. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'development|production'] },
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
