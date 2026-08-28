# Corpus inventory — publication-rights decision record (roadmap Track P1)

Prepared for the owner's pre-publication decision. The pass-2 ruling: block
the public repository cut on this inventory; anything without a documented
redistribution basis is removed, and because these are TRACKED files the
strategy must cover git HISTORY — either a one-time rewrite at branch freeze
or a clean public export whose history never carried them. Decide now,
execute exactly once at the freeze.

| Path                                         |           Size | Content                                                  | Source                                                                                                                                | Rights basis                                                       | Redistributable?                      | Recommendation                                                                                           |
|----------------------------------------------|---------------:|----------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|---------------------------------------|----------------------------------------------------------------------------------------------------------|
| `text/sherlock/`                             |           3.5M | Complete 9-volume Doyle sequence, publication order       | Official Standard Ebooks release EPUBs; body matter serialized to UTF-8 plain text with the app's `xhtml-block-collapse-v1` extractor | Public domain (US); Standard Ebooks editorial work is CC0          | **Yes** — keep source and rights note | Keep; preserve the Standard Ebooks source note in `text/README.md` and future notices                    |
| `text/austen/`                               |           4.0M | 6 Austen novels, publication order (built-in demo)       | Official Standard Ebooks release EPUBs; body matter serialized with the app's `xhtml-block-collapse-v1` extractor                      | Public domain (US); Standard Ebooks editorial work is CC0          | **Yes** — keep source and rights note | Keep; preserve the Standard Ebooks source note in `text/README.md`; refresh with `pnpm update:austen-corpus`                              |
| `text/standard-ebooks/`                      |           7.5M | 10-book Classic Novels built-in demo                    | Official Standard Ebooks release EPUBs; body matter serialized with the app's `xhtml-block-collapse-v1` extractor                      | Public domain (US); Standard Ebooks editorial work is CC0          | **Yes** — keep source and rights note | Keep; refresh with `pnpm update:supplemental-corpus`                                                      |
| `text/bible/`                                |           4.1M | World English Bible, 66 canonical books                 | eBible.org WEBP chapter-level read-aloud release, joined by book and serialized as UTF-8/LF                                             | Translation dedicated to public domain; identifying title is an eBible.org trademark | **Yes** — keep source, edition, and trademark note | Keep; refresh with `pnpm update:demo-corpora -- bible`                                    |
| `text/quran/`                                |           1.1M | Pickthall English translation, 114 canonical surahs     | Pickthall `P:` rows extracted from Project Gutenberg ebook 16955; other translations, verse ids, and envelope removed                  | Project Gutenberg marks source public domain in USA               | **Yes in USA** — jurisdiction check remains | Keep; name the translator everywhere; refresh with `pnpm update:demo-corpora -- quran`                  |
| `text/political-arguments/`                  |           4.6M | 7 political/economic works, 1532–1903                   | Official Standard Ebooks release EPUBs; body matter serialized with `xhtml-block-collapse-v1`                                          | Public domain (US); Standard Ebooks editorial work is CC0          | **Yes** — keep source and rights note | Keep; refresh with `pnpm update:demo-corpora -- political`                                                 |
| `text/shakespeare/`                          |           5.0M | 39 plays, approximate composition order                 | Official Standard Ebooks release EPUBs; body matter serialized with `xhtml-block-collapse-v1`                                          | Public domain (US); Standard Ebooks editorial work is CC0          | **Yes** — keep source and ordering caveat | Keep; refresh with `pnpm update:demo-corpora -- shakespeare`                                            |
| `text/inaugurals/`                           |         880K | 57 U.S. presidential inaugural addresses, 1789–2013     | Speeches split from Project Gutenberg ebook 4938; collection envelope, editorial preambles, stage directions, and press trailer removed | Project Gutenberg marks source public domain in USA               | **Yes in USA** — keep source note     | Keep; refresh with `pnpm update:demo-corpora -- inaugurals`                                                |
| `text/darwin-origin/`                        |           5.9M | 6 English editions of *Origin*, 1859–1872               | Gutenberg editions 1–2; IA OCR editions 3–5 with disclosed fixed word corrections; Standard Ebooks edition 6; front matter aligned     | Underlying books public domain; IA scans carry Public Domain Mark; SE editorial work CC0 | **Yes** — disclose OCR derivation | Keep; refresh with `pnpm update:demo-corpora -- darwin`                                                    |
| `text/ASOIF/`                                |           9.2M | A Song of Ice and Fire full texts; private built-in demo | Undocumented                                                                                                                          | **In copyright** (G.R.R. Martin, 1996–2011)                        | **Private deployment only**           | Keep in the private build; exclude before publication via the history/export strategy                    |
| `text/lotr/`                                 |           2.5M | The Lord of the Rings full texts; private built-in demo  | Undocumented                                                                                                                          | **In copyright** (Tolkien estate)                                  | **Private deployment only**           | Keep in the private build; exclude before publication via the history/export strategy                    |
| `text/other/wordlists/common_words.txt`      |      Locked, 50K | 6,690-entry common-word ranking                         | Locked private reference; no repository regeneration path                                                                             | Provenance insufficient for public redistribution                  | **Private deployment only**           | Keep in the private build                                                                                 |
| `packages/core/src/ops/stoplist-en-data.ts`  |      Generated | Ranked 2,000-type common-word reference                  | First 2,000 default-tokenizer-compatible entries from the ranking above                                                               | Same as ranked source                                              | **Private deployment only**           | Keep in the private build                                                                                 |

## Decisions the owner must make (nothing below is executed yet)

1. **History strategy** — pick one:
   - (a) One-time `git filter-repo` (or equivalent) at the publication freeze
     removing `text/ASOIF/`, `text/lotr/`,
     `text/other/wordlists/common_words.txt`, and its generated derivative
     `packages/core/src/ops/stoplist-en-data.ts`. Destructive; coordinate any
     clones; do exactly once. The public build must also disable or replace
     code and tests that import those paths.
   - (b) Clean public export: publish a fresh repository whose initial commit
     is the freeze state minus the removed paths; the private repo keeps its
     history. Zero rewrite risk; loses public history continuity.
2. **Working-tree removal timing** — the private app intentionally ships the
   restricted corpora and common-word resource. Remove or exclude every
   private-only row above, including generated derivatives, when producing a
   public artifact; the history question is independent and governed by
   decision 1.

## Facts relevant to risk

- The deployed app exposes the public demo rows above plus `text/ASOIF/` and
  `text/lotr/` through public-corpus symlinks. A future
  public artifact must exclude the two copyrighted symlinks and their targets.
- The two copyrighted corpora were INTRODUCED by commit `935e3ee`
  (2015-11-25, "cleaning up / readying for gh pages") — a decade of history
  carries them, which is distinct from (and much older than) the 2026-07-19
  owner RETENTION decision recorded in `text/README.md`. Tip-removal alone
  cannot clean a published history, and a rewrite would touch ten years of
  commits — which weighs toward the clean-export option in decision 1.
- No license file exists at the repo root yet (roadmap P3 adds LICENSE +
  notices once decision 1 is made).
