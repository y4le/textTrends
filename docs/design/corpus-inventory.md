# Corpus inventory — publication-rights decision record (roadmap Track P1)

Prepared for the owner's pre-publication decision. The pass-2 ruling: block
the public repository cut on this inventory; anything without a documented
redistribution basis is removed, and because these are TRACKED files the
strategy must cover git HISTORY — either a one-time rewrite at branch freeze
or a clean public export whose history never carried them. Decide now,
execute exactly once at the freeze.

| Path | Size | Content | Source | Rights basis | Redistributable? | Recommendation |
|---|---:|---|---|---|---|---|
| `text/sherlock/` | 2.5M | 6 Doyle volumes, publication order | Official Standard Ebooks release EPUBs; body matter serialized to UTF-8 plain text with the app's `xhtml-block-collapse-v1` extractor | Public domain (US); Standard Ebooks editorial work is CC0 | **Yes** — keep source and rights note | Keep; preserve the Standard Ebooks source note in `text/README.md` and future notices |
| `text/austen/` | 4.0M | 6 Austen novels (author-corpus demos) | Project Gutenberg etexts 1342, 161, 158, 105, 121, 141; same treatment | Public domain | **Yes** | Keep; same notice |
| `text/ASOIF/` | 9.2M | A Song of Ice and Fire full texts; private built-in demo | Undocumented | **In copyright** (G.R.R. Martin, 1996–2011) | **Private deployment only** | Keep in the private build; exclude before publication via the history/export strategy |
| `text/lotr/` | 2.5M | The Lord of the Rings full texts; private built-in demo | Undocumented | **In copyright** (Tolkien estate) | **Private deployment only** | Keep in the private build; exclude before publication via the history/export strategy |
| `text/other/common_word_list.txt` | 954 B | Common-word list | **Unrecorded** | Unknown — word-frequency lists vary from uncopyrightable facts to licensed databases depending on origin | Unknown | Owner: identify the origin. If it cannot be established, regenerate one from the public-domain corpora (trivially derivable) and document that |

## Decisions the owner must make (nothing below is executed yet)

1. **History strategy** — pick one:
   - (a) One-time `git filter-repo` (or equivalent) at the publication freeze
     removing `text/ASOIF/`, `text/lotr/`, and (if unresolvable)
     `text/other/common_word_list.txt` from all history. Destructive;
     coordinate any clones; do exactly once.
   - (b) Clean public export: publish a fresh repository whose initial commit
     is the freeze state minus the removed paths; the private repo keeps its
     history. Zero rewrite risk; loses public history continuity.
2. **`common_word_list.txt` origin** — identify, replace, or remove.
3. **Working-tree removal timing** — the private app intentionally ships these
   corpora as demos. Remove or exclude them when producing a public artifact;
   the history question is independent and governed by decision 1.

## Facts relevant to risk

- The private deployed app exposes `text/sherlock/`, `text/ASOIF/`, and
  `text/lotr/` through public-corpus symlinks. A future public artifact must
  exclude the two copyrighted symlinks and their targets.
- The two copyrighted corpora were INTRODUCED by commit `935e3ee`
  (2015-11-25, "cleaning up / readying for gh pages") — a decade of history
  carries them, which is distinct from (and much older than) the 2026-07-19
  owner RETENTION decision recorded in `text/README.md`. Tip-removal alone
  cannot clean a published history, and a rewrite would touch ten years of
  commits — which weighs toward the clean-export option in decision 1.
- No license file exists at the repo root yet (roadmap P3 adds LICENSE +
  notices once decision 1 is made).
