# Guided learning execution plan

**Status:** shipped and verified

**Date:** 2026-08-30

**Authority:** [Guided learning: from a mark to its source](guided-learning.md),
landed in `045b523`

## Outcome

This plan records the complete first release of the guided-learning system:

- the seven-card mark-to-source-to-cursor tour;
- honest prerequisite and degradation states;
- four pull-only Guides for this view;
- the product states that should explain themselves without a guide; and
- a restrained, once-per-version invitation, delivered last.

The active guide session belongs to a dedicated React controller over a pure,
node-testable reducer. It does not become application research state. The
programme adds no `AppState` field, no worker operation, no guide-specific
query, no route key, and no edit to `lib/store.ts`.

Implementation landed in focused commits. Each staged product-code slice was
reviewed by pinned Claude Opus before commit, and findings were resolved through
an exact successor-diff review rather than waived.

## Decisions

| Question | Decision |
| --- | --- |
| Session owner | `components/guide/GuideProvider.tsx`, backed by the pure reducer in `lib/guide/session.ts` |
| Persistence proof | Guide state is absent from `AppState`; an import-boundary test prevents pure guide modules from reaching the store, worker, React, or components |
| Stage authority | One closed union: place replacement, Reader open, Reader close |
| Target source | Snapshot-matched resident dispersion and token extents only |
| Reader-close attribution | Stable before/after layer identity, never a second history model |
| Card placement | One fixed card with step-declared block side and route-aware dock/lens clearance |
| Guide discovery | Workbench Help plus two contextual state links; no place-arrival or behavioral trigger |
| Stored learning state | Tour completion version and dismissed invitation version only |
| Release scope | Overall tour, four launch notes, self-explaining states, invitation last |

### Implementation clarifications

The overall tour starts from **workbench Help only**. Reader and Speed reader
Help retain their own context and later receive Reader-specific notes. This
keeps the first release's origin and restoration contract exact: a tour origin
always has a workbench place and no Reader layer. The launcher remains visible
outside the workbench only as a direct explanation to return to the workbench;
it does not start a partially hidden session.

The return scene has two render phases but remains one conceptual card:

1. in Reader it offers **Go back**; and
2. after the governed close, the same scene is revealed over Trends, resolves
   and accents `chart-cursor`, announces the returned position, and offers
   **Finish**.

Only then does the Finish card render. A native Reader close while the Source
scene is active enters the revealed return scene instead of fast-forwarding
past the tour's payoff.

Action satisfaction is current-step and target-qualified. A Reader open
satisfies the Mark scene when it is either the card's resolved intent or an
exact live barcode open in the same snapshot. An unrelated footer, Matches, or
other Reader destination exits the tour without restoration; it is never
narrated as the mark the guide found.

## Dependency boundaries

### File map

```text
apps/web/src/lib/guide/
  anchors.ts       semantic ids and shared card/focus ids
  activation.ts    exact native-activation truth table
  context.ts       structural, store-free facts and readiness
  target.ts        resident exact/density target resolver
  definition.ts    guide, step, copy, action, and stage types
  stage.ts         closed three-action adapter
  session.ts       reducer and navigation classifier
  help-content.ts  current-view Help copy and small guide synopses
  registry.ts      tour and field-note scripts; loaded lazily
  storage.ts       versioned local learning record; invitation commit only

apps/web/src/components/guide/
  GuideProvider.tsx
  GuideCard.tsx
  HelpGuides.tsx
  GuideLink.tsx
  GuideInvitation.tsx
```

The dependency direction is one-way:

```text
main / App / Help
        │
        ▼
GuideProvider ──► pure guide context, reducer, target, and stage modules
        │
        └────────► lazy registry and GuideCard after a guide is requested

lib/guide/** ──X──► store, store-instance, worker, components, React
```

The exceptions are deliberately narrow:

- non-guide product components may import `anchors.ts` and `activation.ts` to
  publish semantic facts; and
- `GuideLink` is a presentation-only launcher that panels may render without
  importing provider, reducer, registry, or stage logic.

`test/import-boundary.test.ts` enforces both rules. In particular,
`lib/guide/**` never imports even the `AppState` type. A field that does not
exist on `AppState` cannot enter `workspaceFromApp`; TypeScript provides the
primary persistence proof.

### Mount point

`GuideProvider` mounts inside `PresentationProvider`, wraps `App`, and renders
the card as an `App` sibling inside `#root`:

```tsx
<PresentationProvider>
  <SeriesPaletteSync />
  <GuideProvider>
    <App />
  </GuideProvider>
</PresentationProvider>
```

This one mount survives both exclusive `App` return branches: the workbench
main and full-viewport Reader main. It remains inside `#root`, so an existing
modal `FormLayer` makes the card inert automatically. It is never portalled to
`document.body` and never competes with Help, Settings, Debug, or authoring
layers.

The provider statically imports only the small structural engine. The
copy-bearing registry and card load on demand so the current entry-chunk budget
retains headroom. Bundle size is measured when the tour, field notes, and
invitation land. If that shell crosses the hard entry budget, the first remedy
is to move `target.ts` and its resolver context into the same lazy guide-runtime
chunk as the registry and card. If that is insufficient, the provider becomes
a static context/API shell whose `GuideRuntime` child loads only after an
explicit Help/`GuideLink` start request or an invitation eligibility check.
Neither remedy changes the public provider contract. Guide work never raises
`ENTRY_GZIP_BUDGET_BYTES`.

## Pure contracts

### Context

The provider maps current store and presentation state into a store-free shape:

```ts
interface GuideContext {
  readonly place: Place;
  readonly readerOpen: boolean;
  readonly rsvpActive: boolean;
  readonly snapshotId: string | null;
  readonly readyDocs: readonly string[];
  readonly readyTexts: number;
  readonly shownTerms: readonly {
    readonly seriesId: string;
    readonly label: string;
  }[];
  readonly measure: 'rate' | 'count';
  readonly rateDenominator: number;
  readonly occurrenceActivation:
    | 'available'
    | 'minimized'
    | 'coarse'
    | 'unknown';
  readonly target: GuideTargetResolution;
}
```

`rateDenominator` comes from `TREND_RATE_DENOMINATOR`, never a copy literal.
Native occurrence activation is published by the semantic dispersion anchor:

```ts
function occurrenceActivationFor(input: {
  readonly coarse: boolean;
  readonly barcodeInteractive: boolean;
}): 'available' | 'minimized' | 'coarse' {
  if (!input.barcodeInteractive) return 'minimized';
  return input.coarse ? 'coarse' : 'available';
}
```

Minimized takes precedence on every pointer. If the anchor is missing, the
context is `unknown` and the card makes no native-gesture claim.

### Registry

The registry contains strings, identifiers, pure readiness, and typed intents;
it contains no React nodes, selectors, store calls, or worker calls:

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

`GuideCopy` is plain serializable data: kicker, title, body, hints, status,
actions, and optional note ids. Unit tests evaluate every copy branch across
exact/density/pending/unavailable, rate/count, and every native-activation
state.

### Closed stage surface

```ts
type GuideStageIntent =
  | { readonly kind: 'place'; readonly place: Place }
  | { readonly kind: 'reader-open'; readonly intent: ReaderOpenIntent }
  | { readonly kind: 'reader-close' };

interface GuideStageActions {
  readonly replacePlace: (place: Place) => void;
  readonly openReader: (
    intent: ReaderOpenIntent,
    returnFocusTo?: string,
  ) => void;
  readonly closeReader: () => void;
}
```

`applyGuideStage` has an exhaustive `never` branch. The provider constructs an
action object with exactly those three keys. Reader opens pass the stable guide
heading id as `returnFocusTo`, allowing the existing store focus restoration to
find the active card after Reader closes. No fourth stage action is permitted.

## Resident target resolution

`resolveGuideTarget` accepts structural facts instead of `AppState`:

```ts
interface GuideTargetInput {
  readonly snapshotId: string | null;
  readonly readyDocs: readonly string[];
  readonly shownTerms: readonly GuideTermFacts[];
  readonly dispersion: GuideDispersionFacts | null;
  readonly tokenCountOf: (doc: string) => number | undefined;
}

type GuideTargetResolution =
  | { readonly status: 'ready'; readonly target: GuideTarget }
  | {
      readonly status: 'pending';
      readonly reason: 'dispersion' | 'superseded' | 'extents';
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'no-corpus'
        | 'no-shown-term'
        | 'no-occurrences'
        | 'failed';
    };
```

The exact CSR axis is `snapshot.readyDocs`: dispersion is issued over that same
declared-order array. The resolver must not reconstruct or sort it.

Resolution is deterministic:

1. reject no corpus and no shown term as unavailable;
2. report absent/pending dispersion as pending;
3. report snapshot mismatch as superseded/pending, never use stale facts;
4. ignore resident tracks not in the current shown-term order;
5. prefer an exact track with a positive total, choosing largest total then
   notebook order;
6. within that track, choose the longest ready text that both has an occurrence
   and a known positive extent; break extent ties by declared order;
7. choose the occurrence nearest the text midpoint; break distance ties by the
   lower token;
8. when no exact track exists, choose a positive density track by the same
   total/notebook rule, then a nonempty density text by extent/order, then the
   nonzero bucket whose midpoint is nearest the text midpoint; and
9. preserve exact targets as `anchor: 'occurrence'` and density targets as
   `anchor: 'position'`, including the density bucket count.

Density midpoint arithmetic is byte-for-byte equivalent to `barcodeTracks`:
the final bucket ends at its document's `docTokenCount`, and midpoint is
`t0 + ((t1 - t0) >> 1)`. Agreement tests compare both projections. The resolver
iterates the packed typed arrays directly; it does not materialize every
occurrence into a view-model object.

Fifteen focused fixtures cover exact and density selection, totals and distance
ties, a longest text with no occurrence, missing extents, the final density
bucket, mixed representation, zero occurrences, stale/error/broken results,
foreign tracks, and agreement with the shipped barcode view.

## Session and navigation

### State

```ts
interface GuideReaderFence {
  readonly layerId: string;
  readonly parentIds: readonly string[];
  readonly parentPlace: Place;
  readonly target: GuideReaderTarget;
}

type GuideStepPhase = 'presenting' | 'awaiting-action' | 'revealed';

interface GuideSession {
  readonly guideId: GuideId;
  readonly version: number;
  readonly stepIndex: number;
  readonly stepPhase: GuideStepPhase;
  readonly revision: number;
  readonly origin: {
    readonly place: Place;
    readonly focusCandidates: readonly string[];
  };
  readonly readerFence: GuideReaderFence | null;
  readonly restore:
    | { readonly kind: 'idle' }
    | { readonly kind: 'closing-reader'; readonly deadlineMs: number }
    | { readonly kind: 'replacing-place' };
}
```

The reducer is pure. For every input it returns the next session, at most one
stage intent, an optional polite announcement, and a focus request.

### Qualified Reader open

When the Mark card applies `reader-open`, the provider captures facts before
the synchronous store action, temporarily absorbs its subscription callback,
then classifies the re-read post-action facts itself. It admits the open only
when snapshot, document, token, anchor claim, and Reader origin match the
expected intent.

A native open is admitted only while the Mark card awaits its action and only
when the resulting Reader target is an exact barcode target in the live
snapshot. The session adopts that actual target before showing the Source card.
Other opens are foreign navigation and end the guide without undoing the
reader's action.

### Reader-close fence

The provider subscribes to every Zustand transition and projects only:

```ts
interface GuideNavigationFacts {
  readonly place: Place;
  readonly layerIds: readonly string[];
  readonly reader: GuideReaderTarget | null;
}
```

A qualified Reader open records the terminal Reader layer id, its exact parent
id prefix, parent place, and opened target. A close is guide-consumable only
when:

- before is exactly `[...parentIds, layerId]` with the qualified Reader open;
- after is exactly `parentIds` with no Reader; and
- the workbench place remains `parentPlace`.

In-Reader paging, reference stepping, or Atlas movement preserves the terminal
layer id and does not advance or exit. Every other navigation shape is foreign
and exits without restoration.

`replacePlace` is synchronous and is absorbed only while the guide applies its
own place stage. `closeReader` merely requests asynchronous history traversal,
so the later transition must earn the close through the recorded fence.

### Return and restore

The state transitions are:

| Current state | Event | Result |
| --- | --- | --- |
| Mark awaiting | qualified Reader open | Source card, fence recorded |
| Source | manual Next | Return card in Reader |
| Source | qualified Reader close | Return card revealed over chart |
| Return awaiting | qualified Reader close | same Return card, `revealed`, cursor anchor re-resolved |
| Return revealed | manual Finish | Finish card |
| Any other navigation | foreign | end without restoration |

`Back to where I was` from the Finish card normally needs only a place
replacement because the return beat already closed Reader. Exit from Source or
the pre-close Return card first requests Reader close, waits for the exact
fenced transition, then replaces the origin place and restores focus.

Restoration has a 1.2-second deadline so a silently consumed simultaneous Back
cannot strand the card. The timeout is armed only during close restoration and
is cleaned on every outcome and StrictMode effect cleanup.

## Help and launch sequencing

### Starting from modal Help

Help is a portalled `FormLayer` that makes `#root` inert. A guide must not become
active behind it. `App` therefore owns the close-and-start sequence:

1. `HelpGuides` reports the chosen guide id through a `HelpPane` callback;
2. `App` captures the durable origin focus candidate, normally
   `#global-help-open`;
3. `App` closes the utility pane without its ordinary focus restoration;
4. the existing close-settlement loop waits until `#root.inert` is false; and
5. only then does `App` call `GuideProvider.startGuide`.

`closeUtilityPane` is refactored to accept an optional settled callback and a
focus-restoration policy; its existing retry behavior remains the one inert
settlement authority. The callback receives whether `#root` is interactive at
the existing three-frame bound. On exhaustion, `App` abandons the start, renders
no card, restores no focus into the inert root, and leaves the ordinary
workbench visible; once the owning `FormLayer` cleanup clears inertness, the
user can reopen Help. A forced-exhaustion test asserts that `startGuide` is not
called. The provider never knows how Help is mounted, and `HelpGuides` never
manipulates root inertness.

Deep state links use the small `GuideLink` component. It captures its own stable
button id as an origin focus candidate and calls the provider directly because
no utility pane needs to close. Compare and Matches import only this
presentation component, not guide orchestration.

### Readiness

The overall tour launcher is visible in workbench Help in every workbench
state:

| Live facts | Launcher behavior |
| --- | --- |
| no ready text | disabled; **Add a text** opens Inputs |
| ready text, no shown term | disabled; **Track a term** closes Help and opens/focuses Add term |
| target pending or superseded | enabled; early scenes begin and Mark reports progress |
| ready with no occurrence | disabled; **Show a term that occurs in a ready text** |
| dispersion failed | disabled; points to the chart retry path |
| ready target | enabled; **Start the guided tour · about a minute** |

Outside the workbench, the same Help section remains discoverable but cannot
start a hidden session. Reader Help shows the disabled explanation **Return to
Trends to start the guided tour**. Speed-reader Help uses the authority's exact
disabled reason **Exit Speed reader to start**. Exiting Speed reader returns to
Reader; Help then shows the Reader explanation until the user returns to the
workbench. Reader-specific notes remain a later release.

Sample loading remains a separate consented Inputs action in the first release;
the guide does not acquire data.

## Anchors and presentation

### DOM owners

The five tour anchors land first:

| Anchor | Owner |
| --- | --- |
| `terms-rail` | real `QuerySurface` Terms aside and Suspense-exclusive `TermsRailFallback` |
| `trend-plate` | `TrendPanel` outer section |
| `dispersion-strip` | one new inert semantic marker inside `ScrubSurface` |
| `chart-cursor` | existing moving cursor overlay |
| `reader-prose` | real Reader prose pane and Suspense-exclusive Reader fallback |

Contextual anchors land with the note that needs them:

- `reading-footer` on the Reading position aside;
- `compare-sides` on the comparison-definition surface; and
- `matches-grid` later with the deferred Matches and source note, not in this
  release.

By-book Trends paints one barcode canvas per text, so `dispersion-strip` cannot
reuse a unique canvas. One absolutely positioned, `aria-hidden`,
`pointer-events:none` marker spans the barcode lane collection. It is placed
above analytical paint only while its decorative outline is active; its
permanent transparent surface never accepts a hit. Geometry reuses the existing
plot height, gap, barcode height, row pitch, and text count—no measurement.

At step entry, one semantic lookup resolves the anchor. Missing degrades to an
unanchored card. An offscreen target uses `scrollIntoView` with `nearest` block
and inline alignment, `auto` under reduced motion and `smooth` otherwise. No
observer or positioning engine is introduced.

`chart-cursor` is conditional on a valid laid-out scrub position. Its absence
never gates the Return reveal: the announcement and **Finish** action proceed in
the unanchored card after a qualified close, including after mid-tour snapshot
churn.

The provider writes one root `data-guide-anchor-active` value. Explicit CSS
rules connect each typed id to its matching semantic element. A unit test proves
every declared anchor has a rule. No guide code uses a structure selector.

### Card CSS

The card uses `z-index: 75`, strictly above Reader (`70`) and below modal forms
(`80`). It uses a 26rem reading measure on wide screens and a safe-area-aware,
internally scrolling compact shape with 44px actions.

`block-start` clears the measured `--app-header-block-size`, falling back to the
chrome target only before measurement.

`block-end` is route and breakpoint aware:

- wide workbench and every Reader: dock size + keyboard inset + safe area;
- compact portrait and 600–959px workbench: lens size + dock size + keyboard
  inset + safe area; and
- compact landscape workbench: dock size at the bottom plus the existing side
  lens width in the inline-start inset.

The card carries `data-guide-reader` so Reader never inherits the workbench's
bottom-lens offset. This closes the overlap that a `--dock-block-size`-only rule
would create.

### Accessibility

- `role="dialog"`, `aria-modal="false"`, heading-labelled; no focus trap,
  backdrop, or workbench inertness.
- Heading focus on every step/phase revision; Replay bumps revision.
- Escape exits only from an event whose target is inside the card.
- Required actions are native buttons and never depend on an analytical mark.
- One visually hidden polite live region announces place, Reader, and returned
  cursor transitions once.
- Utility panes retain modal precedence because the card stays inside `#root`.
- Exit focus falls through stable candidates: originating guide link, global
  Help, origin place heading.
- Reduced motion removes only transitions and smooth scroll.

## One source of Help and guide copy

`lib/guide/help-content.ts` owns the existing Workbench, Reader, and Speed reader
summary/hint/method copy plus small guide synopses: id, title, summary, and
relevant places. `HelpPane` consumes the view copy synchronously, so moving it
does not add bytes that were not already in the entry chunk.

The lazy registry imports those synopses for guide titles and summaries, then
adds detailed step copy. Help lists and card definitions therefore cannot drift
on identity or promise, while the large step script remains lazy.

The four launch notes are manual and pull-only:

1. **Terms and the notebook** — notebook versus shown terms, shown/hidden,
   authoring forms, temporary Find;
2. **Reading a trend** — combined/equal/to scale, measure and smoothing,
   exact/density honesty, cursor and destinations;
3. **The reading strip** — corpus axis, fine/coarse gestures, evidence lanes,
   opening Reader; and
4. **Compare a passage** — range gestures and keyboard path, exact A versus
   corpus-complement B, and why Matches is not filtered.

Every note has only manual Next/Done actions and always reopens at its first
step. There is no progress, seen state, badge, percentage, curriculum, or
required exercise.

## Self-explaining product states

These ship independently of the guide engine:

- Inputs adds **Add a text, then track a term** to its empty Active inputs card.
- zero-term Trends renders a named next step and an ordinary **Track a term**
  action instead of an empty stack;
- Compare's no-range-selected branch renders a `GuideLink` to Compare a
  passage;
- Matches' **No terms shown in analysis** branch renders a `GuideLink` to Terms
  and the notebook, while **No occurrences of the enabled terms** does not; and
- the dispersion legend gains an ordinary method tooltip explaining exact marks
  and density bands.

The first two and the tooltip import no guide module at all. They remain useful
if the entire guide controller is reverted.

## Local learning record and invitation

The final commit adds `texttrends/guide/1`:

```ts
interface GuideProgressV1 {
  readonly v: 1;
  readonly tourSeenVersion: number | null;
  readonly dismissedInvitationVersion: number | null;
}
```

The parser accepts exact keys and bounded nonnegative integers only. Malformed,
legacy, disabled-storage, and quota paths return a safe empty record and never
throw. The key is registered in `OWNED_LOCAL_STORAGE_KEYS`, so Full reset removes
it.

Entering the Finish card records `tourSeenVersion`; Help may then say **Replay
the guided tour**. Starting from the invitation or choosing **Not now** records
its dismissed version. The invitation is suppressed when either field covers
the current tour version, is shown only when all prerequisites are ready, and
contains one line plus Start/Not now. It never stores an active scene, term,
document, corpus size, source name, or passage.

## Verification

### Unit and boundary tests

- anchor id/rule completeness and native-activation truth table;
- the fifteen resident target fixtures;
- registry ids, anchor membership, serializable copy, truthful copy matrix, and
  stage-union membership;
- reducer manual/action transitions, target qualification, return reveal,
  Reader-fence negatives, restore sequencing/deadline, and Replay revision;
- the three-action adapter and exact provider action keys;
- import boundaries for pure modules and panel launchers;
- versioned guide storage and Full reset registration; and
- a real-runtime no-durable-writes assertion added beside the existing private
  harness in `store.test.ts`. It derives fields from
  `WORKSPACE_SEMANTIC_SOURCE_KEYS`, adds `linkedSelection`, drives the three
  stage kinds including history settlement, and asserts `Object.is` identity
  before and after.

The store harness is not duplicated or extracted merely for this test.

### Browser tests

`e2e/guide.spec.ts` is explicitly added to the `webkit-compact` filename
allowlist. The local `workerQueriesAfter` helper in `reader-modes.spec.ts` moves
to `e2e/helpers.ts`; both suites import it.

Chromium covers:

- full seven-card walk and the revealed return cursor;
- card action and a single precise click/tap native activation;
- target-qualified rejection of an unrelated Reader open;
- exit, Replay, return to origin, focus, external Back, and reload;
- pending, stale, zero-occurrence, failure, worker-restart, and snapshot-change
  degradation;
- a qualified return after snapshot churn with no `chart-cursor`, proving the
  unanchored reveal still announces and reaches Finish;
- exactly one active semantic anchor;
- no active root/card artifact when no guide runs;
- modal Help precedence mid-tour;
- workspace record equality before/after return; and
- trace queries after Begin are a subset of `{ 'reader-page' }`.

Compact WebKit covers one bounded tour path rather than duplicating the full
suite: 320×568 card fit and 44px actions, Terms visible below the top card, no
page-level horizontal overflow, correct bottom lens/dock clearance, card action
on coarse input, and an available exit at 568×320 landscape.

Every product-code commit ran typecheck and the web unit suite. Browser suites
scaled with risk; full functional and compact suites ran for anchor, tour,
contextual-note, and invitation slices. The normal production build and bundle
budget ran whenever the reachable/lazy import graph changed.

### Release result

The reconciled tree passed the repository-wide typecheck, all 54 Node tests,
1,632 Vitest cases with one intentional skip, and the production bundle
contract. The entry chunk is 82,450 bytes gzip against the fixed 90,000-byte
budget.

The complete real-browser matrix then ran with one worker so performance and
keyboard results were not distorted by local contention: 280 cases passed and
18 project-specific cases were intentionally skipped across compact WebKit,
functional Chromium, and the isolated Chromium benchmark project. This includes
the full guided tour, contextual notes, invitation, compact geometry, modal and
history behavior, no-durable-write/reset contracts, the 100ms long-task gate,
and all four benchmark specs.

## Shipped commit sequence

`045b523 docs(design): define guided learning system` and
`cc13445 docs(design): plan guided learning execution` established the reviewed
authority. Product execution then landed as follows:

1. **`83a7da6 refactor(copy): say texts, not books`**

   User-visible copy and its selectors only; internal ids such as `by-book`,
   algorithms, type names, and Standard Ebooks proper names remain unchanged.
   Update the load-bearing `READY_TEXT`/`awaitReadyCount` helpers in isolation
   and run both browser projects. Review focus: no weakened waits or identifier
   rename hidden inside copy work.

2. **`4087eb6 feat(guide): declare semantic anchors`**

   Add typed anchor/activation modules, the five tour anchors, inert dispersion
   marker, root highlight rules, shared query helper, and uniqueness tests.
   Review focus: exact geometry, stacking, zero hit-testing/layout change, and
   Suspense-exclusive uniqueness.

3. **`f36da67 feat(guide): resolve a resident target`**

   Add structural context, packed-array resolver, and fifteen fixtures. Review
   focus: CSR alignment, exact precedence, density final-bucket arithmetic,
   tie rules, and pending versus unavailable truth.

4. **`cb261df feat(guide): model the guide session`**

   Add definition, three-action stage adapter, reducer, navigation classifier,
   boundary gates, and real-store durability test. Review focus: qualified
   Reader events, exact layer-prefix fence, revealed return phase, restore
   timeout, and closed authority.

5. **`4498867 feat(guide): author the guided tour`**

   Add the lazy seven-card registry and copy matrix tests. Review focus: exact
   authority copy, rate/count and exact/density branches, and absence of stage
   work from descriptive scenes.

6. **`680c718 feat(guide): run the guided tour`**

   Add provider, card, Help launcher/prerequisites, App close-and-start seam,
   compact CSS, Playwright registration, and the full tour browser spec. Review
   focus: StrictMode cleanup, Help inert settlement, stage absorption versus
   asynchronous close, focus ordering, current-step event matching, modal
   precedence, query subset, and bundle headroom.

7. **`51bd23e feat(help): add guides for this view`**

   Move shared Help content, add four note scripts, GuideLink, contextual
   anchors/links, and browser coverage. Review focus: no note stage intent, one
   shared voice, no link on the zero-occurrence Matches branch, and the narrow
   presentation-only panel boundary.

8. **`58bce34 feat(states): explain empty analytical states`**

   Inputs, zero-term Trends, and dispersion method-note improvements plus
   focused tests. Review focus: useful without guide machinery and no competing
   Terms authoring path.

9. **`cc391ea feat(guide): invite eligible readers once`**

   Add versioned storage, reset registration, invitation, Replay wording, and
   dismissal/version tests. Review focus: invitation last, exact readiness,
   privacy-safe schema, total storage failure behavior, and reset truth.

10. **`docs(design): record shipped guided learning`**

    Reconciles roadmap status, implementation commits, test gates, and final
    Opus audit. No product code.

Two focused follow-ups closed findings from exhaustive verification:

- `5379049 fix(guide): keep invitation clear of work` moved the invitation
  into ordinary Trends flow after a full browser pass exposed pointer
  interception from its first fixed-position treatment.
- `39f0f82 test(e2e): follow inline term entry`,
  `1286886 fix(matches): preserve external edge cursor`, and
  `77c4e94 test(e2e): refresh full-suite assumptions` repaired stale browser
  journeys and one genuine programmatic-scroll fence exposed by the final
  matrix.

Each commit is independently revertible through step 5. Step 6 is the runtime
hinge; steps 7 and 9 depend on it and must be reverted before it. State
explanations in step 8 remain independently useful.

## Do not implement

- a guide field in `AppState` or any `lib/store.ts` edit;
- a fourth stage intent or action method;
- any guide-attributable analysis, prefetch, worker operation, or fixture;
- a special tutorial corpus or automatic sample load;
- a CSS-structure selector, target observer, collision engine, or positioning
  library;
- a global key, focus trap, backdrop, workbench inertness, or body portal;
- autostart, dwell/idle/error triggers, progress UI, or note completion state;
- active-session persistence, telemetry, or network work;
- raising `ENTRY_GZIP_BUDGET_BYTES` to accommodate guide code;
- `?tour=` routing, the `matches-grid` anchor, later-set guides, or field-note
  `Show me` actions; or
- internal `book` identifier renaming under the user-copy commit.

## Collaboration provenance

The plan combines a local Codex implementation map with a 980-line read-only
pinned Claude Opus planning pass over the same clean tree (Parley request
`req_texttrends_guided_execution_plan_opus`, artifact
`art_sha256_652b56e40125aa3fd9376eafff626d59295bdbea911683a3134e6ad631398733`).
Codex then challenged Help inert sequencing, return-scene visibility, event
qualification, compact lens clearance, anchor stacking, panel-link boundaries,
shared Help copy, storage semantics, test-harness reuse, and two interaction
facts before making this document the execution authority. The staged document
itself is reviewed by pinned Opus before commit.
