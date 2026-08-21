# Statistical methods — specification and test vectors

*Phase 0 method spec, implemented incrementally: a method is either **implemented**
(a pure function in `packages/core/src/stats/` with these worked examples as
executable fixtures) or **specified-only** (marked below; no export exists yet).
Nothing is exported without fixtures. Currently implemented: keyness (G², log-ratio,
and a log-ratio confidence interval), Jensen–Shannon divergence, logDice, PMI,
t-score, DP/DPnorm, MATTR, MTLD, and the character-based readability indices
(ARI and Coleman–Liau). Specified-only: Delta/Cosine Delta, bursts, and the
syllable-based Flesch family. Every fixture is hand-computed and numerically
verified, so it is inspectable, not trusted from memory; these numbers are the
product's meaning, and any change is a contract change.
Each method carries an id + version (e.g. `keyness-g2-2x2/1`) referenced by QueryOps
and provenance.*

Notation: `ln` natural log, `log2` binary log. All counts are raw integers from the
positional index; all rates use explicitly named denominators.

## Keyness

### Log-likelihood G² (evidence)

For term frequency `a` in corpus A (size `N1` tokens) vs `b` in corpus B (size `N2`),
the **full 2×2 likelihood-ratio statistic** over all four cells (term/non-term ×
corpus), with `E1 = N1·(a+b)/(N1+N2)`, `E2 = N2·(a+b)/(N1+N2)`:

```
G² = 2 · ( a·ln(a/E1) + b·ln(b/E2)
         + (N1−a)·ln((N1−a)/(N1−E1)) + (N2−b)·ln((N2−b)/(N2−E2)) )
// cells with zero observed count contribute 0
```

Signed by direction: positive when `a/N1 > b/N2`. Note: this is the complete 2×2 G²
(Dunning 1993), **not** the two-cell Rayson–Garside shorthand, which understates the
statistic (12.7806 vs 12.8349 on the vector below) — caught in contract review.

**Test vector**: `a=10, N1=1000, b=2, N2=2000` → `E1=4, E2=8` → `G² = 12.8349`
(±1e-3), sign positive.

### Log-ratio (effect size)

With 0.5 continuity correction added to all four cells (so each corpus's adjusted
total is `N+1`):

```
LR = log2( ((a+0.5)/(N1+1)) / ((b+0.5)/(N2+1)) )
```

**Test vector**: same inputs → `LR = log2( (10.5/1001)/(2.5/2001) ) = 3.0697` (±1e-3).

Display contract: rank by LR (effect) by default, with the lower 95% bound as
an optional precision-aware sort; show G² (evidence), raw counts, and range.
Optional Benjamini–Hochberg q-values never drive ranking.

Compare and Vocabulary may apply the versioned `english-common-words/1`
common-word row filter. The resource contains the first 2,000 matchable lexical
types from the locked 6,690-entry English common-word ranking. Entries are
NFC-normalized, apostrophe-normalized, and lowercased under English.
A selected top-N prefix removes matching rows before ranking and paging. It does
not remove tokens from the selection: counts, rates, dispersion, log ratio, G²,
confidence intervals, and Jensen–Shannon divergence keep their unfiltered
denominators and values.

### Log-ratio confidence interval

A Wald interval on the same corrected quantity. The variance is the standard
log-risk-ratio form carrying the same 0.5/1 correction, so the point estimate and
interval describe one estimand:

```
Var(ln ratio) = 1/(a+0.5) − 1/(N1+1) + 1/(b+0.5) − 1/(N2+1)
CI         = LR ± z · sqrt(Var) / ln(2)          // z = 1.959963984540054 at 95%
```

Each pair is non-negative because `a ≤ N1` forces `a+0.5 < N1+1`, so the variance
cannot go negative on a valid table.

**Test vector**: `a=10, N1=1000, b=2, N2=2000` → `CI = (1.0828, 5.0565)` (±1e-3).

**Discrimination vector** (the reason the interval exists — effect size alone
cannot separate these): `a=3, N1=1000, b=0, N2=1000` → `LR = 2.807`, interval
`(−1.466, 7.080)` spans zero; `a=3000, N1=100000, b=200, N2=100000` →
`LR = 3.904`, interval `(3.698, 4.109)`.

Display contract: the interval is a **per-term** precision statement carrying no
multiplicity correction. It is shown in a term's expanded detail, and it
never becomes a table-wide filter — keeping only the terms whose intervals
exclude zero is precisely the selection effect a correction would exist for.
The Wald model also treats token draws as independent. Running-text burstiness
violates that assumption and can make the interval too narrow; the per-side DP
values help expose concentration but do not repair the interval.

### Row dispersion inside `keyness-g2-2x2/1`

Keyness rows carry Gries' DP (see §Dispersion) per side, folded over the same
sparse per-document vectors in one extra pass — no dense type×document matrix.
Parts are that side's selected documents.

**Deviation from `dispersion-dp/1`**: where that method publishes `DP = 0` below
two positive-token parts, a keyness row publishes **null**. A row column showing
"0" would read as "perfectly even" for a measurement that is undefined — a
single-document side has no between-document proportions to deviate. Null is
also published for a term absent from that side. `KeynessSideTotalsV1.positiveParts`
carries the part count the decision was made on.

## Distributional divergence

### Jensen–Shannon divergence (`jsd-log2/1`)

Over two relative-frequency distributions `p`, `q` on a shared type space, with
`m = (p+q)/2`:

```
JSD = 0.5 · ( Σ pᵢ·log2(pᵢ/mᵢ) + Σ qᵢ·log2(qᵢ/mᵢ) )      // 0 ≤ JSD ≤ 1
// a zero share contributes 0 (the x·log(x/m) limit as x → 0)
```

Base-2 logs bound it in [0, 1] bits. Unlike KL it is symmetric and stays finite
when a type is absent from one side, so a two-selection comparison needs neither
smoothing nor a reference corpus.

**Test vectors**: identical distributions → `0`; disjoint (`[1,0]` vs `[0,1]`) →
`1` exactly; half-shared (`[0.5,0.5,0]` vs `[0,0.5,0.5]`) → `0.5` exactly;
`[0.9,0.1]` vs `[0.1,0.9]` → `0.5310` (±1e-4).

Computed inside the keyness merge over **every** merged type, before the count
filter, before side projection, and before paging — so it describes the two
distributions and not the visible table. It is published with the type count it
summed over, because the number is meaningless apart from its domain.

## Collocation

### Event space (`collocates/1`) — unit-based

Round-2 review correctly showed that *no* pair-based counting can respect Dice's
bound (one node with two in-window collocates gives `fxy=2, fx=1, fy=2` →
`2fxy/(fx+fy) = 4/3 > 1`). Dice-family scores require a **unit event space**, so:

- The counting unit is the **sentence** (within the bound selection; sentences are
  index-canonical). `fx` = units containing the node, `fy` = units containing the
  collocate, `fxy` = units containing both, `n` = total units. By construction
  `fxy ≤ min(fx, fy)` and every score below is well-defined and bounded.
- Multi-token (phrase) nodes: a unit contains the node iff a full phrase match lies
  within it.
- Self-collocation (`y` = a node type) is excluded — `fxy` would equal `fx` by
  definition and carry no information in unit space.
- The **L5…R5 positional profile** is a separate *descriptive* output computed from
  token offsets around each node occurrence (clipped at sentence/document bounds);
  it decorates the ranked table but plays no role in association scores.
- Filters: minimum `fxy` (default 3) and minimum `fy` (default 5); op parameters,
  echoed in provenance. Ranking ties break by higher `fxy`, then vocabulary key
  order (deterministic).
- A token-window *proximity* method may arrive later as `collocates-window/1` with
  its own coherent event space; it does not retrofit onto these scores.

### log-Dice (default association score)

```
logDice = 14 + log2( 2·fxy / (fx + fy) )     // ≤ 14, guaranteed by fxy ≤ min(fx,fy);
                                             // implementations REJECT fxy > min(fx,fy)
```

**Test vector**: `fxy=5, fx=20, fy=30` → `14 + log2(0.2) = 11.678` (±1e-3).
**Bound vector**: `fxy=10, fx=10, fy=10` → exactly `14`.

### PMI and t-score (secondary; MI's rare-pair attraction is labeled in the UI)

```
PMI = log2( fxy·n / (fx·fy) )
t   = ( fxy − fx·fy/n ) / √fxy
```

**Test vectors** (`fxy=4, fx=10, fy=20, n=1000`): `PMI = log2(20) = 4.3219` (±1e-3);
`t = (4 − 0.2)/2 = 1.9000` (±1e-4).

## Dispersion

### Gries' DP and DPnorm

Corpus divided into `n` parts with token-share proportions `s_i` (Σs=1); the term's
occurrence proportions `v_i` (Σv=1, over its own total):

```
DP     = 0.5 · Σ |v_i − s_i|                 // 0 = perfectly even, →1 clumped
DPnorm = DP / (1 − min(s_i))
```

Parts are the selected documents, including a document whose class-filtered
token share is zero. Such a part therefore contributes `s_i = 0` to the
published `min(s_i)` denominator even though it cannot contain an occurrence.
Below two positive-token parts, `DP = 0` and `DPnorm = null`.

**Test vector**: 3 equal parts, occurrences (9,0,0) → `DP = 0.5·(2/3+1/3+1/3) = 2/3`;
`DPnorm = (2/3)/(2/3) = 1.0` exactly.

**Test vector (even)**: 3 equal parts, occurrences (3,3,3) → `DP = 0`, `DPnorm = 0`.

**Zero-token-part vector**: selected part sizes `(2,1,0)`, occurrences for one
term `(2,0,0)` → `DP = 1/3`; because `min(s_i)=0`, `DPnorm = 1/3`.

## Lexical diversity

### MATTR (default; window default 500 tokens)

Mean of TTR over every sliding window of size `w` (step 1); documents shorter than `w`
report plain TTR labeled as such.

**Test vector**: tokens `a b a b`, `w=3` → windows `aba` (TTR 2/3), `bab` (2/3) →
`MATTR = 2/3` exactly.

### MTLD (secondary)

Sequential factor count, threshold 0.72 (McCarthy & Jarvis 2010): scan left→right
tracking running TTR; each time TTR drops below 0.72, count one factor and reset. The
final partial factor contributes `(1 − TTR_end)/(1 − 0.72)` fractionally.
`MTLD_fwd = N / factors`; report the mean of forward and backward passes.
**Zero-factor rule**: if a pass completes zero factors (TTR never crossed the
threshold and the final partial contributes 0 because TTR = 1), the pass's value is
defined as `N`. Threshold must lie in (0, 1); implementations reject anything else.
Test fixtures: constructed sequences with hand-counted factors — `a b c d` → 4
(zero-factor rule, both passes); `a a a a` → 2 (two exact factors per pass).

## Readability

### Character-based (`readability-chars/1`, implemented)

```
ARI          = 4.71·(characters/words) + 0.5·(words/sentences) − 21.43
Coleman–Liau = 0.0588·L − 0.296·S − 15.8      // L = letters per 100 words,
                                              // S = sentences per 100 words
```

This version pins the character conventions rather than inheriting a library's
ambiguous “character” counter. ARI `characters` are Unicode letters and decimal
digits; Coleman–Liau `letters` are Unicode letters only. Both are counted as
Unicode scalar values in normalized emitted token keys, excluding punctuation,
separators, and UTF-16 encoding width. `inventory/1` publishes the two quantities
as `readabilityCharacters` and `readabilityLetters`. Its sibling `charsUtf16`
sums the source-span extent of each contiguous selected run; those spans include
separators and cannot feed either formula. This convention is part of method
version `readability-chars/1` because public ARI implementations disagree about
punctuation.

Both are US grade levels calibrated on expository prose; neither is meaningful on
a handful of sentences, so callers publish them beside the sentence count.
ARI requires at least one counted letter or digit per indexed token. Coleman–Liau
allows fewer letters than tokens because numeral tokens legitimately add words
without adding letters.

**Test vector**: `characters=500, letters=500, words=100, sentences=10` →
`ARI = 7.12`, `Coleman–Liau = 10.64` (±1e-6).

### Syllable-based (specified-only, English pack)

```
Flesch Reading Ease = 206.835 − 1.015·(words/sentences) − 84.6·(syllables/words)
Flesch–Kincaid grade = 0.39·(words/sentences) + 11.8·(syllables/words) − 15.59
```

Deliberately not implemented. Syllable counts are heuristic and would need a
language pack plus an error profile in the fixture suite (a word list with
hand-counted syllables and a tolerated error band). The character-based indices
above carry no syllable error and are preferred for cross-document comparison.

## Stylometry

### Burrows' Delta / Cosine Delta

Over the corpus's `k` most frequent words (default k=150): per-document relative
frequencies `f`, corpus mean `μ_i` and standard deviation `σ_i` per word;
z-scores `z_i = (f_i − μ_i)/σ_i`.

```
Delta(A,B)       = (1/k) · Σ |z_A,i − z_B,i|
CosineDelta(A,B) = 1 − (z_A·z_B)/(‖z_A‖·‖z_B‖)     // Evert et al. 2017: most robust
```

Test fixtures: 3 tiny synthetic "documents" with hand-computed z-scores in the fixture.

## Burst detection (Poisson surprise, `bursts-poisson/1`)

For a term with baseline rate `λ` per token computed over the bound selection,
observed `k` occurrences in a sliding window of `w` tokens (default 2000, step `w/2`,
clipped at document boundaries; expected `λw`):

```
surprise = −log10 P(X ≥ k),  X ~ Poisson(λw)
```

Windows above the surprise threshold (default 4.0, an op parameter) become "notable
moment" annotations; overlapping qualifying windows merge into one annotated span
with the max surprise.

Numerical contract (round-2 review): the survival probability is computed **in log
space** — iterate `logPMF(i+1) = logPMF(i) + ln(μ) − ln(i+1)` from `logPMF(0) = −μ`
and accumulate the upper tail with log-sum-exp; never multiply raw PMF terms (they
underflow for realistic `μ = λw`). Required fixtures: `μ=0` (surprise ∞ for k>0, 0
for k=0), large `μ` (e.g. 5000) with `k` near `μ` (surprise ≈ 0.3–0.5 band), far
tails (no overflow/NaN), and `k=0` (surprise 0).

## Trend rates (`trend/1`)

Per equal-token bin: `rate = count / binTokens × 10_000` (the canonical app-wide
denominator; raw `count` and `binTokens` always accompany the rate in
results). Bins partition each document's lexical tokens per the selected
`TimeCoordinate`; the final bin of a document may be short and is reported with its
true `binTokens`, never padded. Occurrence de-duplication within a term group follows
the group's `countOverlaps` (overlap identity = covered-token union).

The Trends range comparison derives two sides from the resident baseline and
ranged trend lanes. Selected trends contain only touched documents, so results
are joined by document id before summing—not by parallel row index. For each
tracked term:

```
insideCount  = Σ selected count rows
insideTokens = Σ selected binTokens
outsideCount = Σ baseline count rows − insideCount
outsideTokens= Σ baseline binTokens − insideTokens
```

Rates on both sides use the formula above. Direction uses the bounded observed
rate contrast `rate-contrast/1`:

```
C = (rateInside − rateOutside) / (rateInside + rateOutside)   // −1…+1
```

This is the monotone transform `(r−1)/(r+1) = tanh(ln(r)/2)` of the raw rate
ratio, so its sign always agrees with the two printed rates. One-sided zeroes
land honestly at the endpoints. A 21-token range with no occurrences against
8 occurrences in the remaining 1,923 tokens gives rates 0 and 41.6 per 10,000
and `C=−1`, toward the rest. A continuity-corrected log ratio would point the
other way on this vector because its 0.5 pseudo-count implies 227.3 per 10,000
inside; that estimand is deliberately not used for this observed-direction
display.

Mark weight is a coarse evidence channel. With pooled rate
`p=(insideCount+outsideCount)/(insideTokens+outsideTokens)`, the mark is solid
when `min(p·insideTokens, p·outsideTokens) ≥ 5` and a hairline otherwise. The
example above has a minimum expected count of `8/1944·21 = 0.0864`, so its
full-left mark is thin. Direction is undefined when the range leaves no
remainder or the term occurs nowhere. Overlap-counted groups remain valid
because a rate contrast does not require occurrence count to be at most the
token denominator.

Matches are admitted to a range only when fully contained in it. A multi-token
match crossing a range edge therefore remains outside while the denominator is
split at the edge; this can bias short-range phrase rates against the inside.

## Company proximity (`company/1`)

Company is exact descriptive evidence over two through five tracked term
groups and the canonical full-ready corpus. An occurrence with start `p` and
span `s` occupies the half-open interval `[p, p+s)`. For every unordered pair,
the method performs both directional questions: for each A occurrence, how far
is the nearest B interval in the same document, and independently for each B
occurrence, how far is the nearest A interval? Proper overlap has gap zero;
touching intervals also enter the zero-gap bucket but are excluded from the
separate overlap count. If the peer has no occurrence in that document, the
source occurrence increments `none` instead of a histogram bucket.

The fixed lower edges are:

```text
0, 1, 2, 3, 4, 5, 7, 10, 15, 25, 50, 100, 200
```

Each bucket is `[edge_i, edge_(i+1))`; the final bucket is `[200, infinity)`.
The Company panel's “nearby” value is therefore exactly the sum of buckets
whose lower edge is below 25, divided by that direction's complete occurrence
total (including same-document-absent occurrences). The two directions remain
separate. Pair ordering uses the smaller directional coverage, then the number
of documents containing both tracks, then canonical identity. This is not an
association score, expected count, significance test, or causal claim.

**Integer fixture**: documents have 30 and 20 tokens. A occurs at
`d0:[0,2)`, `d0:[10,11)`, and `d1:[5,6)`; B occurs at `d0:[2,3)` and
`d0:[8,12)`. A→B has bucket zero `2`, `none=1`, `forward=1`, and `overlap=1`.
B→A has bucket zero `2`, `none=0`, `backward=1`, and `overlap=1`.
`docsWithBoth=1`; displayed directional nearby coverage is `2/3` for A and
`2/2` for B. This fixture pins touching, proper overlap, asymmetric
denominators, and the no-peer document path.

## Reading Destinations (`destinations/1`)

Destinations is a deterministic reading heuristic over one through five
tracked groups and the canonical full-ready corpus. Each distinct occurrence
start can anchor a centered, document-clamped window of
`min(400, documentTokens)` tokens. Counts use occurrence starts inside that
half-open window. Let `n_t` be track `t`'s full-corpus occurrence total,
`Rmax = max_t(n_t)`, and `c_t` its count in the window. Integer weights and the
window score are:

```text
W_t    = min(16·65536, floor(65536·Rmax / max(n_t, 1)))
root_t = floor(sqrt(65536·min(c_t, 4096)))
score  = presentTracks · Σ_t(W_t · root_t)
```

Thus a one-term score is monotone in its count, while multiple-term breadth,
bounded rarity, and diminishing returns can elevate a common-plus-rare
passage. A pair focus is strict: both focused track counts must be positive
before a candidate can survive. An empty result is meaningful.

Nearby anchors collapse to deterministic runs, at most eight numeric
candidates survive per document, and the final pass consumes candidate depths
breadth-first across documents. It applies a derived per-document quota,
suppresses overlapping windows in the same document, and returns at most
twelve. This greedy ordering serves an independently consumed reading list; it
is deliberately not weighted-interval DP or a maximum-coverage set. The exact
winning occurrence is retained as the Reader anchor. Materialization touches
only winners and bounds each excerpt to 48 tokens, 400 UTF-16 units, 512 UTF-8
bytes, and 16 marks.

**Integer fixture**: one 300-token document has one track at starts 10, 20,
30, and 40. `Rmax=n_0=4`, so `W_0=65536`, `root_0=floor(sqrt(65536·4))=512`,
`presentTracks=1`, and the sole clamped window scores exactly `33,554,432`
with counts `[4]`. A separate strict-focus fixture places one track at token
100 and another at 2,800 in a 3,000-token document; no 400-token window can
contain both, so the result is exactly empty.

## Smoothing (overlay only)

Default trend is the unsmoothed equal-token-bin rate. The overlay is a centered
rolling mean of bin values with window named in the UI and provenance; edges use
shrinking windows (no padding, no wraparound, never Fourier). LOESS may be added
later behind the same overlay contract.
