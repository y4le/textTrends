# Width-first workbench UX and information architecture

*Current product-design authority for the textTrends shell and cross-device
presentation.*

**STATUS: IMPLEMENTED (updated 2026-08-13).**

## Product principle

textTrends is a local-first reading instrument, not a panel dashboard. Its
interface maximizes the data-bearing surface and keeps the path from a question
to the source legible:

```text
corpus scope → terms → analysis → matches or reader
```

Persistent pixels must earn their place. Controls appear near the state they
govern, supporting detail moves into governed layers, and prose or decoration
does not displace the analytical plate.

Four distinctions remain explicit:

- **Scope** is the text included in a computation.
- **Terms** are the authored query groups and their shown/hidden projection.
- **Focus** is the group, document, row, or position emphasized for reading.
- **Reader position** is transient navigation, never durable research data.

## Canonical places and navigation

There are five stable places:

| Place | Governing question | Contents |
|---|---|---|
| Inputs | What texts make up this study? | active order, local library, acquisition, full-text measurements and term counts |
| Trends | Where do tracked terms occur? | trend plate, dispersion, linked range |
| Matches | What contexts contain the terms? | continuous corpus-order grid, term membership, context, occurrence navigation |
| Vocabulary | What words characterize this scope? | frequency, document frequency, dispersion, richness |
| Compare | What distinguishes explicit A and B? | two-sided text profile and divergence, keyness controls, effect intervals and G² rankings, exact counts, per-side dispersion, row detail |

Compare reports whole-distribution vocabulary divergence and a two-sided text
profile above streamed log-ratio rankings. A gear at the top right opens one
settings page for sorting, per-side ranking direction, filters, and optional
95% effect-interval whiskers (hidden by default). Exact intervals remain in
term detail alongside signed G², the underlying counts, document ranges, and
per-side dispersion. A browser view retains at most the first 50,000 ranks;
the visible progress line says when that display bound is reached so readers
can refine the filters for deeper ranks.

Inputs, Trends, Matches, Vocabulary, and Compare form one ordered
**Workbench sections** tab list, with Inputs first. Compare is available only
when at least two texts are active. Compact portrait bottom-docks every
available destination; compact landscape uses a left rail. There is no
hamburger or analytically ambiguous “More” menu.

The query string owns one presentation key:

| State | Carrier | Values |
|---|---|---|
| Place | `?p=` | `inputs`, `trends`, `matches`, `vocabulary`, `compare` |

Terms, source text, and workspace data never enter the query string.
When fewer than two texts are active, a `compare` route is rewritten in place
to Inputs for an empty corpus or Trends for a single text.

## Governing composition

At every width the workbench is one column beneath a unified page header:

```text
yalethom.as/textTrends + Scope status + Workbench sections
Active analytical place, full available width
── fixed dock ──────────────────────────────
Terms bucket rail
Corpus-reading footer
```

The publisher signature is the first header item and links to
`https://yalethom.as/` in the current context. The brand, Scope status, and
Workbench sections share one header row. The selected workbench tab supplies
the active place name; the analytical surface does not repeat it as an interior
title. Scope is
a single-line local horizontal scroll port when its facts do not fit. Compact
portrait wraps the publisher signature once, after its slash, to preserve that
Scope port. Compact portrait and landscape move the Workbench section links to
their governed bottom or side dock without duplicating the navigation DOM.

Full-screen modal panes and form layers overlay this flow. There are no permanent
desktop side rails. One fixed dock carries the authored Terms rail above the
transient source position, passage, trend, progress, and dispersion context.
**Method & settings** and the shortcut reference use the same full-screen pane frame;
governed row details remain separate history layers.

### Scope organ

Scope states the corpus, included documents or linked range, token count, and
completeness. Its corpus label opens Inputs. **Method & settings** on Trends,
and **Method** on Vocabulary and Compare, opens the same contextual pane;
Inputs and Matches omit it. Compare keeps its immediate profile, divergence,
intervals, dispersion, and row evidence in the governed analysis surface,
while Method retains versioned provenance, limitations, and result export.

### Terms rail

The Terms rail is the cross-width interactive legend and notebook summary. Each
group bucket provides a line sample, name, delivered count or status, an explicit
shown/hidden analysis toggle, edit where width permits, and removal. There is no
selected term: every shown term has equal visual weight and participates in
occurrence navigation. To isolate one term, the reader hides the others.

Removal creates a bounded five-item undo stack. The notebook may hold up to 64
groups; at most five are projected into analysis. **Add** opens quick entry and
**Manage** opens the primary notebook editor. The rail is fixed directly above
the reading footer and remains one row at every width. Buckets scroll
horizontally while Add and Manage stay pinned. On compact screens edit and
removal are intentionally reached through Manage, the visible Terms label is
omitted, and the remaining rail targets stay at least 44 CSS pixels. A removal
Undo notice opens upward from the dock rather than covering the reading lane.

Manage is a full-screen editor. Reordering begins only from the leading drag
handle and keeps the source plus insertion position visible. Mouse and touch
share the pointer path; holding near either scrolling edge advances the editor
and recomputes the insertion position. A second touch cancels the reorder, and
pointer cancellation clears every drag affordance. The same handles retain a
Space/Enter grab-and-drop path with Up/Down movement for keyboard users.

Each term editor uses the platform's native color input and a separate line
pattern control. Automatic colors form a theme-aware maximin palette: each
active automatic term has a unique slot, and the active automatic set maximizes
its minimum perceptual distance internally while retaining GraphTV's spot-color
exclusion. Choosing a custom color stores its lowercase six-digit hex value and
keeps that color fixed across themes; active manual overrides reserve the same
0.15 OKLab clearance used by GraphTV. Visual separation takes priority over
keeping an automatic term at its previous rendered color. The editor warns,
without blocking or changing the choice, when a custom color falls below 3:1
contrast against either supported background.

The Terms rail persists across all five places, including before a usable
snapshot exists; with no corpus the dock honestly collapses to the Terms-only
rail. Reader hides the complete dock while occupying the full viewport.

## Analysis plate

Only one canonical place is mounted, and it owns the full inline width. Dense
tables live in named horizontal scroll regions; they are never shrunk into
illegible miniature grids. Exact values remain available when compact charts
adapt their encoding.

The trend plate preserves these rules:

- one shared y scale across shown series;
- token-proportional book widths in declared sequence;
- a hard path break at every document boundary;
- color plus dash plus text identity, never color alone;
- direct labels where space permits;
- dispersion rows embedded at the bottom of the plot;
- linked-range selection by mouse drag or keyboard, plus two-touch selection
  and a press-hold-then-tap alternative on touch screens; and
- exact graph values through the method/detail surfaces.

Pointer motion and touch reading move a transient cursor. Mouse and pen hover in
an exact barcode row snap only within the specified pixel tolerance; touch
stays on its direct raw position. This is decided per pointer event, so an iPad
trackpad retains precise hover and snapping while the same device keeps its
large touch controls. Density cells never pretend to be exact targets.
Clicking an exact occurrence centers Matches; opening source text is an
explicit action from Matches or the global reading footer.

The fixed reading footer is the lower lane of the dock in all five workbench
places and is absent in Reader. Its one corpus-order axis aligns a clipped
current passage, thin all-book sparkline for every shown query, corpus progress,
document boundaries, and the resident multi-track dispersion barcode. The
complete dock sits above the compact portrait Workbench sections dock and to the right of the
compact-landscape rail. The source line is a transient `reader-page/1` window.
Pointer samples are frame-coalesced;
its independent single-flight lane issues the newest unserved position
immediately, retains the last authenticated page while the next is in flight,
and saves no text or range. Absolute hover continues to seek the shared corpus
axis. A mouse press-and-drag instead acts as an explicit reading
shuttle: horizontal distance from the press point controls a bounded token
rate, the truthful cursor advances through declared book order while the
pointer is held, and release pauses at the exact displayed token. This
time-based gesture can traverse the whole corpus without being limited by a
many-tokens-per-pixel absolute scale; at slower rates it exposes each successive
token, while the maximum rate is intentionally a skim. An unmoved click keeps
its existing barcode/raw activation. Touch instead uses direct manipulation:
a tap jumps to that corpus position, a horizontal drag scrubs the absolute
axis with an emphasized live cursor, and a vertical drag remains page-owned.
Additional simultaneous contacts cancel the footer gesture rather than
starting the mouse shuttle, and touch-generated double-clicks never open
Reader. Mouse or pen
hover requires a brief entry dwell before it moves global focus and snaps to a
nearby exact barcode occurrence; density hover remains at the raw corpus
position. Any available coarse input keeps a 44px strip and a 44px passage
action that opens Reader, even after mouse interaction. Double-clicking any
non-control footer area opens Reader directly at
that corpus position. In an exact barcode lane, a nearby occurrence supplies
the target; in a density lane, Reader stays at the raw clicked position because
an aggregate midpoint is not an exact source reference. The coarse passage
button remains a direct action for the current position.

The Trends and footer barcodes share one captured-target resolver, including
the exact proximity threshold, overlap tie-break, document ownership, and
density midpoint rules. Density midpoints may center Matches, but neither
barcode presents them as exact Reader occurrences. A footer density
double-click supersedes its constituent bucket clicks so Matches, Reader,
and the reading cursor settle on the same raw corpus position.

With the footer position focused, `h`/`l`, Left/Right, and PageUp/PageDown page
backward/forward through the clipped source lane. A page is derived from the
authenticated token boundaries actually visible at the current width and
crosshair position, rather than from a trend bin or average token width. Each
successive lane overlaps its predecessor by one boundary token when possible;
a single-token lane advances adjacently instead of livelocking, so repeated
navigation exposes the declared corpus without a source gap. `H`/`L` and
Shift+Left/Shift+Right move one token. Home/End use the corpus endpoints, and
Enter or `o` opens Reader at the current position. Pointer seeking and the
drag shuttle restore centered passage alignment.

## Vocabulary

Vocabulary is a progressively loaded, viewport-filling ranking table with the
same sticky header, zero-minimum column partition, and locked-by-default resize
controls as Matches. Worker responses remain small chunks, but scrolling can
reach every matching type without a page control or overall result window;
already authenticated rows stay resident while the next chunk loads. Every
header sorts its displayed measure. Only the active sort header is bold and
shows its direction arrow. Term order is case-insensitive lexicographic order.
Explanations for document frequency, rate, token class, DP, and normalized DP
are available while widths are locked and disabled while the separators are
adjustable. A disclosed row adds filtered rank, corpus share, token interval,
document coverage, and the mean count in containing documents without issuing
another analysis query.

A case-sensitive regular-expression field above the table filters terms live
before ranking and paging. Invalid expressions retain the preceding valid
result until the expression is corrected, and a trailing × clears a nonempty
filter immediately.

The scrollport and row controls share one keyboard model: `j`/`k` and
Down/Up move one row, Ctrl+D/Ctrl+U move half a visible page, and Enter toggles
the selected row detail. Navigation scrolls the newly selected row into view
and naturally triggers the next result chunk near the loaded edge.
The scrollport claims focus when Vocabulary is entered from its tab, route, or
workbench shortcut, so those row commands work without a preparatory click.
Clicking any cell in a primary row toggles that row's disclosure.

## Matches and direct reading

Matches is the canonical context surface. It presents every enabled-term
occurrence in corpus order as one continuous logical grid while keeping only a
bounded window of fixed-height rows in the DOM. Right-aligned left context and
the fixed node track retain stable scan geometry. Bounded worker windows begin
with 64 word-like tokens on each side; exceptionally wide context tracks grow
that reserve from derived geometry, while ordinary viewport changes remain
presentation-only. Token position has its own final column. The book column is
absent for a one-book corpus; node colour remains the series cue without
repeating the node's series identity in a separate trend column.

Every rendered column partitions exactly the grid's visible inline size; the
Matches has no horizontal scroll axis. Left and right context are the only
elastic tracks. Their stored values are a scale-independent ratio, so a `1:2`
split remains `1:2` when the port grows or shrinks. Node, book, and token
keep their preferred character widths while the context tracks absorb viewport
changes. If a viewport is too narrow even for those preferences, fixed tracks
may shrink rather than creating overflow.

Mentions of any enabled term inside left/right context use the same treatment
as occurrence marks in Reader: the contributing series colour as a 20% wash
and a two-pixel bottom rule, with marked text lifted from muted context to the
normal foreground colour. Overlaps deterministically use the first
contributing track's colour. The emphasis remains non-interactive and does not
change context text, row height, selection semantics, or the single-wrapper
geometry used for right-aligning left context. Phrase and folded-match spans
come from the shared occurrence projection rather than a second browser-side
text match.

Reset records explicit automatic sizing for node and book instead of inferring
it from equality with a magic width. Node fits observed node text. Token fits
the largest displayed position: below the wide threshold it shows only `xxx`
from `xxx / yyy`, with the complete position retained as its title; wide ports
show the complete value. An automatic book uses a three-character numbered key
below the wide threshold and fits the complete `(n) Book title` on a wide port;
an explicit book width is unchanged by that threshold. These decisions use the
measured Matches port, not the window.
Column dividers remain visible as neutral rules. The fixed header control accents
and unlocks their session-local resize handles; locked is the default whenever
the surface mounts. Left context preserves its tail, while node, right context,
and metadata preserve their beginnings when clipping is unavoidable.

The grid's midpoint rule is shared with the reading cursor. Scrolling moves the
cursor in the footer and Trends, while scrubbing either shared axis moves the
Matches scroll position. The visible “now” line remains halfway through the
actual grid viewport, excluding the page header, fixed dock, safe area, and
on-screen keyboard. The physical scroll plane is capped for browser stability;
sparse corpus-order landmarks and the resident exact rows map that plane onto
the full logical result. Corpus endpoints are sentinels, so the first and last
occurrence centers remain half a row pitch inside the scroll range rather than
standing in for the beginning or end of the corpus.

Linked analytical ranges never filter or reorder Matches and never cause a
Matches query. Rows inside the range receive a secondary highlight while
the grid continues to represent the complete enabled-term result.

Activating a match opens Reader directly. Exact barcode occurrence
controls in Trends open Reader. The footer's barcode centers Matches in
place, while its current passage and a footer double-click open Reader at the
current or clicked position.

## Method and trend settings

The graph carries no settings caption or control. The Scope organ opens the
full-screen Method & settings pane. Settings and an always-expanded analysis
record share the pane without consuming permanent workbench space; provenance
and resident results remain visible and copyable there.

Changing result geometry reissues only baseline and selected trend lanes.
Changing resident presentation performs no worker query. Smoothing never
crosses document boundaries or bridges zero-denominator gaps, and exact raw
counts remain available for totals and provenance. Rates use the fixed,
explicit 10,000-token denominator; there is no denominator preference.

Settings are a draft until Apply. A successful Apply closes the pane and
restores focus to the Scope control; an unchanged or rejected draft remains
open with an explicit status. Restore defaults changes only the draft, while
close and Escape discard it. Method is transient UI state and never adds,
replaces, or consumes a browser-history entry.

## Reader

Reader is a full-viewport reading surface at every width. It hides the
workbench chrome and Terms bar, locks both prose and the outer document against
vertical scrolling, and fits one visual page from the real rendered text. It
retains one identity and DOM across viewport changes and exposes page
navigation, occurrence navigation, page status, query highlights, and an
explicit Back path.

Reader position and highlights are transient. The workspace contains notebook
and analysis-view settings, not reading position.

Reader owns the reading keys while it is open: `h`/Left/PageUp and
`l`/Right/PageDown use its fitted previous and next token boundaries, Home/End
request the document boundaries, and Escape follows the same governed Back path
as the visible control. Resize and font settlement preserve the current start
token and deliberately recompute later boundaries for the new geometry.

`w` and `b` move to the next and previous exact occurrence of any shown term
across the full declared corpus. Overlapping raw matches at one token start are
one stable reading stop with their member provenance combined; density barcode
buckets and linked analytical ranges never approximate or narrow this action.
The shared scrub position and Matches center follow the result, and an open
Reader replaces its current page around that exact occurrence.

## Keys and gestures

Vim and conventional bindings are simultaneous during ordinary navigation.
Explicit interaction modes are the narrow exception: at most one is active,
and a visible non-modal indicator always names it and provides a touch/coarse
entry and exit path. Temporary corpus Find is the first such mode. A central
registry is the source for event matching,
`aria-keyshortcuts`, and the contextual shortcuts reference opened by `?` or
the visible Shortcuts control. The reference interleaves keyboard and touch
gestures under the surfaces they govern. Workbench help includes Terms, Trends,
and its persistent reading footer, while Reader help contains only Reader-owned
actions.

Focused controls act first. A local handler that consumes an event prevents the
root dispatcher from reinterpreting it, and text inputs, selectors, editable
content, unrelated browser modifier chords, and IME composition retain their
native behavior. The explicit `Ctrl/Cmd-F` and `Ctrl/Cmd-G` Find chords are the
narrow exception. Shortcut help is a transient modal rather than navigable
research state; closing it with Escape or its visible control restores the
invoking focus without adding browser history.

Two-key Vim sequences expire after 900ms and never create a persistent mode.
`gi`, `gt`, `gm`, and `gv` go to Inputs, Trends, Matches, and Vocabulary;
`gd` goes to Compare when at least two texts are active and otherwise announces
why it is unavailable. `gf` focuses the reading footer and `gq` focuses the
first term visibility control in the fixed rail without scrolling the workbench.

`/` and `Ctrl/Cmd-F` open temporary corpus Find. On the workbench Find replaces
the whole Terms rail with a `Find` label, a wide query field, submit action,
same-sized ←/→ controls, and a matching clear/close ×. It accepts the Terms editor's
comma-authored aliases (words, phrases, and one-ended wildcards) as OR
alternatives in one temporary term and does not mutate the notebook unless the
explicit Save action is used. The first
alias names that term. Once submitted, its identity owns the barcode/totals,
Reader marks, Matches, and navigation. From the moment Find opens, the main and
footer trend graphs and barcode rows retain the durable terms as readable,
dimmed, non-interactive context. A submitted Find paints above that context as
a wider line with a background halo and as a full-height foreground barcode;
only Find participates in barcode hit-testing and totals. Find and its ghost
context use one honest y-scale, and the graph holds until all non-failed
contributors to that scale settle. Hover readouts remain Find-only, while the
accessible graph name explicitly identifies the durable lines as de-emphasized
context. The durable comparison returns at normal emphasis on exit. Enter seeks
forward; `n`/`Ctrl/Cmd-G` and `p`/`Ctrl/Cmd-Shift-G` cycle through exact starts.
After the matching window lands, the explainer strip shows the current
one-based match and exact total as `x/y`; the indicator is absent while a seek
is pending. The ready explainer is actionable: Enter opens Reader at that hit.
Save promotes the submitted aliases into one durable, active term and is
disabled when the active comparison or saved notebook is at capacity.
Escape or × clears the transient query and restores invoking focus. Reader has
no Terms rail, so the same controls use the keyboard-safe floating placement.
While Find is already open, `Ctrl/Cmd-F` focuses the query field and selects
its complete draft so a replacement can be typed immediately.

Within the
Workbench sections, `h`/`l` and Left/Right move horizontal focus; tab focus does not
activate a destination until the link is invoked. With at least two active
texts, `v` on the Trends scrubber switches the visible combined/separate
presentation without issuing analysis, alongside its existing Arrow, Page,
Home/End, and range-selection keys.

On Trends, reading-footer shortcuts are also page fallbacks; the user does not
need to focus the footer before reading. A focused local control still wins:
the Trends scrubber keeps Arrow, Page, and Home/End movement and an active range
keeps Enter/Escape. Otherwise `h`/`l`, `H`/`L`, `w`/`W`, and `o` or Enter use
the same footer actions and source-honest passage cursor. Native Enter on a link
or button remains activation, never a Reader shortcut.

Result tables share one row-navigation contract without replacing their native
table semantics. One existing row disclosure or open control is in the Tab
order at a time; `j`/`k` and Down/Up move one row, PageDown/PageUp move by the
visible row count, Ctrl+D/Ctrl+U move by half that count, and Home/End clamp to
the first and last row. Enter keeps the control's native open/toggle behavior.
Escape closes an open row detail first;
from a closed row it returns focus to the table port. Focus movement never
changes analysis scope or issues work.

The virtual Matches uses the same movement keys through one focusable ARIA
grid with `aria-activedescendant`; its off-screen row buttons stay outside the
Tab order. Moving beyond the resident window requests bounded rows around the
new rank, Enter opens the active occurrence in Reader, and Reader Back restores
focus to the stable grid. Escape leaves row navigation by blurring the grid.
While column adjustment is unlocked, each vertical separator is an additional
local keyboard widget: Left/Right change one character, Shift+Left/Right change
eight, Home/End use the column limits, Enter resets that column, and Escape
cancels an active drag or locks the widths. These local events never bubble into
row navigation. Mouse, pen, and touch share pointer capture on the separators;
cancelled or lost capture restores the committed width.

## Responsive, accessibility, and history contracts

- Compact is below 600 CSS pixels; regular is 600–1023; wide is at least 1024.
- Pointer precision is orthogonal to width. Coarse input raises interactive
  targets to 44 pixels without inflating dense table rows.
- Editable compact inputs render at least 16px text.
- At 320px the page itself does not scroll horizontally; named data ports may.
- Viewport changes never alter corpus, scope, notebook, linked range,
  comparison sides, persisted views, or Reader identity and issue no analysis.
- Full-screen forms and utility panes trap focus and inert the workbench.
- Escape closes one transient pane and restores its invoking focus. Back closes
  exactly one governed history layer; utility panes do not participate in Back.
- Browser save shortcuts are not intercepted.
- Reduced motion removes nonessential transitions without removing state.

## Persistence and release gates

Workspace restore applies notebook and analysis-view state before queries
continue. The deletion undo stack and Reader navigation are transient. Local
files are deduplicated by content identity; workspace writes are
last-write-wins, with no multi-tab edit model.

The design remains complete while these gates hold:

1. no page-level horizontal overflow at 320, 390, 768, and 1440px;
2. one Terms rail and one active place at every width;
3. no persistent side rails beyond the transient corpus-reading instrument;
4. 44px compact/coarse controls and keyboard-operable equivalents;
5. viewport transforms issue no analysis and retain governed drafts and focus;
6. trend result-geometry changes issue only trend work;
7. direct Matches/barcode-to-Reader navigation stays snapshot-bound;
8. the fixed dock reserves its combined height before the reading footer mounts,
   so Terms does not move when a chunk or first snapshot arrives;
9. Reader remains full-viewport, page-fitted, and scroll-locked at every width; and
10. Chromium functional plus compact WebKit suites pass from the
    production-shaped build.
