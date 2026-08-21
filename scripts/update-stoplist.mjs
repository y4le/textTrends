#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderStoplistModule,
  stoplistFromRanking,
} from './update-stoplist-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, 'text/other/wordlists/common_words.txt');
const OUTPUT = join(ROOT, 'packages/core/src/ops/stoplist-en-data.ts');

async function main() {
  const result = stoplistFromRanking(await readFile(INPUT, 'utf8'));
  await writeFile(OUTPUT, renderStoplistModule(result), 'utf8');
  console.log(
    `${basename(OUTPUT)}: ${result.entries.length} of ${result.candidateCount} matchable entries; `
    + `${result.skippedBeforeBoundary} skipped through source rank ${result.boundarySourceRank}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
