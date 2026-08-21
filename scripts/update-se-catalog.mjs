#!/usr/bin/env node
/**
 * Regenerate the baked Standard Ebooks catalog consumed by the web app
 * (apps/web/src/lib/standard-ebooks-catalog.json). Run ad hoc via
 * `pnpm update:se-catalog` — never in CI and never from the app itself.
 *
 * The catalog is a frozen index of the top {@link TOP_COUNT} ebooks by the
 * standardebooks.org "Popularity (most → least)" sort. Every fact baked into
 * the artifact is cross-checked before anything is written (the gates live in
 * se-catalog-lib.mjs and are covered by its offline fixture suite):
 *
 * - every response must carry the expected status, final origin, AND media
 *   type; browse pages must carry the expected schema.org RDFa markup and the
 *   expected selected sort/per-page options (an unknown sort
 *   value is silently ignored server-side, so this is the only way to detect
 *   drift);
 * - each unique repository's raw `src/epub/content.opf` must exist on
 *   `master` and agree with the derived repository name (dc:identifier +
 *   rel="schema:codeRepository").
 *
 * Fails closed: any drift aborts with a nonzero exit and the existing JSON
 * untouched (the output is written to a temporary sibling and renamed only
 * after all validation passes). If the regenerated content is unchanged, the
 * existing file — including its generatedAt stamp — is left as is.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORGANIZATION,
  ORIGIN,
  RAW_ORIGIN,
  DriftError,
  assert,
  canonicalContent,
  fetchText,
  parsePopularityPage,
  pathToRepositoryName,
  validateOpfDocument,
} from './se-catalog-lib.mjs';

const TOP_COUNT = 1_000;
const PER_PAGE = 48;
const OPF_CONCURRENCY = 6;
const USER_AGENT = 'textTrends-catalog-updater (ad-hoc dev script; contact: repo owner)';
const PAGE_TYPES = ['application/xhtml+xml', 'text/html'];
const OPF_TYPES = ['text/plain'];
const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../apps/web/src/lib/standard-ebooks-catalog.json');

async function fetchPage(url, label) {
  const html = await fetchText(url, { origin: ORIGIN, types: PAGE_TYPES, label, userAgent: USER_AGENT });
  assert(html.includes('<ol class="ebooks-list'), `${label}: no semantic ebooks list found`);
  return html;
}

async function scrapePopularBooks() {
  const books = [];
  const pages = Math.ceil(TOP_COUNT / PER_PAGE);
  for (let page = 1; page <= pages; page++) {
    const html = await fetchPage(`${ORIGIN}/ebooks?sort=popularity&per-page=${PER_PAGE}&page=${page}`, `popularity page ${page}`);
    const minimumCount = page < pages ? PER_PAGE : TOP_COUNT - (pages - 1) * PER_PAGE;
    books.push(...parsePopularityPage(html, { page, perPage: PER_PAGE, minimumCount }));
  }
  const top = books.slice(0, TOP_COUNT);
  assert(new Set(top.map((b) => b.path)).size === TOP_COUNT, 'Popularity pages repeated a book (list moved mid-scrape?) — rerun');
  return top.map((entry, index) => ({ ...entry, name: pathToRepositoryName(entry.path), popularityRank: index + 1 }));
}

async function validateAgainstOpf(book) {
  const opf = await fetchText(`${RAW_ORIGIN}/${ORGANIZATION}/${book.name}/master/src/epub/content.opf`, {
    origin: RAW_ORIGIN,
    types: OPF_TYPES,
    label: `OPF ${book.name}`,
    userAgent: USER_AGENT,
  });
  validateOpfDocument(opf, book);
}

async function inPool(items, limit, run) {
  const queue = [...items.entries()];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await run(next[1]);
    }),
  );
}

async function main() {
  const popular = await scrapePopularBooks();
  console.log(`popularity: ${popular.length} books over ${Math.ceil(TOP_COUNT / PER_PAGE)} pages`);
  await inPool(popular, OPF_CONCURRENCY, validateAgainstOpf);
  console.log(`OPF-validated ${popular.length} repositories`);

  const content = canonicalContent(popular, `${ORIGIN}/ebooks?sort=popularity&per-page=${PER_PAGE}`);
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
  } catch {
    // First generation: no existing catalog to compare against.
  }
  if (previous !== null) {
    const { generatedAt, ...previousContent } = previous;
    if (JSON.stringify(previousContent) === JSON.stringify(content)) {
      console.log(`unchanged — keeping ${OUTPUT_PATH} (generatedAt ${generatedAt})`);
      return;
    }
  }
  const artifact = { schemaVersion: content.schemaVersion, generatedAt: new Date().toISOString(), ...content };
  const staging = `${OUTPUT_PATH}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(artifact, null, 2)}\n`);
    renameSync(staging, OUTPUT_PATH);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  console.log(`wrote ${OUTPUT_PATH}: ${content.books.length} ranked books`);
}

main().catch((error) => {
  console.error(error instanceof DriftError ? `Catalog drift: ${error.message}` : error);
  console.error('Nothing was written; the existing catalog (if any) is untouched.');
  process.exitCode = 1;
});
