# Sample corpora

Default demo corpora for textTrends.

- `sherlock/` — the Sherlock Holmes sequence (Doyle), 6 volumes in publication order.
  Public domain in the US. Sourced from the official release EPUBs in the
  Standard Ebooks Sherlock Holmes collection
  (`https://standardebooks.org/collections/sherlock-holmes`); body matter is
  serialized to UTF-8 plain text with the same `xhtml-block-collapse-v1`
  extraction used by app EPUB imports. Standard Ebooks releases its editorial
  work under CC0. Refresh with `pnpm update:sherlock-corpus`.
- `austen/` — six Jane Austen novels as an author corpus (comparison/keyness demos).
  Public domain. Sourced from Project Gutenberg plain-text editions (IDs 1342,
  161, 158, 105, 121, 141) with Gutenberg boilerplate removed and line endings
  normalized; the texts themselves are unmodified.
- `standard-ebooks/` — ten supplemental public-domain novels downloaded from
  official Standard Ebooks release EPUBs and serialized with the same
  `xhtml-block-collapse-v1` body-matter extraction as app imports. They are
  retained for local comparisons; refresh them with
  `pnpm update:supplemental-corpus`.
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
