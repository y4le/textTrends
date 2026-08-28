#!/usr/bin/env node
/**
 * Refresh the public built-in demos that do not have a dedicated author-corpus
 * updater. Every target stages and validates all of its texts before replacing
 * the checked-in corpus and its exact integrity manifest.
 *
 * Usage: node scripts/update-demo-corpora.mjs
 *        node scripts/update-demo-corpora.mjs bible|quran|political|shakespeare|inaugurals|darwin|classics
 */

import { unzipSync } from 'fflate';
import { StandardEbooksClient } from '@texttrends/standard-ebooks';
import {
  assert,
  commitCorpus,
  fetchBytes,
  fetchText,
  normalizeLf,
  refreshExistingCorpusManifest,
  stripGutenbergEnvelope,
} from './demo-corpus-lib.mjs';

const BIBLE_ARCHIVE = 'https://ebible.org/Scriptures/engwebp_readaloud.zip';
const QURAN_SOURCE = 'https://www.gutenberg.org/cache/epub/16955/pg16955.txt';
const INAUGURAL_SOURCE = 'https://www.gutenberg.org/cache/epub/4938/pg4938.txt';

const BIBLE_BOOKS = Object.freeze([
  ['GEN', 'Genesis'], ['EXO', 'Exodus'], ['LEV', 'Leviticus'], ['NUM', 'Numbers'], ['DEU', 'Deuteronomy'],
  ['JOS', 'Joshua'], ['JDG', 'Judges'], ['RUT', 'Ruth'], ['1SA', '1 Samuel'], ['2SA', '2 Samuel'],
  ['1KI', '1 Kings'], ['2KI', '2 Kings'], ['1CH', '1 Chronicles'], ['2CH', '2 Chronicles'], ['EZR', 'Ezra'],
  ['NEH', 'Nehemiah'], ['EST', 'Esther'], ['JOB', 'Job'], ['PSA', 'Psalms'], ['PRO', 'Proverbs'],
  ['ECC', 'Ecclesiastes'], ['SNG', 'Song of Solomon'], ['ISA', 'Isaiah'], ['JER', 'Jeremiah'], ['LAM', 'Lamentations'],
  ['EZK', 'Ezekiel'], ['DAN', 'Daniel'], ['HOS', 'Hosea'], ['JOL', 'Joel'], ['AMO', 'Amos'],
  ['OBA', 'Obadiah'], ['JON', 'Jonah'], ['MIC', 'Micah'], ['NAM', 'Nahum'], ['HAB', 'Habakkuk'],
  ['ZEP', 'Zephaniah'], ['HAG', 'Haggai'], ['ZEC', 'Zechariah'], ['MAL', 'Malachi'], ['MAT', 'Matthew'],
  ['MRK', 'Mark'], ['LUK', 'Luke'], ['JHN', 'John'], ['ACT', 'Acts'], ['ROM', 'Romans'],
  ['1CO', '1 Corinthians'], ['2CO', '2 Corinthians'], ['GAL', 'Galatians'], ['EPH', 'Ephesians'], ['PHP', 'Philippians'],
  ['COL', 'Colossians'], ['1TH', '1 Thessalonians'], ['2TH', '2 Thessalonians'], ['1TI', '1 Timothy'], ['2TI', '2 Timothy'],
  ['TIT', 'Titus'], ['PHM', 'Philemon'], ['HEB', 'Hebrews'], ['JAS', 'James'], ['1PE', '1 Peter'],
  ['2PE', '2 Peter'], ['1JN', '1 John'], ['2JN', '2 John'], ['3JN', '3 John'], ['JUD', 'Jude'], ['REV', 'Revelation'],
]);

const POLITICAL_BOOKS = Object.freeze([
  { year: 1532, title: 'The Prince', author: 'Niccolò Machiavelli', repository: 'niccolo-machiavelli_the-prince_w-k-marriott' },
  { year: 1776, title: 'The Wealth of Nations', author: 'Adam Smith', repository: 'adam-smith_the-wealth-of-nations' },
  { year: 1788, title: 'The Federalist Papers', author: 'Hamilton, Madison, and Jay', repository: 'alexander-hamilton_john-jay_james-madison_the-federalist-papers' },
  { year: 1792, title: 'A Vindication of the Rights of Woman', author: 'Mary Wollstonecraft', repository: 'mary-wollstonecraft_a-vindication-of-the-rights-of-woman' },
  { year: 1848, title: 'The Communist Manifesto', author: 'Karl Marx and Friedrich Engels', repository: 'karl-marx_friedrich-engels_the-communist-manifesto_samuel-moore' },
  { year: 1859, title: 'On Liberty', author: 'John Stuart Mill', repository: 'john-stuart-mill_on-liberty' },
  { year: 1903, title: 'The Souls of Black Folk', author: 'W. E. B. Du Bois', repository: 'w-e-b-du-bois_the-souls-of-black-folk' },
]);

// Approximate composition order. Dating and, for several collaborations,
// attribution are scholarly estimates rather than claims encoded by the app.
const SHAKESPEARE_PLAYS = Object.freeze([
  ['The Two Gentlemen of Verona', 'william-shakespeare_the-two-gentlemen-of-verona'],
  ['The Taming of the Shrew', 'william-shakespeare_the-taming-of-the-shrew'],
  ['Henry VI, Part II', 'william-shakespeare_henry-vi-part-ii'],
  ['Henry VI, Part III', 'william-shakespeare_henry-vi-part-iii'],
  ['Henry VI, Part I', 'william-shakespeare_henry-vi-part-i'],
  ['Titus Andronicus', 'william-shakespeare_titus-andronicus'],
  ['Richard III', 'william-shakespeare_richard-iii'],
  ['Edward III', 'william-shakespeare_edward-iii'],
  ['The Comedy of Errors', 'william-shakespeare_the-comedy-of-errors'],
  ['Love’s Labour’s Lost', 'william-shakespeare_loves-labours-lost'],
  ['Romeo and Juliet', 'william-shakespeare_romeo-and-juliet'],
  ['Richard II', 'william-shakespeare_richard-ii'],
  ['A Midsummer Night’s Dream', 'william-shakespeare_a-midsummer-nights-dream'],
  ['King John', 'william-shakespeare_king-john'],
  ['The Merchant of Venice', 'william-shakespeare_the-merchant-of-venice'],
  ['Henry IV, Part I', 'william-shakespeare_henry-iv-part-i'],
  ['The Merry Wives of Windsor', 'william-shakespeare_the-merry-wives-of-windsor'],
  ['Henry IV, Part II', 'william-shakespeare_henry-iv-part-ii'],
  ['Much Ado About Nothing', 'william-shakespeare_much-ado-about-nothing'],
  ['Henry V', 'william-shakespeare_henry-v'],
  ['Julius Caesar', 'william-shakespeare_julius-caesar'],
  ['As You Like It', 'william-shakespeare_as-you-like-it'],
  ['Hamlet', 'william-shakespeare_hamlet'],
  ['Twelfth Night', 'william-shakespeare_twelfth-night'],
  ['Troilus and Cressida', 'william-shakespeare_troilus-and-cressida'],
  ['Measure for Measure', 'william-shakespeare_measure-for-measure'],
  ['Othello', 'william-shakespeare_othello'],
  ['All’s Well That Ends Well', 'william-shakespeare_alls-well-that-ends-well'],
  ['King Lear', 'william-shakespeare_king-lear'],
  ['Macbeth', 'william-shakespeare_macbeth'],
  ['Antony and Cleopatra', 'william-shakespeare_antony-and-cleopatra'],
  ['Timon of Athens', 'william-shakespeare_timon-of-athens'],
  ['Coriolanus', 'william-shakespeare_coriolanus'],
  ['Pericles', 'william-shakespeare_pericles'],
  ['Cymbeline', 'william-shakespeare_cymbeline'],
  ['The Winter’s Tale', 'william-shakespeare_the-winters-tale'],
  ['The Tempest', 'william-shakespeare_the-tempest'],
  ['Henry VIII', 'william-shakespeare_henry-viii'],
  ['The Two Noble Kinsmen', 'william-shakespeare_john-fletcher_the-two-noble-kinsmen'],
]);

const CLASSIC_NOVELS = Object.freeze([
  ['01 - Frankenstein - Mary Shelley', 'Frankenstein'],
  ['02 - Dracula - Bram Stoker', 'Dracula'],
  ['03 - Moby Dick - Herman Melville', 'Moby Dick'],
  ['04 - The Picture of Dorian Gray - Oscar Wilde', 'The Picture of Dorian Gray'],
  ['05 - Jane Eyre - Charlotte Brontë', 'Jane Eyre'],
  ['06 - Wuthering Heights - Emily Brontë', 'Wuthering Heights'],
  ['07 - Great Expectations - Charles Dickens', 'Great Expectations'],
  ['08 - The Adventures of Huckleberry Finn - Mark Twain', 'The Adventures of Huckleberry Finn'],
  ['09 - Little Women - Louisa May Alcott', 'Little Women'],
  ['10 - Anne of Green Gables - L. M. Montgomery', 'Anne of Green Gables'],
]);

const DARWIN_EDITIONS = Object.freeze([
  { year: 1859, ordinal: 'First', kind: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/1228/pg1228.txt' },
  { year: 1860, ordinal: 'Second', kind: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/22764/pg22764.txt' },
  { year: 1861, ordinal: 'Third', kind: 'ocr', id: 'b28075134' },
  { year: 1866, ordinal: 'Fourth', kind: 'ocr', id: 'b28086065' },
  { year: 1869, ordinal: 'Fifth', kind: 'ocr', id: 'b21955505' },
  { year: 1872, ordinal: 'Sixth', kind: 'standard-ebooks', repository: 'charles-darwin_the-origin-of-species' },
]);

function document(index, title, text, suffix = '') {
  const prefix = String(index + 1).padStart(3, '0');
  const cleaned = normalizeLf(text).replace(/[ \t]+$/gmu, '').trim();
  return { doc: `${prefix} - ${title}${suffix}`, title, text: `${cleaned}\n` };
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function downloadStandardEbook(client, repository, title, partitions = ['bodymatter']) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await client.downloadEbookText(repository, {
        partitions,
        fallbackToRepository: false,
      });
    } catch (error) {
      if (error?.code !== 'RATE_LIMITED' || attempt === 3) throw error;
      console.warn(`${title}: Standard Ebooks rate-limited attempt ${attempt}; retrying after 45 seconds`);
      await pause(45_000);
    }
  }
  throw new Error(`${title}: unreachable Standard Ebooks retry state`);
}

async function standardEbookDocuments(books, map) {
  const client = new StandardEbooksClient();
  const documents = [];
  for (let index = 0; index < books.length; index += 1) {
    const book = books[index];
    const title = book.title ?? book[0];
    const downloaded = await downloadStandardEbook(client, book.repository ?? book[1], title);
    assert(downloaded.source.kind === 'release', `${title}: source was not an official release`);
    assert(downloaded.warnings.length === 0, `${title}: extraction produced warnings`);
    assert(downloaded.metadata.title === title, `${title}: release title is ${downloaded.metadata.title}`);
    documents.push(map(book, downloaded.text, index));
    console.log(`${title}: ${downloaded.text.length} UTF-16 units from ${downloaded.source.url}`);
    if (index + 1 < books.length) await pause(2_100);
  }
  return documents;
}

export function parseWorldEnglishBible(files) {
  return BIBLE_BOOKS.map(([code, title], index) => {
    const pattern = new RegExp(`_\\d{3}_${code}_(\\d{2,3})_read\\.txt$`, 'u');
    const chapters = Object.entries(files)
      .flatMap(([name, bytes]) => {
        const match = pattern.exec(name);
        return match === null ? [] : [{ chapter: Number(match[1]), bytes }];
      })
      .sort((a, b) => a.chapter - b.chapter);
    assert(chapters.length > 0, `${title}: no chapter files in World English Bible archive`);
    for (let chapter = 1; chapter <= chapters.length; chapter += 1) {
      assert(chapters[chapter - 1].chapter === chapter, `${title}: missing or duplicate chapter ${chapter}`);
    }
    const text = chapters.map(({ bytes }) => normalizeLf(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).trim()).join('\n\n');
    return document(index, title, text, ' - World English Bible');
  });
}

function titleCaseHeading(value) {
  return value.toLocaleLowerCase('en').replace(/(^|[\s('’—-])([a-z])/gu, (_whole, before, letter) => `${before}${letter.toLocaleUpperCase('en')}`);
}

export function parsePickthallQuran(source) {
  const lines = stripGutenbergEnvelope(source).split('\n');
  const chapters = [];
  let chapter = null;
  let capturePickthall = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const chapterMatch = /^Chapter (\d+):$/u.exec(line);
    if (chapterMatch !== null) {
      if (chapter !== null) chapters.push(chapter);
      chapter = { number: Number(chapterMatch[1]), title: '', verses: [] };
      capturePickthall = false;
      continue;
    }
    if (chapter === null) continue;
    if (chapter.title === '' && /^[A-Z]/u.test(line) && !/^Total Verses:/u.test(line) && !/^-+$/u.test(line)) {
      chapter.title = titleCaseHeading(line);
      continue;
    }
    if (/^P:\s*/u.test(line)) {
      chapter.verses.push(line.replace(/^P:\s*/u, ''));
      capturePickthall = true;
      continue;
    }
    if (/^[YS]:\s*/u.test(line) || /^\d{3}\.\d{3}$/u.test(line) || /^-+$/u.test(line)) {
      capturePickthall = false;
      continue;
    }
    if (capturePickthall && line !== '') {
      chapter.verses[chapter.verses.length - 1] += ` ${line}`;
    }
  }
  if (chapter !== null) chapters.push(chapter);
  assert(chapters.length === 114, `Quran source yielded ${chapters.length} chapters, expected 114`);
  return chapters.map((entry, index) => {
    assert(entry.number === index + 1, `Quran chapter ${index + 1} is numbered ${entry.number}`);
    assert(entry.title !== '' && entry.verses.length > 0, `Quran chapter ${entry.number} is incomplete`);
    return document(index, entry.title, `${entry.title}\n\n${entry.verses.join('\n')}`, ' - Pickthall');
  });
}

export function parseInauguralAddresses(source) {
  // Gutenberg wraps two long FDR headings immediately before the year.
  const body = stripGutenbergEnvelope(source)
    .replace(/(Inaugural Address[^\n]*),\n(\d{4})/gu, '$1, $2');
  const contentsStart = body.indexOf('\nCONTENTS\n');
  const contentsEnd = body.indexOf('\n*****', contentsStart);
  assert(contentsStart >= 0 && contentsEnd > contentsStart, 'inaugural contents block is missing');
  const pattern = /^(?<president>.+), (?<address>(?:(?:First|Second|Third|Fourth) )?Inaugural Address), (?<weekday>[A-Za-z]+), (?<date>[A-Za-z]+ \d{1,2}), (?<year>\d{4})\s*$/u;
  const entries = body.slice(contentsStart, contentsEnd).split('\n').flatMap((line) => {
    const match = pattern.exec(line.trim());
    return match?.groups === undefined ? [] : [{
      ...match.groups,
      heading: `${match.groups.president} ${match.groups.address} ${match.groups.weekday}, ${match.groups.date}, ${match.groups.year}`,
    }];
  });
  assert(entries.length === 57, `inaugural source yielded ${entries.length} contents entries, expected 57`);
  let cursor = contentsEnd;
  const locations = entries.map((entry) => {
    if (entry.year === '2009') {
      const start = body.indexOf("\nText of President Barack Obama's inaugural address", cursor);
      const speech = body.indexOf('OBAMA: My fellow citizens:', start);
      assert(start >= 0 && speech > start, '2009 Barack Hussein Obama: body heading is missing');
      cursor = speech + 'OBAMA: '.length;
      return { start, bodyStart: cursor };
    }
    if (entry.year === '2013') {
      const start = body.indexOf("\nText of President Barack Obama's second inaugural address", cursor);
      const speech = body.indexOf('THE PRESIDENT:', start);
      assert(start >= 0 && speech > start, '2013 Barack Hussein Obama: body heading is missing');
      cursor = speech + 'THE PRESIDENT:'.length;
      return { start, bodyStart: cursor };
    }
    const prefix = `${entry.president} ${entry.address}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const heading = new RegExp(`(?:^|\\n)${prefix}[^\\n]*${entry.year}\\s*(?:\\n|$)`, 'gu');
    heading.lastIndex = cursor;
    const match = heading.exec(body);
    assert(match !== null, `${entry.year} ${entry.president}: body heading is missing`);
    cursor = heading.lastIndex;
    return { start: match.index, bodyStart: heading.lastIndex };
  });
  return entries.map((entry, index) => {
    const location = locations[index];
    const end = locations[index + 1]?.start ?? body.length;
    assert(end > location.bodyStart, `${entry.year} ${entry.president}: body is empty`);
    const title = `${entry.president} — ${entry.address} (${entry.year})`;
    let speech = body.slice(location.bodyStart, end).replace(/^\*{5}\s*$/gmu, '').trim();
    if (entry.year === '1957') speech = speech.replace(/^THE PRICE OF PEACE\s*/u, '');
    if (entry.year === '2013') {
      speech = speech
        .replace(/[ \t]*\(Applause\.\)/gu, '')
        .replace(/\n+END\s*\n+\d{1,2}:\d{2}\s+[AP]\.M\.\s+[A-Z]{2,4}\s*$/u, '')
        .trim();
    }
    return document(index, title, speech);
  });
}

function reflowScanText(source, { repairOcr = false } = {}) {
  const lines = normalizeLf(source).normalize('NFKC').replaceAll('\f', '\n').split('\n');
  const normalizedLines = lines.map((line) => line.trim().replace(/\s+/gu, ' '));
  const lineCounts = new Map();
  for (const line of normalizedLines) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  const filtered = lines.filter((line, index) => {
    const value = normalizedLines[index];
    const repeatedShortHeading = value.length <= 45
      && lineCounts.get(value) > 1
      && (/^[A-Z][A-Z .,'’—-]+$/u.test(value) || /^(?:Summary|Selection|species)\.?$/u.test(value));
    return !/^\d+$/u.test(value)
      && !/^[ivxlcdm]+$/iu.test(value)
      && !/^[a-z]$/u.test(value)
      && !/^[\\|•]+$/u.test(value)
      && !/^(?:chap|cii?ap|cliap|cuap|ciup|cilap|cuar)[.,]?\s/iu.test(value)
      && !/^\[?page\]?\s*\d*\.?$/iu.test(value)
      && !repeatedShortHeading
      && !/^(?:ORIGIN OF SPECIES|NATURAL SELECTION|CONTENTS|INDEX)\.?$/iu.test(value);
  }).join('\n');
  const reflowed = filtered
    .replace(/([a-z]{2,})-\s*\n\s*([a-z]{2,})/gu, '$1$2')
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/gu, ' ').replace(/[ \t]+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
  return repairOcr ? repairCommonOcrWords(reflowed) : reflowed;
}

const COMMON_OCR_WORDS = Object.freeze({
  aud: 'and', avas: 'was', avere: 'were', avhat: 'what', avhich: 'which', avith: 'with', avould: 'would',
  beheve: 'believe', bemg: 'being', botli: 'both', chaptee: 'chapter', chaptek: 'chapter',
  ciecumstances: 'circumstances', cliaracters: 'characters',
  diiferences: 'differences', diiferent: 'different', difierences: 'differences', difierent: 'different',
  dispeesal: 'dispersal', disteibution: 'distribution', distmct: 'distinct', durmg: 'during',
  eamsay: 'Ramsay', eecapitulation: 'recapitulation', eecord: 'record', eesults: 'results',
  efiected: 'effected', eodents: 'rodents', eussia: 'Russia', favoukable: 'favourable', feesh: 'fresh',
  fisbes: 'fishes', foemation: 'formation', geogeaphical: 'geographical', geoups: 'groups',
  hy: 'by', hybeids: 'hybrids', inteemediate: 'intermediate', inteoduction: 'introduction',
  lias: 'has', liave: 'have', liow: 'how', miglit: 'might', mnst: 'must', msects: 'insects', mto: 'into',
  mucli: 'much', natueal: 'natural', natukal: 'natural', noeth: 'north', occm: 'occur',
  oeganic: 'organic', oegans: 'organs', ofispring: 'offspring', oifspring: 'offspring', ot: 'of',
  otlier: 'other', peeiod: 'period', peesent: 'present', peoductions: 'productions', pkesent: 'present',
  pkoductions: 'productions', prmciple: 'principle', shghtly: 'slightly', sliow: 'show', smgle: 'single',
  sterihty: 'sterility', stkuggle: 'struggle', sucli: 'such', summaey: 'summary', summaky: 'summary',
  tbat: 'that', tbe: 'the', tbey: 'they', theii: 'their', thougli: 'though', througli: 'through',
  tliat: 'that', tlie: 'the', tlieir: 'their', tliem: 'them', tliey: 'they', tliink: 'think',
  tliis: 'this', tliough: 'though', tliese: 'these', tlian: 'than', tliose: 'those', tlms: 'thus',
  tlius: 'thus', trom: 'from', tound: 'found', undee: 'under', vaeiable: 'variable', vaeiation: 'variation',
  vaeieties: 'varieties', vaeious: 'various', veiy: 'very', wbat: 'what', wben: 'when', wbicli: 'which',
  wby: 'why', whicli: 'which', witb: 'with', witli: 'with', witliout: 'without', wiu: 'will',
  wlien: 'when', wliich: 'which', wliicli: 'which', wlio: 'who', wliole: 'whole', woiild: 'would',
  woeld: 'world', wul: 'will', yery: 'very', yiew: 'view',
});

function repairCommonOcrWords(text) {
  return text.replace(/\b[A-Za-z]+\b/gu, (word) => {
    const replacement = COMMON_OCR_WORDS[word.toLocaleLowerCase('en')];
    if (replacement === undefined) return word;
    if (word === word.toLocaleUpperCase('en')) return replacement.toLocaleUpperCase('en');
    if (/^[A-Z]/u.test(word)) return replacement[0].toLocaleUpperCase('en') + replacement.slice(1);
    return replacement;
  });
}

function stripDarwinStructuralHeadings(text) {
  return text.split(/\n\s*\n/gu).filter((paragraph, index) => {
    if (index === 0 || paragraph.length > 100 || /[.!?]["'’)]?$/u.test(paragraph)) return true;
    const words = paragraph.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.length === 0 || words.length > 14) return true;
    return !words.every((word) => /^\p{Lu}/u.test(word) || /^(?:a|an|and|as|at|by|for|from|in|of|on|or|the|to|under|with)$/u.test(word));
  }).join('\n\n');
}

export function cleanDarwinEdition(source, {
  includeHistoricalSketch,
  ocr,
  gutenbergEnvelope = !ocr,
}) {
  const body = gutenbergEnvelope ? stripGutenbergEnvelope(source) : source;
  let text = reflowScanText(body, { repairOcr: ocr });
  let start = -1;
  if (includeHistoricalSketch) {
    start = /An\s+Historical\s+Sketch\s+of\s+the\s+(?:recent\s+)?Progress/iu.exec(text)?.index ?? -1;
  }
  if (start < 0) {
    const introduction = /When\s+on\s+board\s+H\.M\.S\.\s+['‘’]?\s*Beagle/iu.exec(text);
    start = introduction?.index ?? -1;
  }
  assert(start >= 0, 'Darwin edition body start is missing');
  const remainder = text.slice(start);
  const endingPattern = /There is grandeur[\s\S]{0,2500}?evolved\./giu;
  const endings = [...remainder.matchAll(endingPattern)];
  assert(endings.length >= 1, 'Darwin edition conclusion is missing');
  const ending = endings[endings.length - 1];
  text = stripDarwinStructuralHeadings(remainder.slice(0, ending.index + ending[0].length));
  return `${text.trim()}\n`;
}

async function updateBible() {
  const files = unzipSync(await fetchBytes(BIBLE_ARCHIVE));
  await commitCorpus({ directory: 'bible', manifestName: 'BIBLE', documents: parseWorldEnglishBible(files) });
}

async function updateQuran() {
  await commitCorpus({ directory: 'quran', manifestName: 'QURAN', documents: parsePickthallQuran(await fetchText(QURAN_SOURCE)) });
}

async function updatePolitical() {
  const documents = await standardEbookDocuments(POLITICAL_BOOKS, (book, text, index) => (
    document(index, book.title, text, ` - ${book.year} - ${book.author}`)
  ));
  await commitCorpus({ directory: 'political-arguments', manifestName: 'POLITICAL_ARGUMENTS', documents });
}

async function updateShakespeare() {
  const documents = await standardEbookDocuments(SHAKESPEARE_PLAYS, (play, text, index) => (
    document(index, play[0], text, ' - William Shakespeare')
  ));
  await commitCorpus({ directory: 'shakespeare', manifestName: 'SHAKESPEARE', documents });
}

async function updateInaugurals() {
  await commitCorpus({ directory: 'inaugurals', manifestName: 'INAUGURALS', documents: parseInauguralAddresses(await fetchText(INAUGURAL_SOURCE)) });
}

async function updateDarwin() {
  const client = new StandardEbooksClient();
  const documents = [];
  for (let index = 0; index < DARWIN_EDITIONS.length; index += 1) {
    const edition = DARWIN_EDITIONS[index];
    let source;
    if (edition.kind === 'standard-ebooks') {
      const downloaded = await downloadStandardEbook(
        client,
        edition.repository,
        'Darwin sixth edition',
        ['frontmatter', 'bodymatter'],
      );
      assert(downloaded.source.kind === 'release' && downloaded.warnings.length === 0, 'Darwin sixth edition did not come from a clean official release');
      source = downloaded.text;
    } else if (edition.kind === 'ocr') {
      source = await fetchText(`https://archive.org/download/${edition.id}/${edition.id}_djvu.txt`);
    } else {
      source = await fetchText(edition.url);
    }
    const text = cleanDarwinEdition(source, {
      includeHistoricalSketch: edition.year >= 1861,
      ocr: edition.kind === 'ocr',
      gutenbergEnvelope: edition.kind === 'gutenberg',
    });
    assert(/When\s+on\s+board\s+H\.M\.S\.\s+['‘’]?\s*Beagle/iu.test(text), `${edition.year}: introduction is missing`);
    if (edition.year >= 1861) assert(/An\s+Historical\s+Sketch\s+of\s+the\s+(?:recent\s+)?Progress/iu.test(text), `${edition.year}: historical sketch is missing`);
    if (edition.year < 1872) assert(!/\bevolution\b/iu.test(text), `${edition.year}: unexpected use of evolution`);
    if (edition.year >= 1869) assert(/survival of the fittest/iu.test(text), `${edition.year}: survival-of-the-fittest marker is missing`);
    if (edition.year === 1872) assert(/\bevolution\b/iu.test(text), '1872: evolution marker is missing');
    const title = `${edition.ordinal} Edition (${edition.year})`;
    documents.push(document(index, title, text, ' - Charles Darwin'));
    console.log(`${title}: ${text.length} UTF-16 units`);
  }
  await commitCorpus({ directory: 'darwin-origin', manifestName: 'DARWIN_ORIGIN', documents });
}

async function updateClassics() {
  await refreshExistingCorpusManifest({
    directory: 'standard-ebooks',
    manifestName: 'CLASSIC_NOVELS',
    documents: CLASSIC_NOVELS.map(([doc, title]) => ({ doc, title })),
  });
}

const UPDATERS = Object.freeze({
  bible: updateBible,
  quran: updateQuran,
  political: updatePolitical,
  shakespeare: updateShakespeare,
  inaugurals: updateInaugurals,
  darwin: updateDarwin,
  classics: updateClassics,
});

async function main() {
  const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--');
  assert(arguments_.length <= 1, 'choose at most one corpus target');
  const requested = arguments_[0];
  if (requested !== undefined) {
    assert(Object.hasOwn(UPDATERS, requested), `unknown corpus ${JSON.stringify(requested)}; choose ${Object.keys(UPDATERS).join(', ')}`);
    await UPDATERS[requested]();
    return;
  }
  for (const updater of Object.values(UPDATERS)) await updater();
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    console.error('Refresh failed; the active target was staged before replacement. Earlier completed targets remain refreshed.');
    process.exitCode = 1;
  });
}
