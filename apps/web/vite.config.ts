import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app from /textTrends/.
  base: '/textTrends/',
  plugins: [react()],
  // Compile-time e2e seam (M6 consult): the normal production build must
  // dead-code-eliminate every debug facade; only `vite build --mode e2e`
  // compiles the trace hook and the protocol harness page. CI scans the
  // normal bundle for the facade name to prove elimination.
  define: {
    __TT_E2E__: JSON.stringify(mode === 'e2e'),
  },
  // Vitest must not collect the Playwright specs (e2e/*.spec.ts) — they
  // only run under `playwright test` against a served build.
  test: {
    include: ['test/**/*.test.ts'],
  },
  ...(mode === 'e2e'
    ? {
        build: {
          rollupOptions: {
            input: {
              index: fileURLToPath(new URL('./index.html', import.meta.url)),
              harness: fileURLToPath(new URL('./e2e-harness.html', import.meta.url)),
            },
          },
        },
      }
    : {}),
}));
