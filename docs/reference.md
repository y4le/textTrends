# Workbench reference

This reference describes the browser app. Package APIs and internal method
contracts are linked from the [design index](design/README.md).

## Places and reading surfaces

| Surface | Contents | Scope |
| --- | --- | --- |
| Inputs | Active order, local library, acquisition, full-text facts and term counts | Full active corpus |
| Trends | Term lines, dispersion, Company, reading destinations | Full corpus; linked-range overlays and inside/rest comparison |
| Matches | Continuous occurrence rows with source context | Full ready corpus in declared order |
| Vocabulary | Frequency, document frequency, dispersion, lexical diversity | Current analytical selection |
| Compare | Text or range comparisons, independent A/B rankings, divergence | Explicit disjoint sides |
| Read | Selectable extracted prose, fitted pages, query highlights | Full-corpus source navigation |
| Atlas | Whole-text extents and term evidence in adjacent columns | Multiple ready texts |
| Speed | Paced word frames from authenticated Read text | Current text; pauses at its end |

`?p=inputs|trends|matches|vocabulary|compare` selects a workbench place. Without
an explicit place, an empty workspace opens Inputs and an active corpus opens
Trends. Reader is a navigation layer, not another `p` value.

Allowlisted `?demo=` links replace the active corpus and notebook after source
acquisition and admission succeed; saved library bytes remain. The parameter
is removed before ordinary navigation and is consumed once. Sample buttons
use additive acquisition instead. Public sample slugs are `sherlock`, `austen`,
`bible`, `quran` (`koran`), `political` (`arguments`), `shakespeare`, `inaugurals`,
`darwin`, and `classics`. Private builds also contain `lotr` and `asoif`.

## Input formats

| Extension | Indexed text |
| --- | --- |
| `.txt` | Decoded source text |
| `.md`, `.markdown` | Literal Markdown source, including markup |
| `.html`, `.htm`, `.xhtml` | Plain reading text extracted from inert HTML |
| `.epub` | Selected reading-order body matter joined into one text |

PDF is unsupported. A file becomes one document; chapters and EPUB sections
do not become analytical subdivisions. TXT/Markdown/HTML decoding honors a
Unicode BOM, otherwise tries strict UTF-8 then Windows-1252. Malformed Unicode
and decoder replacement output are rejected. EPUB has its own XML/UTF-8
extraction path.

## Terms and Find

| Input | Meaning |
| --- | --- |
| `rain` | Whole indexed token, with folded matching by default |
| `heavy rain` | Adjacent indexed tokens within a sentence |
| `rain*` | Token prefix |
| `*ing` | Token suffix |
| `New Yo*` | Adjacent phrase with a prefix match on its final token |
| `Holmes, Sherlock Holmes` in Manage or Find | OR aliases within one term |
| `Holmes, Watson` in Add term quick entry | Two separate terms |

A wildcard is one `*` at one end of an alias; internal or two-ended wildcards
are rejected. Phrases follow tokenizer output, not literal source whitespace
or quotation syntax. Terms and Find do not accept regular expressions.
Exact matching uses normalized token keys; default folded matching also
ignores case and diacritics. Overlap counting is off by default: overlapping
alias hits are merged by covered-token union. Enabling it retains raw matches.

The notebook holds up to 64 groups, with five shown at once and up to 32 aliases
per group. A phrase has at most 16 indexed elements. Alias bodies and normalized
units are bounded to 256 UTF-16 code units.

Local-library search is literal. Vocabulary's default filter is a
case-insensitive literal substring of the vocabulary key; regex is an explicit,
case-sensitive RE2JS option. Unsupported regex syntax produces a recoverable
error and retains the last valid rows. These filters choose rows, not source
ranges.

Vocabulary and Compare can hide the top 0–2,000 entries of the English
common-word resource. Zero (off) is the default. Hiding rows does not change
surviving counts, denominators, scores, or Compare's whole-distribution
divergence.

## Settings and persistence

Settings has Display and, where applicable, This place. Display changes apply
immediately. Trends and Compare changes remain drafts until Apply; closing or
Escape discards unapplied changes. Vocabulary filters apply live.

| State | Lifetime |
| --- | --- |
| Source bytes, active corpus order/metadata, notebook, analysis-view settings | Browser-local library and one saved workspace |
| Theme, UI density, Reader/Atlas/Speed and layout preferences | Device-local preferences, separate from workspace |
| Reading cursor, linked range, Find, Reader scale, jump history, removal undo | Current session |
| Verified extracted text and indexes | Disposable browser cache |

Workspace saves are last-write-wins; there is no multi-tab merge model.
Unsupported pre-alpha workspace shapes recover with notice rather than migrate.
Healthy records can open around damaged library entries. The app has no
production result export, workspace backup, account, or synchronization UI.

Trends defaults to 40 bins per text, rates per 10,000 tokens, and no smoothing.
Equal gives separate texts equal width; To scale gives them a shared token
scale; Combined follows one concatenated corpus axis. Atlas has its own
Equal/To scale preference. UI density changes controls and row pitch, not
analytical encodings or Reader/Speed type size.

## Speed

| Control | Default | Accepted range |
| --- | ---: | --- |
| Pace | 300 WPM | 100–2,000; 25-WPM button/key step |
| Words at once | 1 | 1–3; compact presentation limits 3 to 2 without changing the saved choice |
| Frame character limit | 30 | 12–40 Unicode grapheme clusters, including spaces and punctuation |
| Sentence rest | 350 ms | 0–800 ms |
| Paragraph rest | 700 ms | 0–1,500 ms; at least the sentence rest |
| Length emphasis | 100% | 0–100% |

Words at once and the character limit are upper bounds; punctuation and source
boundaries can shorten a frame. One long word remains whole in frame data.
Even uses equal exposure and no rests; Natural uses the defaults above; Study
uses 500/900 ms rests and full length emphasis. Timing changes select Custom.
Reset restores Natural and 300 WPM while retaining frame preferences.

Pace includes rests within a fixed sentence-span budget, with at least 30 ms
per word. At 2,000 WPM rests are zero. Timer delays can lower actual throughput.
Speed is a focus-reading aid; the setting does not guarantee comprehension.

## Common keys

Focused controls and text editing take precedence. Help supplies the complete
contextual keyboard and gesture reference from the app's shortcut registry.

| Context | Keys | Action |
| --- | --- | --- |
| Global | `?`; Shift+D | Help; Debug |
| Workbench/Read | `/`; Ctrl/Cmd+F | Open Find |
| Find | `n` / `p`; Ctrl/Cmd+G / Ctrl/Cmd+Shift+G | Next / previous exact hit |
| Workbench/Read | Ctrl+O / Ctrl+I | Older / newer session reading position |
| Workbench | `gi`, `gt`, `gm`, `gv`, `gd` | Inputs, Trends, Matches, Vocabulary, Compare |
| Workbench | `gf`, `gq` | Focus reading footer / Terms |
| Read | `h` / `l`, Left / Right, PageUp / PageDown | Previous / next fitted page |
| Read/Atlas | `b` / `w`; `[` / `]` | Previous / next reference; previous / next text |
| Read/Atlas | Home / End | Active-text endpoints |
| Atlas | Left / Right; Up / Down; Enter | Adjacent text; position; open Read |
| Read | Shift+S | Enter Speed playing (paused under reduced motion) |
| Speed | Space; `h` / `l` | Play/pause; change pace |
| Speed | Shift+W | Pause and focus pace input |
| Speed | Escape; Shift+S | Return to Read at the displayed token |

Two-key sequences expire after 900 ms. Ctrl+O/I are Ctrl-only; Cmd+O/I keep
their platform meanings. Speed suppresses Find and prose-navigation keys.
Escape closes the active utility first; otherwise Speed exits to Read, Find
closes, or Reader returns through its normal Back action.

## Bounds

These are provisional product caps, not promises of performance at the cap.
A failed document can leave a partial, explicitly incomplete corpus usable.

| Resource | Bound |
| --- | ---: |
| Active documents | 256 |
| Source file | 32 MiB |
| Total project source bytes | 128 MiB |
| Extracted text per document | 32 × 1,024² UTF-16 units |
| Total project extracted text | 64 × 1,024² UTF-16 units |
| Inflated archive input per document | 128 MiB |
| Raw/emitted occurrences per term query | 200,000 (member-provenance cap also applies) |
| Exact dispersion per track | 50,000; above this, density uses up to 4,096 shared buckets |
| Matches window | 500 rows; the logical result can contain up to 1,000,000 |
| Compare retained display | First 50,000 ranks |
| Reading destinations | 12, with bounded excerpts |
| Reader source slice | 4,096 tokens, also subject to text and mark caps |

[Benchmark evidence](design/benchmarks.md) does not yet establish the formal
10M/50M-token tiers.
