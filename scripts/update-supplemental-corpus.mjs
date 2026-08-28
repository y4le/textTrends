#!/usr/bin/env node
/**
 * Refresh the ten-book Classic Novels demo and its integrity manifest from
 * official Standard Ebooks release EPUBs.
 */

import { StandardEbooksClient } from '@texttrends/standard-ebooks';
import { commitCorpus } from './demo-corpus-lib.mjs';

const SUPPLEMENTAL_BOOKS = Object.freeze([
  {
    doc: '01 - Frankenstein - Mary Shelley',
    title: 'Frankenstein',
    repository: 'mary-shelley_frankenstein',
  },
  {
    doc: '02 - Dracula - Bram Stoker',
    title: 'Dracula',
    repository: 'bram-stoker_dracula',
  },
  {
    doc: '03 - Moby Dick - Herman Melville',
    title: 'Moby Dick',
    repository: 'herman-melville_moby-dick',
  },
  {
    doc: '04 - The Picture of Dorian Gray - Oscar Wilde',
    title: 'The Picture of Dorian Gray',
    repository: 'oscar-wilde_the-picture-of-dorian-gray',
  },
  {
    doc: '05 - Jane Eyre - Charlotte Brontë',
    title: 'Jane Eyre',
    repository: 'charlotte-bronte_jane-eyre',
  },
  {
    doc: '06 - Wuthering Heights - Emily Brontë',
    title: 'Wuthering Heights',
    repository: 'emily-bronte_wuthering-heights',
  },
  {
    doc: '07 - Great Expectations - Charles Dickens',
    title: 'Great Expectations',
    repository: 'charles-dickens_great-expectations',
  },
  {
    doc: '08 - The Adventures of Huckleberry Finn - Mark Twain',
    title: 'The Adventures of Huckleberry Finn',
    repository: 'mark-twain_the-adventures-of-huckleberry-finn',
  },
  {
    doc: '09 - Little Women - Louisa May Alcott',
    title: 'Little Women',
    repository: 'louisa-may-alcott_little-women',
  },
  {
    doc: '10 - Anne of Green Gables - L. M. Montgomery',
    title: 'Anne of Green Gables',
    repository: 'l-m-montgomery_anne-of-green-gables',
  },
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const client = new StandardEbooksClient();
  const documents = [];
  for (const book of SUPPLEMENTAL_BOOKS) {
    const downloaded = await client.downloadEbookText(book.repository, {
      partitions: ['bodymatter'],
      fallbackToRepository: false,
    });
    assert(downloaded.source.kind === 'release', `${book.title}: source was not an official release`);
    assert(
      downloaded.source.repository === `standardebooks/${book.repository}`,
      `${book.title}: unexpected repository ${downloaded.source.repository}`,
    );
    assert(downloaded.warnings.length === 0, `${book.title}: download produced warnings`);
    assert(downloaded.metadata.title === book.title, `${book.title}: metadata title is ${downloaded.metadata.title}`);
    assert(downloaded.text.trim() !== '', `${book.title}: extracted body matter is empty`);
    assert(!downloaded.text.includes('\r'), `${book.title}: extracted text contains CR line endings`);
    assert(!downloaded.text.includes('\uFFFD'), `${book.title}: extracted text contains replacement characters`);
    const text = `${downloaded.text}\n`;
    documents.push({ doc: book.doc, title: book.title, text });
    console.log(`${book.title}: ${text.length} UTF-16 units from ${downloaded.source.url}`);
  }
  await commitCorpus({ directory: 'standard-ebooks', manifestName: 'CLASSIC_NOVELS', documents });
}

main().catch((error) => {
  console.error(error);
  console.error('Refresh failed; downloads and manifest replacement were staged before commit.');
  process.exitCode = 1;
});
