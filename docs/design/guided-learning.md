# Guided learning: from a mark to its source

**Status:** shipped first release

**Date:** 2026-08-30  
**Scope:** first-run teaching, contextual guides, explanatory states, copy,
interaction, accessibility, state ownership, worker boundaries, privacy, and
delivery gates

## Summary

textTrends should teach one relationship before it teaches its surface area:

> A mark is a place, and a place opens.

The guided tour follows a shown term across the ordered corpus, opens one
resident mark in Reader, then returns to the workbench with the shared reading
cursor at the same passage. It does not survey five places, load a special
tutorial corpus, stage a convenient chart, or explain every method.

Deeper learning belongs in short **Guides for this view** launched from Help.
Statistical definitions remain method notes beside the numbers, while empty and
blocked states explain their own next action. These layers share language, but
they do not share interaction machinery.

The system runs on the reader's current, browser-local corpus and writes no
durable research state. Its only staged product actions are ordinary navigation:
replace the workbench place, open Reader, and close Reader. It performs no
analysis of its own and sends no telemetry.

## Product outcome

The tour succeeds when a new reader has:

1. recognized Terms as a durable notebook rather than a search box;
2. understood that charts and strips follow declared corpus order;
3. opened a real position from a mark;
4. seen the underlined position in canonical extracted prose; and
5. returned to the chart and recognized the same position in its cursor.

The last beat is the payoff. A tour that ends in Reader teaches navigation in
one direction; returning teaches that every analytical view and the source are
projections of the same authored token geometry.

The intended moderated outcome is that at least four of five new readers finish
without coaching, can distinguish a summary line from a source-linked position,
and can independently reach a passage afterwards. None should infer that
textTrends uploads text, searches substrings, invents chapters, or treats a
chart as source evidence.

## Learning model

### Layer 1: the guided tour

One approximately one-minute narrative with five scenes between a welcome and
a finish. It teaches the product's differentiating loop, not its navigation.

### Layer 2: Guides for this view

Short, pull-only field notes launched from the existing contextual Help surface.
They explain one task or instrument in two to four readable steps. A guide can
name native gestures and offer an equivalent action in its card, but never gates
the product or turns practice into a required exercise.

### Layer 3: method notes

Definitions and interpretation live beside the relevant statistic through the
existing Help and `InfoTooltip` surfaces. Rate, count, smoothing, G², intervals,
and divergence are reference material, not tour scenes.

### Layer 4: self-explaining states

An empty or blocked surface names what is missing and offers the direct next
action. It must not require a guide to become usable.

Coverage is deliberately split this way. Place labels already say where a
surface is; the guided tour explains why the surfaces belong to one reading
instrument.

## Guided-tour contract

### Availability and consent

The tour can begin when the live project has:

- at least one ready text in the current snapshot;
- at least one shown term; and
- no active Speed reader session.

Help keeps the launcher visible when a prerequisite is missing, disables it
with a plain-language reason, and offers the direct fix: **Add a text** or
**Track a term**. An active Speed reader gets **Exit Speed reader to start**.
With no corpus, Help may also offer the existing hash-verified Sherlock Holmes
sample action. Loading that sample is a separate, explicit choice; the guide
never imports or indexes data.

Target readiness is separate from these reader-controlled prerequisites. A
pending or superseded dispersion result does not disable the launcher: the
first scenes can begin while it settles, and the mark scene reports the work in
progress. A ready result with no resolvable position disables the launcher with
**Show a term that occurs in a ready text**. This avoids a disabled control whose
only remedy is waiting while still preventing a tour that cannot reach a source.

There is no autostart. A one-time invitation ships only after the tour itself
is demonstrable. It is an in-flow, non-modal notice on Trends, cannot cover the
analytical work, and can be permanently dismissed for that guide version. Help
always allows replay.

### Seven-card script

Copy is derived from live context so it cannot assert a rate while the reader is
viewing counts, call a density bucket an occurrence, or mention a Reader scale
that is unavailable.

#### 0. Welcome

- **Kicker:** `textTrends · guided tour`
- **Title:** **A reading instrument**
- **Body:** “textTrends measures your texts so you can find your way back into
  them. About a minute, on the texts you already have.”
- **Status:** `Processed in your browser · never uploaded.`
- **Actions:** `Begin` and `Not now`
- **Stage:** capture the origin place, Reader state, and launch control. Do not
  mutate product state.

#### 1. Terms

- **Anchor:** `terms-rail`
- **Card side:** `block-start`
- **Title:** **The terms you track**
- **Body:** “Terms are a notebook, not a search box. Up to five are shown at
  once, and those terms travel through Trends, Matches, the reading strip, and
  Reader.”
- **Hint:** “Add term opens quick entry; Manage opens the full editor.”
- **Action:** `Next`
- **Stage:** `replacePlace('trends')`; do not alter the notebook or shown terms.

#### 2. The ordered axis

- **Anchor:** `trend-plate`
- **Card side:** `block-end`
- **Title:** **One order, followed everywhere**
- **Body:** “Each line follows a term through the corpus in declared reading
  order and breaks at every text boundary. Matches, the reading strip, and
  Reader all use that same order.”
- **Measure-aware hint:** “Height is a rate per 10,000 tokens.” or “Height is a
  raw count.”
- **Action:** `Next`
- **Stage:** none. Combined, equal, and to scale layouts remain untouched.

#### 3. The mark

- **Anchor:** `dispersion-strip`
- **Card side:** `block-end`
- **Exact title:** **Every mark is a position**
- **Exact body:** “The strip beneath the graph is the occurrences themselves —
  one mark, one reference. Open one and you are in the text.”
- **Direct-activation hint:** “You can also activate any mark directly.” This is
  used only when the live row reports that occurrence activation is available.
- **Coarse-pointer hint:** “On touch these marks are read-only; this card opens
  the one it found.”
- **Minimized-row hint:** “These marks are minimized at this row height. This
  card opens the one it found.” This branch takes precedence whenever the live
  row disables occurrence activation, including on a fine pointer.
- **Exact action:** `Open this reference`
- **Density title:** **These marks are counts**
- **Density body:** “Above a threshold the strip shows density bands rather than
  single occurrences. A band tells you how many, never which one.”
- **Density action:** `Open this position`
- **Stage:** open Reader through the ordinary governed reader intent. Exact
  targets use `anchor: 'occurrence'`; density midpoints use `anchor: 'position'`.
  The step also advances if the reader opens Reader themselves.

Resident dispersion must be ready before the action enables. Pending work gets
an honest status. An unresolvable target gets a descriptive `Continue` and
`Exit`, never a spinner without an exit.

#### 4. The source

- **Anchor:** `reader-prose`
- **Card side:** `block-end`
- **Title:** **The text is the evidence**
- **Body:** “This is canonical extracted text from your browser-local library,
  opened at the reference you chose.”
- **Hint:** “`w` and `b` step to the next and previous reference anywhere in the
  corpus.”
- **Action:** `Next`
- **Stage:** none. Ordinary evidence navigation already opens the Read scale.

#### 5. The return

- **Anchor:** `chart-cursor`
- **Card side:** `block-end`
- **Title:** **The place comes with you**
- **Body:** “Back returns to the workbench, and the cursor in the charts is now
  the passage you just read.”
- **Action:** `Go back`
- **Stage:** close Reader through its ordinary governed action. Pressing the
  Reader Back control, browser Back, or Escape may satisfy the scene; the guide
  does not claim those keys globally. The controller distinguishes a traversal
  that changes the live state from the tour-opened Reader to its workbench
  parent from every other `popstate`. That Reader-close traversal advances the
  scene; an external traversal exits the guide without restoration.

The shared cursor is already published by Reader entrance. This scene reveals
shipped behavior; it does not manufacture a selection.

#### 6. Finish

- **Kicker:** `Guided tour · complete`
- **Title:** **Start with a word. End with the text.**
- **Body:** “Every measurement here points at a position you can open. Matches
  lists every reference in corpus order; Compare weighs one passage against the
  rest.”
- **Actions:** `Stay here`, `Back to where I was`, and `Replay`
- **Links:** Guides for this view — Terms, Reading a trend, The reading strip,
  and Compare a passage.

The complete tour has no staging intent outside place replacement, Reader open,
and Reader close. Returning to the captured origin may perform another place
replacement; the safety property is the closed three-member intent union, not a
fragile action tally.

## Guides for this view

### Launch set

1. **Terms and the notebook** explains the notebook versus the shown five,
   shown and hidden terms, aliases, phrases, one-ended wildcards, and temporary
   Find terms that never enter the notebook.
2. **Reading a trend** explains combined/equal/to scale layouts, rate versus
   count, smoothing, exact marks versus density bands, the shared reading cursor,
   and reading destinations.
3. **The reading strip** explains the corpus-order axis, hover seek,
   press-drag shuttle, touch scrub, exact and density lanes, and opening Reader.
4. **Compare a passage** explains whole-text selection, title-to-title drag,
   the keyboard selection path, and the contract that A is the exact selected
   tokens while B is the corpus complement. It states that a range never filters
   Matches.

The notes are readable from start to finish without performing an action. They
can offer `Show me` or a native action when context supports it, but never turn
the app into a tutorial mode.

### Later set

- Build a corpus
- Matches and source
- Compare two texts
- Vocabulary and what a filter does not change
- Reader scales: Read and Atlas
- Speed reader

Build a corpus is intentionally not in the launch set. Inputs is already the
most self-explaining place and is used before a guide has useful context. If
moderated testing disproves that judgment, its later-set entry is ready to
promote.

### Discovery and progress

Help's **This view** section always lists the relevant note. Existing states may
link to a note where the link is the shortest path to useful context: Compare's
no-range-selected explanation can link to Compare a passage, and Matches'
**No terms shown in analysis** branch can link to Terms and the notebook. The
distinct **No occurrences of the enabled terms** branch does not.

Place arrival, dwell time, idle detection, and error counts never trigger a
guide. Slow deliberate reading is normal use, not evidence of confusion.

Notes always reopen from the start. There are no badges, percentages,
prerequisites, “seen” labels, ordered curriculum, or completion records. The
only persisted learning state is the version stamp for the optional tour
invitation.

### Self-explaining work revealed by the guide

- Inputs empty state should add: “Add a text, then track a term.”
- Trends with no shown terms must name `Track a term` rather than render an
  empty stack.
- Compare's no-range-selected explanation should link to Compare a passage.
- The dispersion strip needs a concise “What is this?” method affordance.
- User-facing scope copy should consistently say **texts**, not **books**.

## Presentation and interaction

### One fixed card, two block sides

The live compact layout already reserves its bottom edge for navigation and the
workbench dock. A bottom sheet would cover the Terms rail; a permanent top strip
would cover the trend plate. The guide therefore uses one non-modal fixed card
with a declared side:

```ts
type GuideCardSide = 'block-start' | 'block-end';
```

`block-end` is the default and sits above the dock. `block-start` sits below the
sticky header and is used for the Terms scene so the dock remains visible.
Desktop cards use a restrained 26rem maximum measure. Compact cards may become
full-width, but remain bounded to roughly one third of the dynamic viewport,
scroll internally, respect safe areas, and keep actions at least 44px high.

The choice deliberately needs no target geometry, observer, collision engine,
or application reflow.

### Semantic anchors

Targets opt in through stable `data-guide-anchor` values. The shell exposes the
current value through `data-guide-anchor-active`, allowing CSS to draw a static
accent outline. The outline is decorative; the card always names the target in
the same words as the UI.

Initial anchors are:

- `terms-rail`
- `trend-plate`
- `dispersion-strip`
- `chart-cursor`
- `reader-prose`
- `reading-footer`
- `compare-sides`

At step entry, exactly one semantic lookup is allowed. A missing target degrades
to an unanchored explanation. An offscreen target scrolls into the nearest view.
No CSS-structure selector or continuous geometry observer belongs in guide
logic.

### Accessibility

- The card uses `role="dialog"`, `aria-modal="false"`, and its heading as the
  accessible name. It never traps focus or makes the workbench inert.
- Focus moves to the heading when a scene changes. A revision counter makes
  Replay announce the first card again. Exit restores the launch control when
  it still exists.
- The guide owns no global keyboard command. Escape exits only while focus is
  inside the card. Existing Reader, Find, range, details, and utility-pane Escape
  behavior keeps precedence.
- The card carries every required action, while its copy names the equivalent
  native gesture. Touch never depends on hover or a fine-pointer mark.
- Place and Reader transitions receive one concise polite announcement.
- Reduced motion removes scrolling and transition animation, not information or
  state.

### Interruption and history

The session never enters the workspace or URL. Reload abandons it. Place changes
use replace semantics. Opening Reader creates exactly the history entry created
by the same user action, and closing Reader consumes it normally.

`Back to where I was` closes Reader if necessary, then replaces the current
place with the captured origin after the close traversal settles.

History attribution is transition-based. While the return scene or an explicit
restore is awaiting Reader close, a `popstate` that changes the Reader layer
opened during this guide to its remembered workbench parent is consumed as that
ordinary Reader close and advances or continues restoration. Any other
`popstate` ends the guide without restoration and lets navigation proceed. The
controller observes the before / after Reader layer identity; it does not add a
second history implementation.
The guide never hijacks Back.

## Architecture contract

### State ownership

| State | Owner | Lifetime |
| --- | --- | --- |
| active guide, step, origin, target facts | UI guide controller | session |
| tour version and dismissed invitation | `texttrends/guide/1` record | device-local |
| card side, anchor presence, scroll | component | render |
| notebook, active terms, corpus, styles, trend settings, selection | existing research state, untouched | existing |

The shipped implementation owns the session in a dedicated React controller
over a pure reducer and proves that it cannot enter `workspaceFromApp`.
Components consume actions and derived context, not registry internals.

### Narrow staging surface

```ts
type GuideStageIntent =
  | { readonly kind: 'place'; readonly place: Place }
  | { readonly kind: 'reader-open'; readonly intent: ReaderOpenIntent }
  | { readonly kind: 'reader-close' };
```

There is no stage representation for the notebook, active terms, styles,
measure, bins, view preference, selection, keyness settings, project, or corpus.
That absence is the primary safety property.

### Declarative registry

```ts
interface GuideDefinition {
  readonly id: GuideId;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly places: readonly Place[];
  readonly requires: (context: GuideContext) => GuideReadiness;
  readonly steps: readonly GuideStep[];
}

interface GuideStep {
  readonly id: string;
  readonly kind: 'welcome' | 'scene' | 'finish';
  readonly anchor?: GuideAnchorId;
  readonly cardSide: 'block-start' | 'block-end';
  readonly copy: (context: GuideContext, phase: GuideStepPhase) => GuideCopy;
  readonly stage?: (context: GuideContext) => GuideStageIntent | null;
  readonly advance:
    | { readonly kind: 'manual' }
    | { readonly kind: 'action'; readonly event: GuideEvent };
}
```

The registry contains copy, semantic identifiers, pure readiness, and typed
intents. It contains no React nodes, selectors, direct state mutation, or worker
calls. Contextual Help summaries and their expanded field notes derive
from the same registry content so the two voices cannot drift.

### Resident target resolution

`resolveGuideTarget` is pure over resident, snapshot-bound dispersion and the
ready document order. It issues no query.

1. Prefer the shown term track with the largest total whose representation is
   exact.
2. Choose its occurrence nearest the midpoint of the longest ready text, giving
   Reader context on both sides.
3. Break ties by notebook order, declared text order, then lowest token.
4. If no exact track exists, choose a resident density band deterministically
   and preserve `anchor: 'position'` truth.
5. Reject stale snapshot facts and report pending or unavailable rather than
   guessing.

The exact data adapters and tie-breaking fixtures belong in unit tests so future
dispersion representation changes cannot silently change the narration.

### Worker and persistence boundary

The guide performs no analysis of its own: no speculative prefetch, fixture
index, extra generation, or query the equivalent action would not issue. Opening
Reader still performs the normal bounded `reader-page/1` request, and closing it
may schedule the normal reading-footer passage. Those are product navigation,
not guide analysis.

During the scripted tour there must be no guide-attributable `trend`,
`dispersion`, `matches-window`, `inventory`, `freq-list`, `keyness`, `company`,
`destinations`, or `occurrence-step` query.

The guide stores no source names, text, term strings, passages, document
identities, corpus sizes, or active scene. There is no network telemetry. The
small device-local invitation record is versioned and schema-checked. Its key
must be registered in `OWNED_LOCAL_STORAGE_KEYS` so the existing full
browser-data reset clears it.

## Verification gates

### Unit

- registry integrity and anchor uniqueness;
- exact, density, mixed, empty, zero-occurrence, and stale-snapshot target
  resolution;
- manual and action-driven advancement;
- versioned invitation storage and legacy rejection;
- a full-script no-durable-writes assertion that derives every durable field
  from `WORKSPACE_SEMANTIC_SOURCE_KEYS`, plus transient `linkedSelection`; and
- full-reset coverage proving the guide storage key is registered and removed.

### Browser

- full walk ending at the resolved Reader token and returning to the chart
  cursor;
- native action satisfaction and card-action fallback;
- exit, replay, return-to-origin focus, popstate, and reload;
- pending, unavailable, worker-restart, and snapshot-change degradation;
- exactly one element for each active semantic anchor;
- no forbidden guide-attributable analysis queries; and
- no behavior or visual change when no guide is active.

`guide.spec.ts` is included explicitly in the `webkit-compact` project
`testMatch`; that project is a filename allowlist. Compact WebKit at 320×568
fits the card without page-level horizontal overflow, retains 44px actions,
keeps the Terms rail visible under the top card, and preserves a usable exit on
a short landscape viewport. Keyboard-only, coarse-pointer, reduced-motion,
dark, and light presentations remain part of the surrounding acceptance gate.

## Shipped delivery sequence

1. **Decision and anchors:** record these invariants in
   `product-decisions.md`, add the five tour anchors, standardize `books` to
   `texts`, and prove anchor uniqueness without a visual change. The other three
   declared anchors land with the contextual guide that first uses them.
2. **Guided-tour foundation:** registry, target resolver, staging adapter,
   controller, versioned storage, card, Help launcher, unit tests, and full plus
   compact browser flows.
3. **Guides for this view:** launch four notes, derive Help summaries from their
   copy, and add the two high-value contextual links.
4. **Self-explaining states:** fix Inputs, zero-term Trends, Compare, and
   dispersion explanation without introducing guide-only dependencies.
5. **Invitation:** ship once-per-version discovery only after the complete tour
   passes its product, accessibility, and browser gates.

Reader scales and the later guide set follow the shipped Reader/Atlas contract;
they do not block the first release.

## Delivery defaults

Unless product testing calls for a change, implementation should:

- preserve the current coarse-pointer and minimized-row Trends limitations and
  state them truthfully in the card rather than smuggling a product interaction
  change into the tour;
- standardize released user-facing `books` copy to `texts`;
- defer shareable `?tour=` routing until the local launcher and invitation are
  validated. The existing consumed `?demo=` boot parameter is a suitable
  precedent if a shareable entry point later earns its sequencing cost; and
- implement the invitation last, keeping Help as the durable discovery path.

## Collaboration provenance

The direction began with independent Codex and pinned Claude Opus
product/architecture passes, followed by a joint synthesis challenged against
the working tree. A first exact-diff Opus review then found and corrected the
Reader-close history attribution and minimized-row activation branches before
implementation.

| Question | Joint resolution |
| --- | --- |
| Teaching spine | Terms → ordered axis → mark → Reader → return cursor |
| Example data | Resident reader data; sample loading remains a separate consented action |
| Staged research state | None; only place, Reader open, and Reader close intents exist |
| Analysis | No guide-specific query; ordinary Reader/footer traffic remains ordinary product work |
| Find | Explained only in the Terms field note, never used as a notebook substitute |
| Compact placement | One fixed card with a declared block side |
| Progress | One invitation version stamp; no note completion UI |
| Privacy | No network telemetry |

The collaboration is recorded by Parley requests
`req_texttrends_tutorial_ideation_opus`,
`req_texttrends_tutorial_synthesis_opus_final`, and the first staged review
`req_review_diff_b36d391ee5cfe4d8`.
