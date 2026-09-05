# Interpret the measurements

textTrends connects measurements to positions in extracted text. A chart can
suggest where to read; the source passage provides the evidence for what is
being said.

## Position and scope

The corpus is an ordered sequence of texts. A token is an indexed word-like
unit; punctuation and source characters still appear in Reader, but positions
follow the tokenizer. A position means a place in canonical extracted text,
not a printed page, chapter, or inferred narrative division. Document order
therefore affects the corpus axis without changing the words in each text.

Analytical scope and reading position answer different questions. Selecting a
range asks about those tokens. Moving the cursor asks to read at a position.
A range can change Vocabulary and comparison overlays while Matches, Reader,
and exact reference stepping still cover the full corpus. Inputs keeps stable
full-text facts so a range cannot make a text appear to have changed length.

## Counts, rates, and trends

A count measures occurrences; a rate divides that count by the number of tokens
and multiplies by 10,000. Ten occurrences in 1,000 tokens is 100 per 10,000;
ten in 10,000 is 10 per 10,000. Counts describe volume; rates make unequal
text lengths comparable.

Trend bins partition token positions. Short bins use their actual denominator.
Smoothing averages neighboring bin values for presentation; it never crosses
text boundaries and does not change occurrence totals. Changing bin size can
change the apparent shape, so use the source and exact counts when interpreting
a peak.

Exact dispersion marks retain occurrence positions. Above the transport
threshold, density bands retain counts within intervals. A density band can
open a representative position; it cannot identify one exact occurrence.
Atlas can also compress exact marks into device pixels. A compressed pixel
does not acquire more navigational precision than it displays.

## Vocabulary and dispersion

Frequency describes how often a type appears. Document frequency counts the
selected texts containing it. Gries' DP compares a term's distribution with
the texts' token shares: zero means proportional distribution, while larger
values indicate concentration. A missing DP value in Compare means there is
insufficient between-text evidence or the term is absent on that side;
it does not mean even distribution.

Type-token ratio depends strongly on text length. MATTR averages that ratio
across fixed sliding windows; short texts use a labeled TTR fallback. Neither
measure establishes writing quality. Vocabulary's text and common-word filters
hide rows while retaining the underlying measurement denominators.

## Comparison

Compare uses explicit disjoint A/B token selections. A selected passage can be
compared with its exact corpus complement. The two result columns rank terms
independently; terms sharing a row are not a matched pair.

Log ratio is a base-2 relative-frequency effect size with a small continuity
correction for zero counts. A value of +1 means twice the corrected rate on A;
−1 means half. G² measures evidence against equal rates using the full 2×2
term/non-term table. A large effect and strong evidence are different facts.

The 95% interval describes per-term precision under an independent-token
model. Running prose is bursty, so it can be narrower than the text warrants.
It is not corrected for examining many terms; filtering a table to intervals
that exclude zero does not create a valid multiple-testing procedure.
Per-side dispersion helps reveal concentration but does not repair that model.

Jensen–Shannon divergence summarizes the complete compared vocabulary
distributions, from 0 for identical to 1 for disjoint. It is calculated before
row filtering and paging. It is not a summary of only the visible rankings.

Trends' inside/rest indicator has a different job: its direction follows the
observed rates, using `(inside − outside) / (inside + outside)`. A small range
with zero hits stays on the rest side; it does not inherit Compare's
continuity-corrected effect. Phrase matches must fit entirely within a range,
so a match crossing its edge contributes outside while tokens split at the
edge. Interpret very short phrase ranges with that boundary effect in mind.

## Company and reading destinations

Company measures each occurrence's nearest peer in the same text. Its two
directions have separate denominators: all A occurrences can be near B while
many B occurrences have no nearby A. “Nearby” means a span gap below 25 tokens.
The display is descriptive proximity, not statistical association or causation.

Reading Destinations ranks bounded windows using term breadth, rarity, and
diminishing returns for repeated hits. Choosing a Company pair requires both
terms in a destination and can produce an empty result. The list is a reading
heuristic, not a significance test or a claim that omitted passages lack value.

## Local processing and reproducibility

Imported bytes, extracted text, indexes, queries, and saved research remain in
the browser. Loading prepared samples or Standard Ebooks titles acquires new
source material over the network; it does not send imported books for analysis.

Source bytes and versioned extraction/index recipes identify the text and token
geometry used by a result. Different editions, OCR corrections, tokenization,
or corpus order can change that result. Consult [corpus provenance](../text/README.md)
for prepared texts and [method contracts](design/statistics.md) for formulas
and fixtures. Browser-local storage provides continuity on one device, not
backup or multi-tab conflict resolution.
