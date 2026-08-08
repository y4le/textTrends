# Width-first workbench UX and information architecture

*Final product-design authority for the textTrends shell, analysis plate,
evidence workflow, research record, and cross-device presentation.*

**STATUS: IMPLEMENTED (2026-08-01).**

## Authority

This document supersedes earlier rail/sidebar/footer proposals. It governs the
composition shared by desktop, tablet, and phone without changing the
statistical definitions in `statistics.md` or the analysis lifecycle in
`analysis-contract.md`.

The original workbench and mobile consultations were Parley requests
`req_consult_26725b1a96acef6b` and `req_consult_9624a6ff56e2dec2`. The
width-first amendment was reviewed in the live Claude Opus session
`ses_9c70ffde897e1acd`; its controlling architecture artifact is
`art_sha256_93db65a70791b5e74115f15f0165fbb81b6f5c7f726db02a46a4388dab92fabe`.
The implemented-contract audit is request `req_consult_e2216c40ffd8046f`,
artifact `art_sha256_14362c163d0563ccb6d1a4c3097cb92d5c12c59167ef2141d5f1361f9bac8c03`.
All consultations pinned Opus with fallback disabled.

## Product principle

textTrends is a local-first reading instrument, not a panel dashboard. Its
interface should maximize the data-bearing surface and keep the chain from
question to claim to source legible:

```text
scope → terms → analysis → current evidence → retained finding
```

The Tufte-inspired rule is simple: persistent pixels must earn their place.
The graph receives width because its comparative geometry benefits from every
pixel. Controls appear near the state they govern, supporting detail moves
into layers, and prose or decoration never displaces the analytical plate.

Five distinctions must remain explicit:

- **Scope** is the text included in a computation.
- **Terms** are the authored query groups and their shown/hidden projection.
- **Focus** is the group, document, row, or position emphasized for reading.
- **Evidence** is the currently inspected source material.
- **Findings** are evidence or ranges the researcher deliberately retained.

Focus and evidence may move cheaply. They never silently change scope.

## Canonical places and navigation

There are six stable places:

| Place | Governing question | Contents |
|---|---|---|
| Corpus | What texts make up this study? | project, catalog, source repair, order, metadata, structure, corpus summary |
| Trends | Where do tracked terms occur? | full-width trend plate, chapter marks, dispersion, range selection, exact totals |
| Concordance | What passages contain the terms? | merged KWIC table, term membership, context and occurrence navigation |
| Vocabulary | What words characterize this scope? | frequency, document frequency, dispersion and richness views |
| Compare | What distinguishes explicit A and B? | keyness controls, rankings and side-restricted evidence |
| Findings | What has the researcher retained? | saved excerpts, named ranges, notes, anchor repair, save/share/conflict and provenance record |

Corpus and Findings live in the persistent **Scope** organ. Trends,
Concordance, Vocabulary, and Compare form the **Lens** organ. Compact portrait
bottom-docks the four complete Lens destinations; compact landscape uses a
left rail. There is no hamburger or analytically ambiguous “More” menu.

Routes carry presentation only:

| State | Carrier | Values |
|---|---|---|
| Place | `?p=` | `corpus`, `trends`, `concordance`, `vocabulary`, `compare`, `findings` |
| Evidence layer | `?e=` | `none`, `sheet`, `reader` |
| Source-free shared state | `#s=` | existing versioned payload |

The query string never contains terms, text, notes, or other research data.

## Governing composition

At every width the workbench is one column beneath a unified page header:

```text
textTrends + Scope + Lens
Terms bucket bar
Active analytical place, full available width
Conditional Evidence strip
```

The brand, Scope, and Lens share one header row rather than consuming two
vertical bands. Scope is a single-line local horizontal scroll port when its
facts do not fit. Compact portrait and landscape still move the Lens links to
their governed bottom or side dock without duplicating the navigation DOM.

Sheets and full-screen form layers overlay this flow. There is no permanent
desktop Query rail, Evidence sidebar, or Method footer.

This composition is width-first rather than desktop-first. It avoids three
costs of side rails:

1. query controls reduce the graph width even when the user is only reading;
2. an Evidence sidebar reserves space before evidence exists; and
3. a Method footer repeats slow-changing metadata in the highest-frequency
   workspace.

### Scope organ

Scope states the corpus, included documents/range, token count, completeness,
and anchor-review exceptions. Its corpus label opens Corpus. **Findings** is
always present and does not depend on a saved-excerpt count. **Method &
settings** on Trends, and **Method** elsewhere, opens the same contextual
sheet without promising controls that do not apply to the active analysis.

Capacity is not an ambient Scope concern. Findings displays saved-excerpt
capacity where it can be acted on.

### Terms bucket bar

The Terms bar is the cross-width interactive legend and notebook summary. It
contains a horizontally scrollable sequence of tokenized group buckets.
Every bucket provides:

- a line sample, group name, and delivered count/status;
- explicit focus;
- a shown/hidden analysis toggle;
- edit where the width can support it; and
- explicit removal.

Removal creates a bounded five-item undo stack with an explicit dismissal.
Undo restores active and solo intent where capacity still permits, but does
not preserve an old visual style-slot assignment as authority. The
notebook may hold up to 64 groups; at most five are projected into analysis.

**Add** opens a full-screen quick-add form at every width. **Manage** opens the
primary notebook list for group editing, solo controls, and larger
collections. On compact screens edit is intentionally reached through Manage
so every top-bar target remains at least 44 CSS pixels and the legend stays
scannable. Authoring layers retain drafts and valid focus through viewport and
software-keyboard changes.

The term bar persists across all six places. Reader hides it while occupying
the full viewport.

### Analysis plate

The active place owns the full inline width. Only one canonical place is
mounted. Dense tables live in named horizontal scroll regions; they are never
shrunk into illegible miniature grids. Exact values remain available when a
compact chart or focused-column table adapts its encoding.

The trend plate preserves these visual rules:

- one shared y scale across shown series;
- token-proportional book widths in declared sequence;
- a hard path break at every document boundary;
- color plus dash plus text identity, never color alone;
- direct labels where space permits;
- dispersion barcodes embedded as the plot's bottom evidence rows: one shared
  declared-sequence band in series view and one normalized band per book row
  in by-book view;
- a bounded current passage below the reading cursor; and
- exact per-book/corpus totals beneath the plot.

Pointer motion and touch reading move the cursor. In an exact barcode row,
fine-pointer hover snaps to a painted occurrence within eight horizontal
pixels; otherwise it retains the raw graph position. Density cells never
pretend to be exact hover targets. Hover does not focus a term, create a
selection, center the concordance immediately, or open Reader. The accessible
barcode summaries and occurrence steppers remain outside the chart slider. An
exact click activates only within that same tolerance; clicking farther away
keeps the raw reading position instead of jumping to remote evidence.
Touch dragging does not accidentally create a range: range authoring is an
explicit mode with visible handles, controls, Cancel, and Use range.

## Evidence without a sidebar

Evidence is conditional. Before a passage or comparison occurrence exists,
it occupies no layout space. Once evidence exists, a full-width in-flow strip
appears beneath the active plate. It shows a short source excerpt and the
minimum actions appropriate to the width.

- Regular and wide: **Save excerpt**, **Read**, **Inspect**, **Method**.
- Compact: **Save excerpt** and **Inspect**. Read is the first navigation action
  inside the identical Evidence sheet; Method remains in the persistent Scope
  organ.

Compact disclosure is acceptable because the persistent strip remains a
reading cue with the one irreversible research act available at the moment of
noticing. Read tolerates one further tap because it navigates to another
surface. The two visible targets remain at least 44 pixels and do not steal
graph width or create horizontal overflow.

**Inspect** opens the one Evidence sheet at `half` detent. `peek`, `half`, and
`tall` controls are explicit, with `peek` non-modal and the other detents
modal. Evidence and Method replace the content of this same history layer;
they do not stack competing sheets. Closing returns focus to the external
control that opened the layer.

The Evidence sheet may contain the complete bounded passage, current
comparison occurrences, Save excerpt, Read, and capacity refusal. It never
shows a “recent pins” list; retained material has one permanent home in
Findings.

## Why saved excerpts exist

Saved excerpts are not a sidebar bookmark collection. They are durable
research records anchored to source characters and the document text hash.
They justify their state through workflows that current evidence alone cannot
serve:

1. **Compare distant moments.** A reader saves passages from different books
   or narrative positions, then reviews them together after the graph cursor
   has moved. Captured query tracks preserve what was being investigated.
2. **Build an evidence packet.** A reader adds concise notes, reopens the
   exact source in Reader, and exports a governed local research record.
3. **Resume an interrupted argument.** Durable anchors and named ranges
   restore across reloads. If source identity changes, the item moves to an
   explicit mismatch-review workflow instead of silently pointing elsewhere.
4. **Audit a claim.** Findings connects the retained excerpt, query context,
   selection, method, and provenance so another session can trace an
   interpretation back to its basis.

Saving is always an explicit verb—**Save excerpt**—never a side effect of
hovering, tapping the chart, opening Reader, or focusing a row. Duplicate
locations focus the existing record. The bounded limit is eight and is shown
as `n saved · limit 8` in Findings. At capacity the still-focusable action
explains the refusal and links to Findings for removal.

Feedback belongs to the surface whose Save action was invoked. That ownership
is explicit resident state, not inferred from viewport width or from the mere
presence of a Reader layer: an Evidence-strip save reports in Evidence, and a
Reader save reports in Reader. Findings owns origin-free record-management
feedback. Only that owner renders the message as a live region. If a non-modal
Method peek temporarily hides Evidence while its keyboard shortcut remains
operable, a bounded Evidence feedback row remains as the owner of last resort.
Navigating the Reader clears its prior feedback without erasing another
surface's message.

If future product evidence shows that users do not use notes, cross-position
comparison, resume, export, or audit, saved excerpts can be reconsidered.
Their justification is the durable workflow, not the former pane.
Saved excerpts and source text stay on device and are excluded from share
fragments. That privacy boundary is why Findings is a permanent local place in
Scope rather than a shareable evidence surface.

## Method and trend settings

The graph carries one restrained current-method caption, for example:

```text
rate per 100,000 tokens · 1,000 tokens per bin · 5-bin rolling mean · raw behind
```

Its **settings** link opens the shared Method & settings sheet. Other places
open the same sheet from Scope. Method/provenance remains copyable there and
does not consume footer space.

Trend controls deliberately separate result geometry from resident
presentation.

### Result geometry

Changing geometry reissues only baseline and selected trend lanes. It does
not reissue KWIC, dispersion, passage, inventory, or unrelated analyses.

| Mode | Bounds | Meaning |
|---|---:|---|
| Equal bins per book | 4–200 | each non-empty selected document contributes the requested row count |
| Fixed tokens per bin | 250–50,000 | each document contributes `ceil(tokens / size)` rows; the final row may be shorter |

A request may produce at most 4,000 rows. Zero-token documents contribute
zero rows. Full-document extents learned from either inventory or a successful
trend are retained for the current snapshot, so a later range-scoped inventory
cannot hide the extents of omitted documents even if every current trend lane
has failed. The form narrows the base bounds, states the estimated row count,
and refuses an unsatisfiable value before it can replace a good result.
Restored or shared preferences are clamped to the nearest valid value as soon
as current-corpus extents are resident. If their bin mode cannot fit but the
other mode can, the application switches to a viable default in that mode. It
announces every automatic adjustment and persists the adjusted value as the
current preference. A shell-level polite live region announces the adjustment
when it happens; Method & settings retains the same explanation visibly. If
neither mode can fit, Method & settings says so and no invalid replacement is
issued. Kernel failures still surface their exact message. Results echo the bin
specification and a `rowOffsets` prefix array;
rendering, hit testing, keyboard PageUp/PageDown, and selection geometry never
assume a dense `document × bin-count` rectangle.

### Resident presentation

Changing presentation performs no worker query:

- **Rate** denominator: 1,000, 10,000, or 100,000 selected tokens.
- **Smoothing:** none or a centered 3/5/7/9-bin token-weighted mean.
- **Raw behind:** available only when smoothing is on.
- **Count per bin:** a separate unsmoothed view; rate controls are disabled.

Smoothing is plotted, not written back into raw results. It never crosses a
document boundary, never bridges a zero-denominator gap, shrinks its window at
document edges, and requires at least `ceil(window / 2)` usable bins. The raw
count and true selected-token denominator remain available for exact totals
and provenance. Where an edge or adjacent gap supplies too few contributors,
the plotted point remains exact and unsmoothed; exported provenance names this
exception.

`texttrends/trend-view/2` durably stores and shares bin geometry, measure,
denominator, smoothing, raw visibility, mode, chapter marks, and focused
document. Legacy `/1` records and share links migrate on read.

## Reader

Reader has one presentation: a full-viewport reading surface at every width.
It hides the workbench chrome, Terms bar, Evidence strip, and Method surface;
the prose pane is its only vertical scroll container, and the outer document
is locked while Reader is open. Reader retains the same identity and DOM across
viewport changes and exposes Save excerpt, occurrence navigation, page status,
a live confirmation/refusal region, and an explicit Back path.

## Responsive and input contracts

Composition breakpoints are presentation inputs only:

- compact: below 600 CSS pixels;
- regular: 600–1023 pixels;
- wide: at least 1024 pixels.

Pointer precision is orthogonal to width. Coarse input raises interactive
targets to 44 pixels without inflating dense analytical table rows. Editable
inputs render at least 16px text to avoid mobile-browser zoom. Safe-area and
visual-viewport insets govern bottom navigation, sheets, full-screen forms,
and software-keyboard clearance.

Viewport changes never alter corpus, snapshot, scope, notebook, shown/KWIC
membership, trend settings, linked range, comparison sides, durable findings,
research revision, or reader place. They do not issue analysis. Open drafts,
sheets, and reader state transform in place with one authoritative DOM.

At 320px the page itself must not scroll horizontally. Data ports may scroll
locally and must have accessible names.

## Accessibility and history

- Scope, Lens, Terms, active place, Evidence, Method, sheets, forms, and data
  ports have stable accessible names.
- Every icon-only action has a text alternative and visible focus.
- Series identity is redundant across color, dash, and label.
- Range handles have adjacent button equivalents.
- Full-screen forms and modal sheet detents trap focus; non-modal `peek` does
  not inert the workbench.
- Escape and Back close exactly one governed layer. Replacing Evidence with
  Method preserves history depth and the external return-focus owner.
- Browser shortcuts such as Cmd/Ctrl+S are not intercepted.
- Reduced motion removes nonessential transitions without removing state
  changes or direct controls.

## Persistence and identity

Research restore applies notebook and trend-view state before analysis
continues. A null focused series remains null; adoption does not invent a
focus. The deletion undo stack is transient and clears when project,
research, or shared-state identity changes.

Saved excerpts and named ranges are private durable records. Share fragments
remain source-free and bounded. Import is always preview then explicit
replace. Two-tab compare-and-swap conflicts require explicit overwrite.

## Release gates

The design is complete only while these behavioral gates hold:

1. no page-level horizontal overflow at 320, 390, 768, and 1440px;
2. one Terms bar and one active place at every width;
3. no persistent wide side rails or Method footer;
4. conditional Evidence strip and one replaceable Evidence/Method sheet;
5. 44px compact/coarse controls and keyboard-operable equivalents;
6. viewport transforms issue no analysis and retain drafts/focus in the
   governed layer;
7. fixed-token variable-row geometry renders, hits, and selects correctly;
8. bin changes issue only trend work; display changes issue none;
9. trend-view `/1` migration and `/2` persistence/share round-trip;
10. explicit save, duplicate, capacity, restore, mismatch, remove, and
    provenance workflows for saved excerpts;
11. Reader remains full-viewport and outer-scroll-locked at every width class;
    and
12. Chromium functional plus compact WebKit suites pass from the
    production-shaped build.

These are product contracts, not screenshot approvals. Visual refinement may
continue as long as the distinctions, geometry, evidence path, exact values,
and mobile completeness remain intact.
