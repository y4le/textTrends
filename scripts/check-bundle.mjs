#!/usr/bin/env node
/**
 * CI/local gate over the PRODUCTION bundle (`pnpm check:bundle`, run after
 * `pnpm --filter @texttrends/web build:bundle` and before any e2e build
 * overwrites apps/web/dist). All contract logic lives in check-bundle-lib.mjs
 * (pure, fixture-tested); this wrapper only loads the real dist tree and the
 * checked-in catalog JSON, prints the report, and exits nonzero on any
 * contract failure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundle } from './check-bundle-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = process.argv[2] ?? join(root, 'apps/web/dist');
const catalogPath = join(root, 'apps/web/src/lib/standard-ebooks-catalog.json');

const files = new Map();
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.set(relative(distDir, path).replaceAll('\\', '/'), readFileSync(path));
  }
};
walk(distDir);

const { failures, report } = checkBundle(files, readFileSync(catalogPath));
for (const line of report) console.log(line);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log('bundle contract: OK');
