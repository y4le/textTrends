# Corpus sources

Prepared corpora load as ordinary browser-local texts in declared order.
Integrity manifests and refresh scripts record their acquired bytes. Refresh
commands live in [development](../docs/development.md#refresh-acquired-resources);
[the publication inventory](../docs/design/corpus-inventory.md) owns distribution
constraints, private-resource exclusions, and the history decision.

## Standard Ebooks texts

These corpora use official Standard Ebooks release EPUBs, with body matter
serialized to UTF-8 text using the app's `xhtml-block-collapse-v1` extraction.
Their underlying works are recorded as US public domain; Standard Ebooks
releases its editorial work under CC0.

| Directory | Texts and declared order |
| --- | --- |
| `sherlock/` | Complete nine-volume Doyle sequence in publication order, from the Standard Ebooks Sherlock Holmes collection |
| `austen/` | Six Jane Austen novels in publication order |
| `standard-ebooks/` | Ten-book Classic Novels sample |
| `political-arguments/` | Seven works in original-publication order: The Prince, The Wealth of Nations, The Federalist Papers, A Vindication of the Rights of Woman, The Communist Manifesto, On Liberty, The Souls of Black Folk |
| `shakespeare/` | 39 plays in approximate composition order, including Edward III and The Two Noble Kinsmen |

Shakespeare's composition dates and collaborative attributions are estimates;
the order is an analytical convention, not a settled chronology. Sherlock's
source collection is [Standard Ebooks: Sherlock Holmes](https://standardebooks.org/collections/sherlock-holmes).

## World English Bible

`bible/` contains the 66-book Protestant canon (WEBP), in canonical order, from
eBible.org's chapter-level read-aloud archive. Files have no verse numbers;
readable book/chapter headings remain. The translation is dedicated to the
public domain; “World English Bible” remains an eBible.org trademark identifying
the unaltered text.

## Pickthall Quran

`quran/` contains Marmaduke Pickthall's English translation in canonical
114-surah order, extracted from Project Gutenberg ebook 16955. `P:` rows and
continuations remain; Yusuf Ali/Shakir rows, machine verse identifiers, and
the Gutenberg envelope are excluded. Gutenberg marks the source public domain
in the USA; that statement does not establish rights in every jurisdiction.

## Inaugural addresses

`inaugurals/` contains 57 US presidential inaugural addresses, Washington
(1789) through Obama (2013), split from Project Gutenberg ebook 4938. Contents,
separators, editorial envelope, two Obama press-release preambles, stage
directions, and press-release trailer are removed. Gutenberg marks the source
public domain in the USA.

## Darwin editions

`darwin-origin/` contains six English editions of On the Origin of Species
(1859–1872). Editions 1–2 use Gutenberg; 3–5 use Internet Archive OCR of Public
Domain Mark scans supplied by the Wellcome Library and Royal College of
Physicians of Edinburgh; edition 6 uses Standard Ebooks.

All retain their Introduction; editions 3–6 retain Darwin's Historical Sketch.
Structural headings are removed consistently. OCR page furniture, line
wrapping, and scan hyphenation are removed, with a fixed list of common OCR
word substitutions corrected in editions 3–5. These remain normalized
OCR-derived texts, not diplomatic scholarly transcriptions.

## Private corpora

`ASOIF/` contains five A Song of Ice and Fire volumes in publication order,
with UTF-8/LF text and normalized `.txt` filenames. POV headings use
`Chapter N. Name`; the fourth volume excludes its appendix and embedded preview
of the fifth. `lotr/` contains The Lord of the Rings trilogy in publication
order, retaining Book/Chapter headings with titles on Chapter lines.
These retained headings are source text; the current app does not recover or
analyze a chapter hierarchy.

Both corpora are copyrighted and have undocumented acquisition provenance.
They remain private-deployment resources; exclude them from a cleared public
artifact as described in the publication inventory.

## Common-word ranking

`other/wordlists/common_words.txt` is the locked 6,690-entry English ranking.
Its provenance is insufficient for public redistribution. The generated
`packages/core/src/ops/stoplist-en-data.ts` contains the first 2,000 entries
compatible with the default tokenizer. [The wordlist note](other/wordlists/README.md)
owns regeneration details; the derivative shares the source's private status.
