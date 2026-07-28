/**
 * Root Vitest orchestration (Phase H): the three in-repo suites run under ONE
 * vitest process with shared reporting and project/file parallelism. Each
 * project keeps its own config (apps/web's vite.config.ts stays authoritative
 * for its include and compile-time seams). The enrolled ../standard_ebooks
 * sibling is deliberately NOT a project here — it has its own repository,
 * lockfile, and lifecycle; the root test script runs its suite standalone.
 * Package-local `pnpm --filter <pkg> test` entry points remain supported.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/extractors', 'apps/web'],
  },
});
