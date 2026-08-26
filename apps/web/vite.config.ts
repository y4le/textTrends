import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { restoreTailnetRequestUrl } from './vite-tailnet';

function restoreTailnetPath(path: string): Plugin {
  return {
    name: 'restore-tailnet-path',
    configureServer(server) {
      // Tailscale Serve removes the matched mount path before proxying. Put it
      // back for Vite's middleware and HMR upgrade handling.
      server.httpServer?.prependListener('upgrade', (request) => {
        request.url = restoreTailnetRequestUrl(request.url ?? '/', path);
      });
      server.middlewares.use((request, _response, next) => {
        request.url = restoreTailnetRequestUrl(request.url ?? '/', path);
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const tailnetPath = process.env.TT_TAILNET_PATH;

  return {
    // GitHub Pages serves the app from /textTrends/.
    base: '/textTrends/',
    plugins: [react(), ...(tailnetPath ? [restoreTailnetPath(tailnetPath)] : [])],
    ...(tailnetPath
      ? {
          server: {
            allowedHosts: ['.ts.net'],
            hmr: {
              protocol: 'wss' as const,
              clientPort: 443,
            },
          },
        }
      : {}),
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
      __TT_BUILD__: JSON.stringify({
        mode,
        commit: process.env.GITHUB_SHA
          ?? process.env.VERCEL_GIT_COMMIT_SHA
          ?? process.env.COMMIT_SHA
          ?? null,
      }),
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
  };
});
