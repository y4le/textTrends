# Statistical methods — specification and test vectors

*Phase 0 method spec, implemented incrementally: a method is either **implemented**
(a pure function in `packages/core/src/stats/` with these worked examples as
executable fixtures) or **specified-only** (marked below; no export exists yet).
Nothing is exported without fixtures. Currently implemented: keyness (G², log-ratio),
logDice, PMI, t-score, DP/DPnorm, MATTR, MTLD. Specified-only: readability,
Delta/Cosine Delta, TF-IDF sections, bursts, trend, smoothing overlay. Every fixture
is hand-computed and numerically verified, so it is inspectable, not trusted from
memory; these numbers are the product's meaning, and any change is a contract change.
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

Display contract: rank by LR (effect), show G² (evidence), raw counts, and range;
optional Benjamini–Hochberg q-values never drive ranking.

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

**Test vector**: 3 equal parts, occurrences (9,0,0) → `DP = 0.5·(2/3+1/3+1/3) = 2/3`;
`DPnorm = (2/3)/(2/3) = 1.0` exactly.

**Test vector (even)**: 3 equal parts, occurrences (3,3,3) → `DP = 0`, `DPnorm = 0`.

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

## Readability (English pack only)

```
Flesch Reading Ease = 206.835 − 1.015·(words/sentences) − 84.6·(syllables/words)
Flesch–Kincaid grade = 0.39·(words/sentences) + 11.8·(syllables/words) − 15.59
ARI                  = 4.71·(chars/words) + 0.5·(words/sentences) − 21.43
```

Syllable counts are heuristic; the syllable function's error profile is part of the
fixture suite (a word list with hand-counted syllables and a tolerated error band).
ARI/Coleman–Liau (character-based) carry no syllable error and are preferred for
cross-document comparison.

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

## Chapter distinctiveness (TF-IDF labels, `tfidf-sections/1`)

```
w(term, section) = f_{t,s} · ln( N_sections / df_t )
```

Plain counts, natural log, no sublinear scaling — the variant is named in provenance.
Eligibility: sections with ≥ `minSectionTokens` (default 50) participate; `N_sections`
counts eligible sections only; `df_t` = eligible sections containing the term. Top-k
per section (default 5), ties broken by higher raw `f_{t,s}` then vocabulary key
order. Stop-list filtering applies (view layer) before ranking.

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

Per equal-token bin: `rate = count / binTokens × 10_000` (per-10k-tokens scale, the
app-wide default denominator; raw `count` and `binTokens` always accompany the rate in
results). Bins partition each document's lexical tokens per the selected
`TimeCoordinate`; the final bin of a document may be short and is reported with its
true `binTokens`, never padded. Occurrence de-duplication within a term group follows
the group's `countOverlaps` (overlap identity = covered-token union).

## Smoothing (overlay only — §8.7)

Default trend is the unsmoothed equal-token-bin rate. The overlay is a centered
rolling mean of bin values with window named in the UI and provenance; edges use
shrinking windows (no padding, no wraparound, never Fourier). LOESS may be added
later behind the same overlay contract.
