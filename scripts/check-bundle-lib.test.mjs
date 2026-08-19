/**
 * Synthetic-fixture coverage for the production-bundle contract
 * (check-bundle-lib.mjs): a minimal well-shaped dist passes, and each
 * architectural violation the checker exists to catch fails with a
 * diagnostic — no real Vite build required.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { ENTRY_GZIP_BUDGET_BYTES, checkBundle } from './check-bundle-lib.mjs';

const CATALOG = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '2026-07-27T13:18:21.184Z',
  books: [
    { name: 'mary-shelley_frankenstein', title: 'Frankenstein' },
    { name: 'robert-louis-stevenson_the-strange-case-of-dr-jekyll-and-mr-hyde', title: 'Jekyll & Hyde' },
  ],
});
const catalogSource = Buffer.from(CATALOG);

/** A minimal contract-conforming dist tree; override/delete entries to break it. */
function syntheticDist() {
  const files = new Map();
  const put = (path, text) => files.set(path, Buffer.isBuffer(text) ? text : Buffer.from(text));
  put(
    'index.html',
    '<html><head><script type="module" crossorigin src="/textTrends/assets/index-AAAA.js"></script></head></html>',
  );
  put(
    'assets/index-AAAA.js',
    'import{h}from"./preload-helper-PPPP.js";const places=["assets/InputsPlace-1111.js","assets/TrendsPlace-2222.js","assets/MatchesPlace-3333.js","assets/VocabularyPlace-4444.js","assets/ComparePlace-5555.js"];const settings="assets/SettingsSurface-UUUU.js";const queries="assets/QuerySurface-QQQQ.js";const footer="assets/WorkbenchFooter-FFFF.js";const library="assets/local-library-LLLL.js";new Worker(new URL("assets/index.worker-WWWW.js",import.meta.url));',
  );
  put('assets/preload-helper-PPPP.js', 'export const h=1;');
  put('assets/InputsPlace-1111.js', 'const archive=()=>import("./archive-RRRR.js");fetch("assets/standard-ebooks-catalog-JJJJ.json");');
  put('assets/TrendsPlace-2222.js', 'export const Trends=1;');
  put('assets/MatchesPlace-3333.js', 'export const Matches=1;');
  put('assets/VocabularyPlace-4444.js', 'export const Vocabulary=1;');
  put('assets/ComparePlace-5555.js', 'export const Compare=1;');
  put('assets/SettingsSurface-UUUU.js', 'export const SettingsSurface=1;');
  put('assets/QuerySurface-QQQQ.js', 'export const QuerySurface=1;');
  put('assets/WorkbenchFooter-FFFF.js', 'export const WorkbenchFooter=1;');
  put('assets/local-library-LLLL.js', 'export const localLibrary=1;');
  put('assets/archive-RRRR.js', 'export const archive=1;');
  put('assets/index.worker-WWWW.js', 'const epub=()=>import(`./extract-EEEE.js`);const html=()=>import(`./dist-DDDD.js`);');
  put('assets/extract-EEEE.js', 'export const extract=1;');
  put('assets/dist-DDDD.js', 'export const parse5=1;');
  put('assets/standard-ebooks-catalog-JJJJ.json', catalogSource);
  return { files, put };
}

const run = (files) => checkBundle(files, catalogSource);

describe('bundle contract', () => {
  it('a conforming dist passes and reports the entry budget', () => {
    const { failures, report } = run(syntheticDist().files);
    assert.deepEqual(failures, []);
    assert.ok(report.some((l) => l.includes(`budget ${ENTRY_GZIP_BUDGET_BYTES} B`)));
  });

  it('an entry over the gzip budget fails', () => {
    const d = syntheticDist();
    // Incompressible bytes: gzip size ≈ raw size, comfortably over budget.
    const noise = randomBytes(ENTRY_GZIP_BUDGET_BYTES + 4096).toString('base64');
    d.put('assets/index-AAAA.js', d.files.get('assets/index-AAAA.js').toString() + `/*${noise}*/`);
    assert.ok(run(d.files).failures.some((f) => f.includes('exceeds')));
  });

  it('a facade sentinel or harness page fails production identity', () => {
    const d = syntheticDist();
    d.put('assets/index-AAAA.js', d.files.get('assets/index-AAAA.js').toString() + ';window.ttE2E={}');
    assert.ok(run(d.files).failures.some((f) => f.includes('ttE2E')));
    const d2 = syntheticDist();
    d2.put('e2e-harness.html', '<html/>');
    assert.ok(run(d2.files).failures.some((f) => f.includes('e2e-harness.html')));
  });

  it('a missing, duplicated, or content-drifted catalog asset fails', () => {
    const d = syntheticDist();
    d.files.delete('assets/standard-ebooks-catalog-JJJJ.json');
    assert.ok(run(d.files).failures.some((f) => f.includes('catalog asset')));
    const d2 = syntheticDist();
    d2.put('assets/standard-ebooks-catalog-KKKK.json', catalogSource);
    assert.ok(run(d2.files).failures.some((f) => f.includes('expected exactly one')));
    const d3 = syntheticDist();
    d3.put('assets/standard-ebooks-catalog-JJJJ.json', CATALOG.replace('Frankenstein', 'Dracula'));
    assert.ok(run(d3.files).failures.some((f) => f.includes('bytes differ')));
  });

  it('catalog content inlined into any script fails', () => {
    const d = syntheticDist();
    d.put('assets/index-AAAA.js', d.files.get('assets/index-AAAA.js').toString() + `;const c=${CATALOG};`);
    assert.ok(run(d.files).failures.some((f) => f.includes('embedded in a script')));
  });

  it('a statically imported SE archive client (dead lazy edge) fails', () => {
    const d = syntheticDist();
    d.put(
      'assets/InputsPlace-1111.js',
      'import{archive}from"./archive-RRRR.js";fetch("assets/standard-ebooks-catalog-JJJJ.json");',
    );
    assert.ok(run(d.files).failures.some((f) =>
      f.includes('InputsPlace-1111.js: statically imports archive-RRRR.js'),
    ));
    // Quote style is emitted-code detail — a single-quoted static import is
    // the same prohibited eager edge.
    const d2 = syntheticDist();
    d2.put(
      'assets/InputsPlace-1111.js',
      "import{archive}from'./archive-RRRR.js';fetch('assets/standard-ebooks-catalog-JJJJ.json');",
    );
    assert.ok(run(d2.files).failures.some((f) => f.includes('statically imports archive-RRRR.js')));
  });

  it('an entry that references the archive client directly fails', () => {
    const d = syntheticDist();
    d.put('assets/index-AAAA.js', d.files.get('assets/index-AAAA.js').toString() + ';import("./archive-RRRR.js")');
    assert.ok(run(d.files).failures.some((f) => f.includes('references archive-RRRR.js')));
  });

  it('a missing or duplicated place chunk fails', () => {
    const d = syntheticDist();
    d.files.delete('assets/TrendsPlace-2222.js');
    assert.ok(run(d.files).failures.some((f) => f.includes('Trends place')));
    const d2 = syntheticDist();
    d2.put('assets/InputsPlace-ZZZZ.js', 'export const duplicate=1;');
    assert.ok(run(d2.files).failures.some((f) => f.includes('Inputs place') && f.includes('found 2')));
  });

  it('an entry missing a place edge or importing a place statically fails', () => {
    const d = syntheticDist();
    d.put(
      'assets/index-AAAA.js',
      d.files.get('assets/index-AAAA.js').toString().replace('"assets/ComparePlace-5555.js"', ''),
    );
    assert.ok(run(d.files).failures.some((f) => f.includes('lazy Compare place edge is gone')));

    const d2 = syntheticDist();
    d2.put(
      'assets/index-AAAA.js',
      d2.files.get('assets/index-AAAA.js').toString() + ';import"./VocabularyPlace-4444.js";',
    );
    assert.ok(run(d2.files).failures.some((f) => f.includes('Vocabulary place must stay lazy')));
  });

  it('a missing, unreferenced, or statically imported Settings region fails', () => {
    const d = syntheticDist();
    d.files.delete('assets/SettingsSurface-UUUU.js');
    assert.ok(run(d.files).failures.some((f) => f.includes('Settings region')));

    const d2 = syntheticDist();
    d2.put(
      'assets/index-AAAA.js',
      d2.files.get('assets/index-AAAA.js').toString()
        .replace('const settings="assets/SettingsSurface-UUUU.js";', ''),
    );
    assert.ok(run(d2.files).failures.some((f) => f.includes('lazy Settings region edge is gone')));

    const d3 = syntheticDist();
    d3.put(
      'assets/index-AAAA.js',
      d3.files.get('assets/index-AAAA.js').toString()
        + ';import"./SettingsSurface-UUUU.js";',
    );
    assert.ok(run(d3.files).failures.some((f) => f.includes('Settings region must stay lazy')));
  });

  it('a missing, unreferenced, or statically imported Query region fails', () => {
    const d = syntheticDist();
    d.files.delete('assets/QuerySurface-QQQQ.js');
    assert.ok(run(d.files).failures.some((f) => f.includes('Query region')));

    const d2 = syntheticDist();
    d2.put(
      'assets/index-AAAA.js',
      d2.files.get('assets/index-AAAA.js').toString()
        .replace('const queries="assets/QuerySurface-QQQQ.js";', ''),
    );
    assert.ok(run(d2.files).failures.some((f) => f.includes('lazy Query region edge is gone')));

    const d3 = syntheticDist();
    d3.put(
      'assets/index-AAAA.js',
      d3.files.get('assets/index-AAAA.js').toString()
        + ';import"./QuerySurface-QQQQ.js";',
    );
    assert.ok(run(d3.files).failures.some((f) => f.includes('Query region must stay lazy')));
  });

  it('a missing, unreferenced, or statically imported Reading footer fails', () => {
    const d = syntheticDist();
    d.files.delete('assets/WorkbenchFooter-FFFF.js');
    assert.ok(run(d.files).failures.some((f) => f.includes('Reading footer')));

    const d2 = syntheticDist();
    d2.put(
      'assets/index-AAAA.js',
      d2.files.get('assets/index-AAAA.js').toString()
        .replace('const footer="assets/WorkbenchFooter-FFFF.js";', ''),
    );
    assert.ok(run(d2.files).failures.some((f) => f.includes('lazy Reading footer region edge is gone')));

    const d3 = syntheticDist();
    d3.put(
      'assets/index-AAAA.js',
      d3.files.get('assets/index-AAAA.js').toString()
        + ';import"./WorkbenchFooter-FFFF.js";',
    );
    assert.ok(run(d3.files).failures.some((f) => f.includes('Reading footer region must stay lazy')));
  });

  it('a missing, unreferenced, or statically imported local library fails', () => {
    const d = syntheticDist();
    d.files.delete('assets/local-library-LLLL.js');
    assert.ok(run(d.files).failures.some((f) => f.includes('local library')));

    const d2 = syntheticDist();
    d2.put(
      'assets/index-AAAA.js',
      d2.files.get('assets/index-AAAA.js').toString()
        .replace('const library="assets/local-library-LLLL.js";', ''),
    );
    assert.ok(run(d2.files).failures.some((f) => f.includes('lazy local library region edge is gone')));

    const d3 = syntheticDist();
    d3.put(
      'assets/index-AAAA.js',
      d3.files.get('assets/index-AAAA.js').toString()
        + ';import"./local-library-LLLL.js";',
    );
    assert.ok(run(d3.files).failures.some((f) => f.includes('local library region must stay lazy')));
  });

  it('a Inputs place without the lazy archive edge fails', () => {
    const d = syntheticDist();
    d.put('assets/InputsPlace-1111.js', 'fetch("assets/standard-ebooks-catalog-JJJJ.json");');
    assert.ok(run(d.files).failures.some((f) => f.includes('lazy archive edge is gone')));
  });

  it('a worker missing a lazy parser edge, or importing one statically, fails', () => {
    const d = syntheticDist();
    d.put('assets/index.worker-WWWW.js', 'const html=()=>import(`./dist-DDDD.js`);');
    assert.ok(run(d.files).failures.some((f) => f.includes('extract-EEEE.js')));
    const d2 = syntheticDist();
    d2.put('assets/index.worker-WWWW.js', 'import"./extract-EEEE.js";const html=()=>import(`./dist-DDDD.js`);');
    assert.ok(run(d2.files).failures.some((f) => f.includes('statically imports extract-EEEE.js')));
    const d3 = syntheticDist();
    d3.put('assets/index.worker-WWWW.js', "import'./extract-EEEE.js';const html=()=>import(`./dist-DDDD.js`);");
    assert.ok(run(d3.files).failures.some((f) => f.includes('statically imports extract-EEEE.js')));
  });

  it('an ambiguous role glob fails with the observed assets listed', () => {
    const d = syntheticDist();
    d.put('assets/archive-ZZZZ.js', 'export const dup=1;');
    const { failures } = run(d.files);
    assert.ok(failures.some((f) => f.includes('found 2') && f.includes('archive-RRRR.js') && f.includes('archive-ZZZZ.js')));
  });

  it('index.html loading a script other than the entry chunk fails', () => {
    const d = syntheticDist();
    d.put('index.html', '<html><head><script type="module" src="/textTrends/assets/other-XXXX.js"></script></head></html>');
    assert.ok(run(d.files).failures.some((f) => f.includes('expected one entry script')));
  });
});
