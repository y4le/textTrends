/**
 * Real-browser suite — Phase 1 Milestone 6 (M6 consult). Chromium-only for
 * the first real-browser proof; the app is served as the PRODUCTION-shaped
 * e2e build (`vite build --mode e2e`) via `vite preview` under the deployed
 * /textTrends/ base path.
 *
 * Three projects, deliberately separated:
 * - functional: semantic gates; may retry once in CI (traces on retry);
 * - WebKit compact: bounded viewport/keyboard and compact-place contract
 *   specs, not the full suite;
 * - benchmark:  timing specs — never retried, so a failed timing sample is
 *   a visible failure, not noise a retry can hide. ISOLATION is enforced
 *   by the config, not by convention: the benchmark project DEPENDS on the
 *   functional and WebKit projects (Playwright completes dependencies first
 *   and skips dependents on failure) and pins its own workers to 1 — so one
 *   invocation, one webServer build, and timing samples that never share
 *   the machine with functional load.
 *   `pnpm --filter @texttrends/web e2e:bench` passes --no-deps for a
 *   deliberate timing-only run.
 */

import { defineConfig, devices } from '@playwright/test';

const e2ePort = Number.parseInt(process.env.TT_E2E_PORT ?? '4173', 10);
if (!Number.isSafeInteger(e2ePort) || e2ePort < 1 || e2ePort > 65_535) {
  throw new RangeError('TT_E2E_PORT must be an integer from 1 through 65535');
}
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: `${e2eOrigin}/textTrends/`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-functional',
      testIgnore: /.*\.bench\.spec\.ts/,
      retries: process.env.CI ? 1 : 0,
    },
    {
      name: 'webkit-compact',
      testMatch: /(viewport|reader-modes|shortcuts|compact-trends|compact-barcode|compact-concordance|compact-corpus|compact-vocabulary|compact-compare)\.spec\.ts/,
      use: { ...devices['iPhone 14'] },
      retries: process.env.CI ? 1 : 0,
    },
    {
      name: 'chromium-benchmark',
      testMatch: /.*\.bench\.spec\.ts/,
      dependencies: ['chromium-functional', 'webkit-compact'],
      workers: 1,
      retries: 0,
    },
  ],
  webServer: {
    command: `pnpm build:e2e && pnpm preview --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: `${e2eOrigin}/textTrends/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
