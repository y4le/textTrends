import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanDarwinEdition,
  parseInauguralAddresses,
  parsePickthallQuran,
  parseWorldEnglishBible,
} from './update-demo-corpora.mjs';

const encoder = new TextEncoder();
const gutenberg = (body) => [
  '*** START OF THE PROJECT GUTENBERG EBOOK TEST ***',
  body,
  '*** END OF THE PROJECT GUTENBERG EBOOK TEST ***',
].join('\n');

test('parseWorldEnglishBible assembles all 66 books in canonical order', () => {
  const codes = [
    'GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH',
    'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON',
    'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL',
    'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN',
    'JUD', 'REV',
  ];
  const files = Object.fromEntries(codes.map((code, index) => [
    `archive/engwebp_${String(index + 1).padStart(3, '0')}_${code}_01_read.txt`,
    encoder.encode(`${code} chapter 1\nText for ${code}.\n`),
  ]));

  const documents = parseWorldEnglishBible(files);
  assert.equal(documents.length, 66);
  assert.equal(documents[0].title, 'Genesis');
  assert.equal(documents.at(-1).title, 'Revelation');
  assert.match(documents[0].text, /GEN chapter 1/u);
});

test('parsePickthallQuran keeps exactly the Pickthall row for all 114 surahs', () => {
  const chapters = Array.from({ length: 114 }, (_, index) => [
    `Chapter ${index + 1}:`,
    `SURAH ${index + 1}`,
    `P: Pickthall verse ${index + 1}.`,
    'Y: Yusuf Ali row.',
    'S: Shakir row.',
  ].join('\n')).join('\n');

  const documents = parsePickthallQuran(gutenberg(chapters));
  assert.equal(documents.length, 114);
  assert.equal(documents[0].title, 'Surah 1');
  assert.match(documents.at(-1).text, /Pickthall verse 114\./u);
  assert.doesNotMatch(documents.map(({ text }) => text).join('\n'), /Yusuf|Shakir/u);
});

test('parseInauguralAddresses removes the exceptional headings and 2013 press furniture', () => {
  const years = [...Array.from({ length: 54 }, (_, index) => 1900 + index), 1957, 2009, 2013];
  const entries = years.map((year, index) => ({
    year,
    president: year === 2009 || year === 2013 ? 'Barack Hussein Obama' : `President ${index + 1}`,
  }));
  const contents = entries.map(({ president, year }) => (
    `${president}, Inaugural Address, Monday, January 1, ${year}`
  )).join('\n');
  const speeches = entries.map(({ president, year }) => {
    if (year === 2009) {
      return "Text of President Barack Obama's inaugural address\nPress preamble\nOBAMA: My fellow citizens: Speech 2009.";
    }
    if (year === 2013) {
      return "Text of President Barack Obama's second inaugural address\nPress preamble\nTHE PRESIDENT: Speech 2013.  (Applause.)\n\nEND\n12:10 P.M. EST";
    }
    const subtitle = year === 1957 ? 'THE PRICE OF PEACE\n\n' : '';
    return `${president} Inaugural Address Monday, January 1, ${year}\n${subtitle}Speech ${year}.`;
  }).join('\n');
  const source = gutenberg(`Presidential addresses\n\nCONTENTS\n${contents}\n*****\n${speeches}`);

  const documents = parseInauguralAddresses(source);
  assert.equal(documents.length, 57);
  assert.doesNotMatch(documents.find(({ title }) => title.endsWith('(1957)')).text, /PRICE OF PEACE/u);
  const obama2013 = documents.at(-1).text;
  assert.match(obama2013, /Speech 2013\./u);
  assert.doesNotMatch(obama2013, /Applause|^END$|P\.M\. EST/mu);
});

test('cleanDarwinEdition aligns front matter and headings without applying OCR fixes to clean text', () => {
  const source = [
    'Imprint',
    '',
    'An Historical Sketch of the Progress of Opinion on the Origin of Species',
    '',
    'Sketch prose.',
    '',
    'Introduction',
    '',
    'When on board H.M.S. Beagle, tlie clean transcription begins.',
    '',
    'Variation Under Domestication',
    '',
    'Body prose about variation.',
    '',
    'There is grandeur in this view of life, from so simple a beginning endless forms evolved.',
  ].join('\n');

  const clean = cleanDarwinEdition(source, {
    includeHistoricalSketch: true,
    ocr: false,
    gutenbergEnvelope: false,
  });
  assert.match(clean, /^An Historical Sketch/u);
  assert.match(clean, /When on board H\.M\.S\. Beagle/u);
  assert.match(clean, /\btlie clean transcription\b/u);
  assert.doesNotMatch(clean, /^Introduction$|^Variation Under Domestication$/mu);

  const repaired = cleanDarwinEdition(source, {
    includeHistoricalSketch: true,
    ocr: true,
    gutenbergEnvelope: false,
  });
  assert.match(repaired, /\bthe clean transcription\b/u);
});
