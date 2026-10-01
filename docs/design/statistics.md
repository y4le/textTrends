# Statistical methods

This is the formula and fixture reference for implemented kernels and query
methods. `packages/core/src/stats/`, `packages/core/src/ops/`, and their tests
are executable authority. A kernel export does not imply a worker operation
or visible product feature. Interpretation belongs in
[the user explanation](../explanation.md); unimplemented methods belong in
[the roadmap](current-roadmap.md#deferred-designs).

`ln` denotes natural logarithm; `log2` denotes base 2. Counts are raw integers;
rates name their denominators. Changes to meaning, bounds, or deterministic
ordering require the responsible method version to change.

| Capability | Implemented boundary |
| --- | --- |
| Trend, Company, Destinations, frequency, inventory, keyness | Bounded worker operations and browser surfaces |
| G², log ratio and interval, JSD, DP/DPnorm, MATTR | Pure kernels used by analysis operations |
| MTLD, logDice, PMI, t-score, ARI, Coleman–Liau | Pure exported kernels; not separate worker operations or visible score panels |
| Syllable readability, Delta/Cosine Delta, Poisson bursts | Unimplemented |

## Vocabulary

`freq-list/2` admits terms containing at least one Unicode letter or number.
Punctuation/symbol-only keys, including enclosed alphanumerics without those
properties, are excluded before denominators, ranking, and paging. Inventory
counts every selected token; Compare counts selected tokens in enabled classes.

The `english-common-words/1` row filter is the first 2,000 matchable lexical
types from the locked 6,690-entry ranking, NFC/apostrophe-normalized and
lowercased under English. A top-N prefix removes matching rows before ranking
and paging. It never removes tokens from the selection or changes surviving
counts, rates, DP, log ratio, G², intervals, or JSD. The source's
[publication status](corpus-inventory.md) also covers this derivative.

## Keyness

`keyness-g2-2x2/2` compares explicit disjoint selections. Let `a` and `b` be a
term's counts in sides of `N1` and `N2` tokens.

### G²

The full 2×2 term/non-term × side likelihood-ratio statistic is:

```text
E1 = N1 × (a+b)/(N1+N2)
E2 = N2 × (a+b)/(N1+N2)
G² = 2 × [a ln(a/E1) + b ln(b/E2)
          + (N1−a) ln((N1−a)/(N1−E1))
          + (N2−b) ln((N2−b)/(N2−E2))]
```

Zero observed cells contribute zero. Direction is positive when `a/N1 > b/N2`.
The two-cell shorthand is not this method: for `a=10, N1=1000, b=2, N2=2000`,
the complete statistic is `12.8349` (±0.001), with `E1=4`, `E2=8` and positive
direction; the shorthand gives `12.7806`.

### Log ratio and interval

`log-ratio-proportional/1` allocates one pseudo-count proportionally to side
size in each term/non-term row. Both sides receive an equal pseudo-rate,
preserving observed direction even for a small passage against a large rest:

```text
qA = N1/(N1+N2), qB = N2/(N1+N2)
LR = log2(((a+qA)/(N1+2qA)) / ((b+qB)/(N2+2qB)))
```

The finite point estimate adds equal pseudo-rates, preserving observed direction.
Zero-count magnitudes depend on total exposure, so a large effect need not
mean strong evidence. Default ranking uses effect size; the conservative 95%
bound, evidence, and counts are available sorts. Optional interval whiskers
are hidden by default. There is no table-wide interval filter or q-value correction.

The interval is computed separately by conditioning independent Poisson
counts on their sum: `a | a+b ~ Binomial(a+b, p)`. Modified Wilson score bounds for `p`
are transformed with `log2(p/(1-p) × N2/N1)`. They are asymmetric and may be
unbounded toward an absent side. With no occurrences, both bounds are
unbounded. See [NIST's Wilson formula](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)
and [Price and Bonett's Poisson rate-ratio interval comparison](https://www.sciencedirect.com/science/article/pii/S0167947399001000).
At the default 95% level, one to three events use the small-count modification
in [Brown, Cai and DasGupta, §4.1.1](https://doi.org/10.1214/ss/1009213286):
the binomial lower bound for count `k` is `χ²(2k, 0.025)/(2(a+b))`,
with the upper bound obtained by exchanging sides. We apply counts 1–3 at
every sample size, slightly more conservatively than BCD's small-sample rule.
Other quantiles use plain
Wilson bounds. This avoids overstating one-event evidence against a large rest.

| `(a, N1, b, N2)` | LR | 95% conditional modified Wilson interval |
| --- | ---: | --- |
| `(10, 1000, 2, 2000)` | 2.9542 | (1.3010, 6.6012) |
| `(3, 1000, 0, 1000)` | 2.8074 | (−1.9445, +∞) |
| `(3000, 100000, 200, 100000)` | 3.9035 | (3.7006, 4.1132) |
| `(0, 2000, 5, 500000)` | −2.5898 | (−∞, 7.5855) |
| `(0, 2000, 5000, 500000)` | −12.2938 | (−∞, −2.3803) |
| `(1, 2000, 40, 500000)` | 2.6141 | (−2.6946, 5.1709) |

`keyness-g2-2x2/2` retains the full G² formula and changes projection/ranking:
side membership follows observed rates; the persisted `logRatioLow` sort uses
the low bound for A-favored terms and the high bound for B-favored terms.
The UI calls this the conservative bound. Equal observed rates enter neither
one-sided projection. Compare clamps the effective combined document-frequency
minimum to the smaller side's positive document-part count in every mode,
keeping focus-only terms reachable; the authored preference remains saved.
In a one-text comparison this lowers the effective minimum to 1 on both
projections, so a rest-only term in one text is eligible too.

The interval assumes independent Poisson occurrences at fixed token exposures;
it is a rate-model approximation, not an interval inverted from the full
binomial 2×2 G² test. It is per-term, without multiplicity correction.
Running-text burstiness can make it too narrow. Per-side DP exposes
concentration but does not correct the interval.

Keyness rows fold per-side DP over sparse per-document vectors. Below two
positive-token parts, or when the term is absent on that side, row DP is null.
This differs deliberately from the standalone dispersion kernel's `DP=0`
small-part convention. `positiveParts` records the basis; null must not render
as “perfectly even.”

## Distributional divergence

`jsd-log2/1` uses relative frequencies `p`, `q` over one shared type space:

```text
m_i = (p_i + q_i)/2
JSD = 0.5 × [Σ p_i log2(p_i/m_i) + Σ q_i log2(q_i/m_i)]
```

Zero shares contribute zero. The symmetric result is finite in [0,1] bits,
including types absent on one side. Keyness computes it over every merged type
before count filters, side projection, and paging, and publishes its type count.

Fixtures: identical distributions → 0; `[1,0]` vs `[0,1]` → 1;
`[0.5,0.5,0]` vs `[0,0.5,0.5]` → 0.5;
`[0.9,0.1]` vs `[0.1,0.9]` → 0.5310 (±0.0001).

## Collocation kernels

The exported association functions use unit counts: `fx` units contain the
node, `fy` the collocate, `fxy` both, and `n` is total units. The intended
`collocates/1` event unit is a sentence. There is no collocation query or UI.
A future counting operation must define selected sentence units and complete
phrase containment before using these kernels.

```text
logDice = 14 + log2(2 fxy / (fx+fy))
PMI     = log2(fxy n / (fx fy))
t       = (fxy − fx fy/n) / sqrt(fxy)
```

Counts are nonnegative integers; marginals must be positive; `fxy` cannot exceed
either marginal; marginals cannot exceed `n` where supplied. Zero joint count
gives negative infinity for logDice/PMI and is rejected by t-score. Unit space
bounds logDice at 14. Pair-based token-window counting cannot replace it:
one node with two nearby collocates can yield `2fxy/(fx+fy) > 1`.

Fixtures: logDice `(5,20,30)` → 11.678 (±0.001); `(10,10,10)` → 14 exactly.
For `(fxy,fx,fy,n)=(4,10,20,1000)`, PMI → 4.3219 (±0.001) and
t → 1.9000 (±0.0001).
Any positional L5…R5 profile would be descriptive, separate from these scores.

## Dispersion

`dispersion-dp/1` uses selected-document token shares `s_i` and a term's
occurrence shares `v_i`, each summing to one:

```text
DP     = 0.5 × Σ |v_i − s_i|
DPnorm = DP / (1 − min(s_i))
```

Zero-token selected parts still contribute `s_i=0` to the normalization.
Below two positive-token parts the kernel returns `DP=0`, `DPnorm=null`.
Keyness uses its separate null convention above.

| Part sizes; occurrences | DP | DPnorm |
| --- | ---: | ---: |
| Three equal parts; `(9,0,0)` | 2/3 | 1 |
| Three equal parts; `(3,3,3)` | 0 | 0 |
| `(2,1,0)`; `(2,0,0)` | 1/3 | 1/3 |

## Lexical diversity

MATTR averages TTR over every sliding window (step 1; product default 500).
Sequences shorter than the window use labeled plain TTR. Empty input returns
zero. `a b a b` with window 3 gives 2/3. The numeric kernel bounds its type-id
counter allocation explicitly; string input delegates to it.

MTLD scans until running TTR drops below 0.72, counts a factor, and resets.
The final partial factor contributes `(1−TTR_end)/(1−threshold)`.
A pass returns `N/factors`, or `N` if factors are zero; the method averages
forward and backward passes. Threshold must lie in (0,1), and empty input
returns zero. Fixtures: `a b c d` → 4; `a a a a` → 2.
MTLD is exported but not exposed as a browser score.

## Readability

`readability-chars/1` exports character-based kernels:

```text
ARI          = 4.71 × characters/words + 0.5 × words/sentences − 21.43
Coleman–Liau = 0.0588 L − 0.296 S − 15.8
L = letters per 100 words; S = sentences per 100 words
```

ARI counts Unicode letters and decimal digits; Coleman–Liau counts letters
only. Counts use scalar values in normalized emitted token keys, excluding
punctuation, separators, and UTF-16 width. Inventory supplies
`readabilityCharacters` and `readabilityLetters`; `charsUtf16` instead measures
source-span extents and cannot feed these formulas.

The models yield US grade-level estimates calibrated on expository prose;
sentence count must accompany any future score presentation. ARI requires at
least one counted letter/digit per indexed token; Coleman–Liau permits fewer
letters than tokens because numerals add words. For 500 characters, 500 letters,
100 words, and 10 sentences: ARI = 7.12, Coleman–Liau = 10.64 (±0.000001).
No browser readability-score panel is implemented.

## Trend rates

`trend/1` partitions token coordinates and assigns occurrences to bins:

```text
rate = count / binTokens × 10,000
```

Raw count and actual `binTokens` accompany rates; short final bins are not
padded. Group overlap identity is the covered-token union unless raw overlap
counting is enabled. Selected matches must fit completely inside a range.

Inside/rest comparison joins selected and baseline rows by document id, sums
selected counts/tokens, and subtracts them from baseline totals. It never joins
by parallel array index because selected results contain only touched texts.
Its direction is observed `rate-contrast/1`:

```text
C = (rateInside − rateOutside) / (rateInside + rateOutside)
```

This is `(r−1)/(r+1)`, monotone in the raw rate ratio. One-sided zeroes reach
±1; no remainder or no occurrences makes direction undefined. Overlap-counted
rates remain valid even when counts exceed token denominators.

A zero-hit 21-token range versus 8 hits in the remaining 1,923 tokens yields
0 and 41.6 per 10,000, with `C=−1`. This mark uses raw rates without smoothing;
Compare uses its proportional correction and an approximate interval. The mark is solid only when
`min(p × insideTokens, p × outsideTokens) ≥ 5`, where `p` is pooled count/token
rate; otherwise it is a hairline. This fixture's minimum is 0.0864.

A phrase crossing a range edge remains outside while tokens split at the edge;
short-range phrase comparisons therefore have a boundary bias against inside.

Smoothing is a centered rolling mean over bin values with shrinking edge
windows, no padding/wrap, no crossing document boundaries, and no bridging
zero-denominator gaps. It changes presentation, not raw totals.

## Company proximity

`company/1` compares two through five tracked groups over the full ready corpus.
For each unordered pair, it separately finds each A span's nearest B span in
the same text and each B span's nearest A. Proper overlap and touching both
have gap zero, but only proper overlap enters the overlap count. Missing peer
occurrences in that text contribute to `none`, not a histogram bucket.

Bucket lower edges are `0, 1, 2, 3, 4, 5, 7, 10, 15, 25, 50, 100, 200`.
Intervals are half-open; the last extends to infinity. Nearby coverage sums
buckets below 25 and divides by the direction's complete occurrence total,
including `none`. Pair ordering uses smaller directional coverage, then shared
text count, then canonical identity. This is descriptive proximity, without
an association model or significance test.

Fixture: texts have 30 and 20 tokens. A spans are `d0:[0,2)`, `d0:[10,11)`,
`d1:[5,6)`; B spans are `d0:[2,3)`, `d0:[8,12)`. A→B has zero-gap 2, none 1,
forward 1, overlap 1; B→A has zero-gap 2, none 0, backward 1, overlap 1.
One text contains both; nearby coverage is 2/3 and 2/2 respectively.

## Reading destinations

`destinations/1` ranks occurrence-anchored, centered, document-clamped windows
of `min(400, documentTokens)` over one through five groups. Counts use starts
inside the half-open window. With full-corpus track total `n_t`,
`Rmax=max(n_t)`, and window count `c_t`:

```text
W_t    = min(16 × 65536, floor(65536 × Rmax / max(n_t,1)))
root_t = floor(sqrt(65536 × min(c_t,4096)))
score  = presentTracks × Σ(W_t × root_t)
```

Breadth, bounded rarity, and diminishing returns determine the integer score.
A focused pair requires both counts positive. Nearby anchors collapse into
runs; at most eight numeric candidates survive per text. The final pass visits
candidate depths breadth-first across texts, applies a per-text quota,
suppresses same-text overlap, and returns at most twelve. This greedy reading
list is not a maximum-coverage set. Only winners are materialized, each with
an exact occurrence anchor and an excerpt bounded to 48 tokens, 400 UTF-16
units, 512 UTF-8 bytes, and 16 marks.

Fixture: one 300-token text with one track at 10, 20, 30, 40 yields `W=65536`,
`root=512`, breadth 1, and score 33,554,432 for its sole window. In a 3,000-token
text, focused tracks at 100 and 2,800 cannot share a 400-token window; the
strict-pair result is empty.
