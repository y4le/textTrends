/**
 * Real-browser suite — Phase 1 Milestone 6 (M6 consult). Chromium-only for
 * the first real-browser proof; the app is served as the PRODUCTION-shaped
 * e2e build (`vite build --mode e2e`) via `vite preview` under the deployed
 * /textTrends/ base path.
 *
 * Two projects, deliberately separated:
 * - functional: semantic gates; may retry once in CI (traces on retry);
 * - benchmark:  timing specs — never retried, so a failed timing sample is
 *   a visible failure, not noise a retry can hide. ISOLATION is enforced
 *   by the checked-in commands, not by convention: `pnpm e2e` runs the
 *   functional project to completion FIRST, then the benchmark project
 *   with --workers=1 (same sequence as .github/workflows/ci.yml) — timing
 *   samples never share the machine with functional load.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:4173/textTrends/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-functional',
      testIgnore: /.*\.bench\.spec\.ts/,
      retries: process.env.CI ? 1 : 0,
    },
    {
      name: 'chromium-benchmark',
      testMatch: /.*\.bench\.spec\.ts/,
      retries: 0,
    },
  ],
  webServer: {
    command: 'pnpm build:e2e && pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/textTrends/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
