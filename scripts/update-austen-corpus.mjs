#!/usr/bin/env node
/**
 * Refresh Jane Austen's six novels from Standard Ebooks' official release
 * EPUBs. Run ad hoc with `pnpm update:austen-corpus`.
 *
 * Downloads are staged and validated before the corpus directory and its
 * integrity manifest are replaced. Repository fallback is disabled: a
 * refresh must come entirely from official release media or leave the
 * existing corpus untouched.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StandardEbooksClient } from '@texttrends/standard-ebooks';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = join(ROOT, 'text/austen');
const PROJECT_PATH = join(ROOT, 'apps/web/src/lib/project.ts');

const BOOKS = [
  {
    doc: '1 - Sense and Sensibility - Jane Austen',
    title: 'Sense and Sensibility',
    repository: 'jane-austen_sense-and-sensibility',
  },
  {
    doc: '2 - Pride and Prejudice - Jane Austen',
    title: 'Pride and Prejudice',
    repository: 'jane-austen_pride-and-prejudice',
  },
  {
    doc: '3 - Mansfield Park - Jane Austen',
    title: 'Mansfield Park',
    repository: 'jane-austen_mansfield-park',
  },
  {
    doc: '4 - Emma - Jane Austen',
    title: 'Emma',
    repository: 'jane-austen_emma',
  },
  {
    doc: '5 - Northanger Abbey - Jane Austen',
    title: 'Northanger Abbey',
    repository: 'jane-austen_northanger-abbey',
  },
  {
    doc: '6 - Persuasion - Jane Austen',
    title: 'Persuasion',
    repository: 'jane-austen_persuasion',
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tsString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function manifestEntry(book, bytes, text) {
  const hash = sha256(bytes);
  return `  { doc: ${tsString(book.doc)}, title: ${tsString(book.title)}, bytes: ${bytes.byteLength}, textLengthUtf16: ${text.length}, sourceHash: '${hash}', textHash: '${hash}' },`;
}

async function main() {
  const client = new StandardEbooksClient();
  const stagingRoot = await mkdtemp(join(dirname(CORPUS_DIR), '.austen-update-'));
  const stagedCorpus = join(stagingRoot, 'corpus');
  const previousCorpus = join(stagingRoot, 'previous');
  const stagedProject = join(stagingRoot, 'project.ts');
  const entries = [];
  let corpusSwapped = false;

  try {
    await mkdir(stagedCorpus);
    for (const book of BOOKS) {
      const downloaded = await client.downloadEbookText(book.repository, {
        partitions: ['bodymatter'],
        fallbackToRepository: false,
      });
      assert(downloaded.source.kind === 'release', `${book.title}: source was not an official release`);
      assert(
        downloaded.source.repository === `standardebooks/${book.repository}`,
        `${book.title}: unexpected source repository ${downloaded.source.repository}`,
      );
      assert(downloaded.warnings.length === 0, `${book.title}: download produced warnings`);
      assert(downloaded.metadata.title === book.title, `${book.title}: metadata title is ${downloaded.metadata.title}`);
      assert(downloaded.text.trim() !== '', `${book.title}: extracted body matter is empty`);
      assert(!downloaded.text.includes('\r'), `${book.title}: extracted text contains non-LF line endings`);
      assert(!downloaded.text.includes('\uFFFD'), `${book.title}: extracted text contains replacement characters`);

      const text = `${downloaded.text}\n`;
      const bytes = new TextEncoder().encode(text);
      await writeFile(join(stagedCorpus, `${book.doc}.txt`), bytes);
      entries.push(manifestEntry(book, bytes, text));
      console.log(`${book.title}: ${bytes.byteLength} bytes from ${downloaded.source.url}`);
    }

    const project = await readFile(PROJECT_PATH, 'utf8');
    const start = 'export const AUSTEN: readonly { doc: string; title: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [';
    const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(?:  \\{[^\\n]+\\},\\n)*\\];`);
    const matches = project.match(new RegExp(pattern.source, 'g')) ?? [];
    assert(matches.length === 1, `Expected exactly one AUSTEN manifest block, found ${matches.length}`);
    await writeFile(stagedProject, project.replace(pattern, `${start}\n${entries.join('\n')}\n];`), 'utf8');

    // Commit the fully staged pair. If the project rename fails, restore the
    // old corpus before surfacing the error.
    await rename(CORPUS_DIR, previousCorpus);
    try {
      await rename(stagedCorpus, CORPUS_DIR);
      corpusSwapped = true;
      await rename(stagedProject, PROJECT_PATH);
    } catch (error) {
      if (corpusSwapped) await rename(CORPUS_DIR, stagedCorpus);
      await rename(previousCorpus, CORPUS_DIR);
      corpusSwapped = false;
      throw error;
    }
    console.log(`refreshed ${BOOKS.length} bundled books and their manifest`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error('Refresh failed; the existing Austen corpus and manifest were preserved.');
  process.exitCode = 1;
});
