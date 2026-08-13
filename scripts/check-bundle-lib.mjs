/**
 * Production-bundle contract checks (Phase H). The H0/G optimization work
 * ratified an ARCHITECTURE for the shipped bundle — an entry under a hard
 * gzip budget, the Standard Ebooks catalog as a fetched asset (never inlined
 * into a script), the SE archive client and the worker's parser
 * runtimes as lazy chunks — and this module makes those claims executable.
 * CI runs the CLI wrapper (scripts/check-bundle.mjs) against the real
 * `apps/web/dist`; this library is pure over an in-memory file map so the
 * failure paths are covered by synthetic fixtures without needing a build.
 *
 * Every check hard-fails: an unattended warning is decoration. When a
 * deliberate feature must cross the entry ceiling, raise the constant in a
 * reviewed commit that records before/after checker output.
 */
import { gzipSync } from 'node:zlib';

/** Hard ceiling for the gzipped entry chunk, in exact bytes (node:zlib level
 *  9 over the emitted file — NOT Vite's console estimate). Post-Phase-G
 *  measurement: 83 599 bytes. */
export const ENTRY_GZIP_BUDGET_BYTES = 90_000;

/** Compile-time e2e facade names that must be dead-code-eliminated from the
 *  production bundle (M6 consult; formerly a shell grep in CI). */
const FACADE_SENTINELS = ['ttE2E', 'ttHarness'];

/** Canonical workbench places are route-level lazy boundaries. Keep this list
 * in lockstep with apps/web/src/lib/places.ts. */
const PLACE_CHUNKS = [
  ['Inputs', /^assets\/InputsPlace-[^/]+\.js$/],
  ['Trends', /^assets\/TrendsPlace-[^/]+\.js$/],
  ['Concordance', /^assets\/ConcordancePlace-[^/]+\.js$/],
  ['Vocabulary', /^assets\/VocabularyPlace-[^/]+\.js$/],
  ['Compare', /^assets\/ComparePlace-[^/]+\.js$/],
];

const gzipSize = (bytes) => gzipSync(bytes, { level: 9 }).length;

/** All paths in `files` matching `re`, sorted for stable diagnostics. */
const matching = (files, re) => [...files.keys()].filter((p) => re.test(p)).sort();

/** Chunk basenames (assets/x-HASH.js → x-HASH.js) referenced STATICALLY from
 *  a chunk's text: `from"./x.js"` / bare `import"./x.js"` (minified output;
 *  tolerate optional whitespace and either string-literal quote — quote style
 *  is emitted-code detail, not a contract). */
function staticImports(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:from|import)\s*(["'])\.\/([^"']+\.js)\1/g)) out.add(m[2]);
  return out;
}

/** Whether `text` references chunk basename `name` AT ALL — static import,
 *  `import("./…")` / import(`./…`) dynamic form, or a lazy-loader path table
 *  entry ("assets/…"). */
const references = (text, name) => text.includes(name);

/** One architectural role → exactly one file. Returns the path or records a
 *  failure listing what was actually observed. */
function unique(files, re, role, failures) {
  const found = matching(files, re);
  if (found.length === 1) return found[0];
  failures.push(
    `${role}: expected exactly one asset matching ${re}, found ${found.length}` +
      (found.length ? ` (${found.join(', ')})` : '') +
      `; observed assets: ${matching(files, /^assets\//).join(', ')}`,
  );
  return undefined;
}

/**
 * Check the production dist tree.
 *
 * @param files Map<string, Buffer> — dist-relative path → content.
 * @param catalogSource Buffer — the checked-in catalog JSON
 *   (apps/web/src/lib/standard-ebooks-catalog.json).
 * @returns {{ failures: string[], report: string[] }} empty `failures` means
 *   the bundle honors the contract; `report` is the human summary to print.
 */
export function checkBundle(files, catalogSource) {
  const failures = [];
  const report = [];

  // ---- production identity -------------------------------------------------
  const indexHtml = files.get('index.html');
  if (!indexHtml) failures.push('index.html: missing from dist');
  if (files.has('e2e-harness.html')) failures.push('e2e-harness.html: present in a PRODUCTION build');

  const jsPaths = matching(files, /\.js$/);
  for (const p of jsPaths) {
    const text = files.get(p).toString('utf8');
    for (const s of FACADE_SENTINELS) {
      if (text.includes(s)) failures.push(`${p}: e2e facade sentinel "${s}" leaked into the production bundle`);
    }
  }

  // ---- role chunks ---------------------------------------------------------
  const entryPath = unique(files, /^assets\/index-[^/]+\.js$/, 'entry', failures);
  const workerPath = unique(files, /^assets\/index\.worker-[^/]+\.js$/, 'worker base', failures);
  const archivePath = unique(files, /^assets\/archive-[^/]+\.js$/, 'SE archive client', failures);
  const extractPath = unique(files, /^assets\/extract-[^/]+\.js$/, 'epub extractor', failures);
  const parse5Path = unique(files, /^assets\/dist-[^/]+\.js$/, 'html parser (parse5)', failures);
  const catalogPath = unique(files, /^assets\/standard-ebooks-catalog-[^/]+\.json$/, 'catalog asset', failures);
  const methodSummaryPath = unique(files, /^assets\/MethodSummary-[^/]+\.js$/, 'Method summary', failures);
  const methodSurfacePath = unique(files, /^assets\/MethodSurface-[^/]+\.js$/, 'Method region', failures);
  const querySurfacePath = unique(files, /^assets\/QuerySurface-[^/]+\.js$/, 'Query region', failures);
  const footerPath = unique(files, /^assets\/WorkbenchFooter-[^/]+\.js$/, 'Reading footer', failures);
  const localLibraryPath = unique(files, /^assets\/local-library-[^/]+\.js$/, 'local library', failures);
  const placePaths = new Map(
    PLACE_CHUNKS.map(([place, re]) => [
      place,
      unique(files, re, `${place} place`, failures),
    ]),
  );

  // Entry identity: index.html must load exactly the one entry chunk.
  if (indexHtml && entryPath) {
    const scripts = [...indexHtml.toString('utf8').matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
    if (scripts.length !== 1 || !scripts[0].endsWith(entryPath)) {
      failures.push(`index.html: expected one entry script ending in ${entryPath}, saw [${scripts.join(', ')}]`);
    }
  }

  // ---- entry budget --------------------------------------------------------
  if (entryPath) {
    const bytes = files.get(entryPath);
    const gz = gzipSize(bytes);
    report.push(`entry ${entryPath}: ${bytes.length} B raw, ${gz} B gzip (${(gz / 1000).toFixed(1)} kB) — budget ${ENTRY_GZIP_BUDGET_BYTES} B`);
    if (gz > ENTRY_GZIP_BUDGET_BYTES) {
      failures.push(`${entryPath}: gzip ${gz} B exceeds the ${ENTRY_GZIP_BUDGET_BYTES} B entry budget`);
    }
    for (const [path, role] of [
      [methodSurfacePath, 'Method'],
      [querySurfacePath, 'Query'],
      [footerPath, 'Reading footer'],
      [localLibraryPath, 'local library'],
    ]) {
      if (!path) continue;
      const name = path.replace('assets/', '');
      const entryText = files.get(entryPath).toString('utf8');
      const entryStatic = staticImports(entryText);
      if (entryStatic.has(name)) {
        failures.push(`${entryPath}: statically imports ${name} — the ${role} region must stay lazy`);
      } else if (!references(entryText, name)) {
        failures.push(`${entryPath}: no reference to ${name} — the lazy ${role} region edge is gone`);
      }
    }
  }

  // Method has a two-hop lazy boundary: the entry loads the responsive host,
  // and only that host may load the heavier provenance summary.
  if (methodSurfacePath && methodSummaryPath) {
    const surfaceText = files.get(methodSurfacePath).toString('utf8');
    const summaryName = methodSummaryPath.replace('assets/', '');
    if (staticImports(surfaceText).has(summaryName)) {
      failures.push(`${methodSurfacePath}: statically imports ${summaryName} — the Method summary must stay lazy`);
    } else if (!references(surfaceText, summaryName)) {
      failures.push(`${methodSurfacePath}: no reference to ${summaryName} — the lazy Method summary edge is gone`);
    }
  }

  // ---- active-place lazy boundaries ---------------------------------------
  // Every place must remain independently addressable by the entry loader.
  // A static place import would mount route code in the initial payload even
  // though App renders only one active place.
  if (entryPath) {
    const entryText = files.get(entryPath).toString('utf8');
    const entryStatic = staticImports(entryText);
    for (const [place, path] of placePaths) {
      if (!path) continue;
      const name = path.replace('assets/', '');
      if (entryStatic.has(name)) {
        failures.push(`${entryPath}: statically imports ${name} — the ${place} place must stay lazy`);
      } else if (!references(entryText, name)) {
        failures.push(`${entryPath}: no reference to ${name} — the lazy ${place} place edge is gone`);
      }
    }
  }

  // ---- catalog stays an asset ----------------------------------------------
  if (catalogPath) {
    if (!files.get(catalogPath).equals(catalogSource)) {
      failures.push(`${catalogPath}: bytes differ from the checked-in catalog JSON`);
    }
    let sentinels = [];
    try {
      const catalog = JSON.parse(catalogSource.toString('utf8'));
      const names = (catalog.books ?? []).map((b) => b.name).filter((n) => typeof n === 'string');
      names.sort((a, b) => b.length - a.length);
      sentinels = [catalog.generatedAt, ...names.slice(0, 3)].filter((s) => typeof s === 'string' && s.length >= 8);
    } catch {
      failures.push('catalog source: not parseable JSON — cannot derive inline-content sentinels');
    }
    for (const p of jsPaths) {
      const text = files.get(p).toString('utf8');
      for (const s of sentinels) {
        if (text.includes(s)) failures.push(`${p}: catalog content ("${s}") embedded in a script — the catalog must ship only as the fetched JSON asset`);
      }
    }
  }

  // ---- Standard Ebooks archive stays behind the Inputs place ------------
  const inputsPlacePath = placePaths.get('Inputs');
  if (entryPath && inputsPlacePath && archivePath) {
    const entryText = files.get(entryPath).toString('utf8');
    const inputsPlaceText = files.get(inputsPlacePath).toString('utf8');
    const inputsPlaceStatic = staticImports(inputsPlaceText);
    const archiveName = archivePath.replace('assets/', '');
    if (references(entryText, archiveName)) {
      failures.push(`${entryPath}: references ${archiveName} — the archive client must load only through the Inputs place`);
    }
    if (inputsPlaceStatic.has(archiveName)) {
      failures.push(`${inputsPlacePath}: statically imports ${archiveName} — the archive client must stay lazy`);
    } else if (!references(inputsPlaceText, archiveName)) {
      failures.push(`${inputsPlacePath}: no reference to ${archiveName} — the lazy archive edge is gone`);
    }
  }

  // ---- worker split --------------------------------------------------------
  if (workerPath && extractPath && parse5Path) {
    const workerText = files.get(workerPath).toString('utf8');
    const workerStatic = staticImports(workerText);
    for (const [path, label] of [[extractPath, 'epub extractor'], [parse5Path, 'html parser']]) {
      const name = path.replace('assets/', '');
      if (workerStatic.has(name)) failures.push(`${workerPath}: statically imports ${name} — the ${label} must stay a lazy worker chunk`);
      else if (!references(workerText, name)) failures.push(`${workerPath}: no dynamic import of ${name} — the lazy ${label} edge is gone`);
    }
  }

  // ---- summary -------------------------------------------------------------
  let raw = 0;
  let gz = 0;
  for (const bytes of files.values()) {
    raw += bytes.length;
    gz += gzipSize(bytes);
  }
  report.push(`${files.size} assets, ${raw} B raw, ${gz} B gzip total`);

  return { failures, report };
}
