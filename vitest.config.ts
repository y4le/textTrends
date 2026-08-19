/**
 * Root Vitest orchestration: the four in-repo suites run under one
 * vitest process with shared reporting and project/file parallelism. Each
 * project keeps its own config (apps/web's vite.config.ts stays authoritative
 * for its include and compile-time seams).
 * Package-local `pnpm --filter <pkg> test` entry points remain supported.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/extractors',
      'packages/standard-ebooks',
      'apps/web',
    ],
  },
});
