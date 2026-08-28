#!/usr/bin/env node
/**
 * Refresh the nine bundled Sherlock Holmes demo texts from Standard Ebooks'
 * official release EPUBs. Run ad hoc with `pnpm update:sherlock-corpus`.
 *
 * The Standard Ebooks client selects body matter and applies the same XHTML
 * text serializer used by EPUB imports in the app. Downloads are deliberately
 * sequential, and repository fallback is disabled: a refresh must come from
 * the official release media or leave the existing corpus untouched.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StandardEbooksClient } from '@texttrends/standard-ebooks';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = join(ROOT, 'text/sherlock');
const PROJECT_PATH = join(ROOT, 'apps/web/src/lib/project.ts');

const BOOKS = [
  {
    doc: '1 - A Study in Scarlet - Arthur Conan Doyle',
    title: 'A Study in Scarlet',
    repository: 'arthur-conan-doyle_a-study-in-scarlet',
  },
  {
    doc: '2 - The Sign of the Four - Arthur Conan Doyle',
    title: 'The Sign of the Four',
    repository: 'arthur-conan-doyle_the-sign-of-the-four',
  },
  {
    doc: '3 - The Adventures of Sherlock Holmes - Arthur Conan Doyle',
    title: 'The Adventures of Sherlock Holmes',
    repository: 'arthur-conan-doyle_the-adventures-of-sherlock-holmes',
  },
  {
    doc: '4 - The Memoirs of Sherlock Holmes - Arthur Conan Doyle',
    title: 'The Memoirs of Sherlock Holmes',
    repository: 'arthur-conan-doyle_the-memoirs-of-sherlock-holmes',
  },
  {
    doc: '5 - The Hound of the Baskervilles - Arthur Conan Doyle',
    title: 'The Hound of the Baskervilles',
    repository: 'arthur-conan-doyle_the-hound-of-the-baskervilles',
  },
  {
    doc: '6 - The Return of Sherlock Holmes - Arthur Conan Doyle',
    title: 'The Return of Sherlock Holmes',
    repository: 'arthur-conan-doyle_the-return-of-sherlock-holmes',
  },
  {
    doc: '7 - The Valley of Fear - Arthur Conan Doyle',
    title: 'The Valley of Fear',
    repository: 'arthur-conan-doyle_the-valley-of-fear',
  },
  {
    doc: '8 - His Last Bow - Arthur Conan Doyle',
    title: 'His Last Bow',
    repository: 'arthur-conan-doyle_his-last-bow',
  },
  {
    doc: '9 - The Casebook of Sherlock Holmes - Arthur Conan Doyle',
    title: 'The Casebook of Sherlock Holmes',
    repository: 'arthur-conan-doyle_the-casebook-of-sherlock-holmes',
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
  const stagingDir = await mkdtemp(join(dirname(CORPUS_DIR), '.sherlock-update-'));
  const entries = [];

  try {
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

      // The extractor returns trimmed text; text files conventionally end in
      // one LF. That LF is part of the bundled source/text identity.
      const text = `${downloaded.text}\n`;
      const bytes = new TextEncoder().encode(text);
      await writeFile(join(stagingDir, `${book.doc}.txt`), bytes);
      entries.push(manifestEntry(book, bytes, text));
      console.log(`${book.title}: ${bytes.byteLength} bytes from ${downloaded.source.url}`);
    }

    const project = await readFile(PROJECT_PATH, 'utf8');
    const start = 'export const SHERLOCK: readonly { doc: string; title: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [';
    const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?\\n\\];`);
    const matches = project.match(new RegExp(pattern.source, 'g')) ?? [];
    assert(matches.length === 1, `Expected exactly one SHERLOCK manifest block, found ${matches.length}`);
    const nextProject = project.replace(pattern, `${start}\n${entries.join('\n')}\n];`);
    const stagedProject = join(stagingDir, 'project.ts');
    await writeFile(stagedProject, nextProject, 'utf8');

    // All network and validation work has succeeded. Replace only now.
    for (const book of BOOKS) {
      await rename(join(stagingDir, `${book.doc}.txt`), join(CORPUS_DIR, `${book.doc}.txt`));
    }
    await rename(stagedProject, PROJECT_PATH);
    console.log(`refreshed ${BOOKS.length} bundled books and their manifest`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error('Refresh failed; downloads were staged before replacement.');
  process.exitCode = 1;
});
