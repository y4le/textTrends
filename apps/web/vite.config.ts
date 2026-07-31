import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app from /textTrends/.
  base: '/textTrends/',
  plugins: [react()],
  // The worker is instantiated as a module worker (`{ type: 'module' }`), so
  // build it as ES too — an IIFE worker inlines every dynamic import, forcing
  // the epub (fflate + xmldom) and html (parse5) extractors into the base
  // worker chunk. ES format lets those `import()`s become lazy chunks fetched
  // only when an epub/html is actually ingested (txt/md users never pay).
  worker: { format: 'es' },
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
  build: {
    // Preserve the explicit vh declarations that precede dvh. The fallback is
    // part of the deployed mobile-browser contract, not dead legacy syntax.
    cssTarget: 'safari14',
    ...(mode === 'e2e'
      ? {
          rollupOptions: {
            input: {
              index: fileURLToPath(new URL('./index.html', import.meta.url)),
              harness: fileURLToPath(new URL('./e2e-harness.html', import.meta.url)),
            },
          },
        }
      : {}),
  },
}));
