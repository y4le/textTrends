# Sample corpora

Default demo corpora for textTrends.

- `sherlock/` — the complete nine-volume Sherlock Holmes sequence (Doyle) in publication order.
  Public domain in the US. Sourced from the official release EPUBs in the
  Standard Ebooks Sherlock Holmes collection
  (`https://standardebooks.org/collections/sherlock-holmes`); body matter is
  serialized to UTF-8 plain text with the same `xhtml-block-collapse-v1`
  extraction used by app EPUB imports. Standard Ebooks releases its editorial
  work under CC0. Refresh with `pnpm update:sherlock-corpus`.
- `austen/` — Jane Austen's six novels in publication order, exposed as a
  built-in author corpus beside the Sherlock demo. Public domain in the US.
  Sourced from official Standard Ebooks release EPUBs; body matter is serialized
  to UTF-8 plain text with the same `xhtml-block-collapse-v1` extraction used by
  app EPUB imports. Standard Ebooks releases its editorial work under CC0.
  Refresh with `pnpm update:austen-corpus`.
- `standard-ebooks/` — the ten-book Classic Novels built-in demo, downloaded from
  official Standard Ebooks release EPUBs and serialized with the same
  `xhtml-block-collapse-v1` body-matter extraction as app imports. The updater
  replaces the source texts and integrity manifest together. Refresh with
  `pnpm update:supplemental-corpus`.
- `bible/` — the 66-book Protestant canon of the World English Bible (WEBP),
  assembled in canonical order from eBible.org's chapter-level read-aloud
  archive. The chapter files contain no verse numbers; only their readable
  book/chapter headings are retained. The translation is dedicated to the
  public domain; “World English Bible” remains an eBible.org trademark used to
  identify the unaltered text.
- `quran/` — Marmaduke Pickthall's English translation in canonical 114-surah
  order. It is extracted from Project Gutenberg ebook 16955: `P:` translation
  rows and their continuations are retained, while Yusuf Ali/Shakir rows,
  machine verse identifiers, and the Gutenberg envelope are removed. Project
  Gutenberg marks the source public domain in the USA; publication outside the
  USA must still follow the applicable jurisdiction.
- `political-arguments/` — seven public-domain works in original-publication
  order: *The Prince*, *The Wealth of Nations*, *The Federalist Papers*, *A
  Vindication of the Rights of Woman*, *The Communist Manifesto*, *On Liberty*,
  and *The Souls of Black Folk*. Each is extracted from an official Standard
  Ebooks release; Standard Ebooks editorial work is CC0.
- `shakespeare/` — 39 plays in approximate composition order, including the
  commonly attributed collaborations *Edward III* and *The Two Noble Kinsmen*.
  Composition dates and attribution are scholarly estimates, so the app treats
  the order as a useful analytical convention rather than a settled claim.
  Texts come from official Standard Ebooks releases and their CC0 editorial
  work.
- `inaugurals/` — 57 U.S. presidential inaugural addresses, Washington (1789)
  through Obama (2013), split from Project Gutenberg ebook 4938. The contents,
  separators, editorial envelope, two Obama press-release preambles, transcript
  stage directions, and press-release trailer are excluded. Project Gutenberg
  marks the source public domain in the USA.
- `darwin-origin/` — Darwin's six English editions of *On the Origin of
  Species* (1859–1872). Editions 1–2 come from Project Gutenberg; editions 3–5
  are normalized OCR from Public Domain Mark scans supplied to the Internet
  Archive by the Wellcome Library and Royal College of Physicians of Edinburgh;
  edition 6 comes from Standard Ebooks. All six retain the edition's
  Introduction, editions 3–6 retain Darwin's Historical Sketch, and structural
  headings are removed consistently. OCR page furniture, line wrapping, and
  scan hyphenation are removed; a fixed list of common OCR word substitutions
  is corrected in editions 3–5. Those editions remain normalized OCR-derived
  texts, not diplomatic scholarly transcriptions.
- Refresh any one of the seven demos above with
  `pnpm update:demo-corpora -- <bible|quran|political|shakespeare|inaugurals|darwin|classics>`,
  or omit the target to refresh all seven.
- `ASOIF/` — five A Song of Ice and Fire volumes in publication order. Private
  built-in demo; UTF-8/LF text with normalized `.txt` filenames. POV headings
  are serialized as `Chapter N. Name` so the conservative TXT structure scan
  can recover all 344 sections. The fourth volume ends with the novel itself;
  its appendix and embedded preview of the fifth volume are excluded.
- `lotr/` — The Lord of the Rings trilogy in publication order. Private built-in
  demo; UTF-8/LF text with normalized `.txt` filenames. Its existing Book and
  Chapter headings are retained, with chapter titles folded onto the Chapter
  lines so all 62 chapters have useful detected labels.
- The ASOIF and LOTR source texts are in copyright and intentionally available
  only in this private deployment. Exclude them from any future public build.
- `other/wordlists/common_words.txt` — the locked ranked English common-word
  source. It is intentionally not regenerated; see
  `docs/design/corpus-inventory.md` for its private-deployment status.
- The checked-in worker module takes the first 2,000
  default-tokenizer-compatible entries from the locked ranking. It lives at
  `packages/core/src/ops/stoplist-en-data.ts`; refresh it with
  `pnpm update:stoplist`.
