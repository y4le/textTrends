# Width-first workbench UX and information architecture

*Current product-design authority for the textTrends shell and cross-device
presentation.*

**STATUS: IMPLEMENTED (updated 2026-08-07).**

## Product principle

textTrends is a local-first reading instrument, not a panel dashboard. Its
interface maximizes the data-bearing surface and keeps the path from a question
to the source legible:

```text
corpus scope → terms → analysis → concordance or reader
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
| Catalog | What texts make up this study? | local library, active order, book measurements, exact totals |
| Trends | Where do tracked terms occur? | trend plate, dispersion, linked range |
| Concordance | What contexts contain the terms? | merged KWIC table, term membership, context, occurrence navigation |
| Vocabulary | What words characterize this scope? | frequency, document frequency, dispersion, richness |
| Compare | What distinguishes explicit A and B? | keyness controls, effect and G² rankings, exact counts, row detail |

Compare reports log-ratio effect alongside signed G² and the underlying counts
and document ranges. No confidence intervals are available; the interface says
so rather than implying precision the analysis contract does not provide.

Catalog is reached through the **Scope** organ. Trends, Concordance, Vocabulary,
and Compare form the **Lens** organ. Compact portrait bottom-docks the four Lens
destinations; compact landscape uses a left rail. There is no hamburger or
analytically ambiguous “More” menu.

The query string owns one presentation key:

| State | Carrier | Values |
|---|---|---|
| Place | `?p=` | `catalog`, `trends`, `concordance`, `vocabulary`, `compare` |

Terms, source text, and workspace data never enter the query string.

## Governing composition

At every width the workbench is one column beneath a unified page header:

```text
yalethom.as/textTrends + Scope + Lens
Active analytical place, full available width
── fixed dock ──────────────────────────────
Terms bucket rail
Corpus-reading footer
```

The publisher signature is the first header item and links to
`https://yalethom.as/` in the current context. The brand, Scope, and Lens share
one header row. The selected Scope or Lens control supplies the active place
name; the analytical surface does not repeat it as an interior title. Scope is
a single-line local horizontal scroll port when its facts do not fit. Compact
portrait wraps the publisher signature once, after its slash, to preserve that
Scope port. Compact portrait and landscape move the Lens links to their
governed bottom or side dock without duplicating the navigation DOM.

Full-screen modal panes and form layers overlay this flow. There are no permanent
desktop side rails. One fixed dock carries the authored Terms rail above the
transient source position, passage, trend, progress, and dispersion context.
**Method & settings** and the shortcut reference use the same full-screen pane frame;
governed row details remain separate history layers.

### Scope organ

Scope states the corpus, included documents or linked range, token count, and
completeness. Its corpus label opens Catalog. **Method & settings** on Trends,
and **Method** elsewhere, opens the same contextual pane.

### Terms rail

The Terms rail is the cross-width interactive legend and notebook summary. Each
group bucket provides a line sample, name, delivered count or status, explicit
focus, a shown/hidden analysis toggle, edit where width permits, and removal.

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
pattern control. Existing palette colors remain theme-aware; choosing a custom
color stores its lowercase six-digit hex value and keeps that color fixed
across themes. The editor warns, without blocking or changing the choice, when
a custom color falls below 3:1 contrast against either supported background.

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
Clicking an exact occurrence centers the concordance; opening source text is an
explicit action from Concordance or the global reading footer.

The fixed reading footer is the lower lane of the dock in all five workbench
places and is absent in Reader. Its one corpus-order axis aligns a clipped
current passage, thin all-book sparkline for every shown query, corpus progress,
document boundaries, and the resident multi-track dispersion barcode. The
complete dock sits above the compact portrait Lens dock and to the right of the
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
density midpoint rules. Density midpoints may center Concordance, but neither
barcode presents them as exact Reader occurrences. A footer density
double-click supersedes its constituent bucket clicks so Concordance, Reader,
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

## Concordance and direct reading

Concordance is the canonical context surface. Its aligned table centers the
node column and right-aligns left context; its wrapped view keeps complete
contexts readable. The final source-position field shows `book · token / total`
for multi-book corpora and `token / total` when only one book is present.

Activating a concordance node opens Reader directly. Exact barcode occurrence
controls in Trends open Reader. The footer's barcode centers Concordance in
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
counts remain available for totals and provenance.

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

`w` and `W` move to the next and previous exact occurrence of the focused
active term across the full declared corpus. If no term is focused, the first
active term becomes the focus. Overlapping raw matches at one token start are
one stable reading stop with their member provenance combined; density barcode
buckets and linked analytical ranges never approximate or narrow this action.
The shared scrub position and Concordance center follow the result, and an open
Reader replaces its current page around that exact occurrence.

## Keyboard model

Vim and conventional bindings are simultaneous; there is no keyboard mode to
enter or remember. A central registry is the source for event matching,
`aria-keyshortcuts`, and the contextual shortcuts reference opened by `?` or
the visible Shortcuts control. Workbench help includes its persistent reading
footer, while Reader help contains only Reader-owned actions.

Focused controls act first. A local handler that consumes an event prevents the
root dispatcher from reinterpreting it, and text inputs, selectors, editable
content, browser modifier chords, and IME composition retain their native
behavior. Shortcut help is a transient modal rather than navigable research
state; closing it with Escape or its visible control restores the invoking
focus without adding browser history.

Two-key Vim sequences expire after 900ms and never create a persistent mode.
`gc`, `gt`, `gk`, `gv`, and `gd` go to Catalog, Trends, Concordance,
Vocabulary, and Compare; `gf` focuses the reading footer and `gq` focuses the
current active term in the fixed rail without scrolling the workbench.
`[t`/`]t` and `[b`/`]b` clamp through active terms and
ready books, with a polite boundary announcement. Within the Terms and Lens
organs, `h`/`l` and Left/Right move horizontal focus; Lens focus does not
activate a destination until the link is invoked. On the Trends scrubber, `v`
switches series/by-book presentation without issuing analysis, alongside its
existing Arrow, Page, Home/End, and range-selection keys.

On Trends, reading-footer shortcuts are also page fallbacks; the user does not
need to focus the footer before reading. A focused local control still wins:
the Trends scrubber keeps Arrow, Page, and Home/End movement and an active range
keeps Enter/Escape. Otherwise `h`/`l`, `H`/`L`, `w`/`W`, and `o` or Enter use
the same footer actions and source-honest passage cursor. Native Enter on a link
or button remains activation, never a Reader shortcut.

Result tables share one row-navigation contract without replacing their native
table semantics. One existing row disclosure or open control is in the Tab
order at a time; `j`/`k` and Down/Up move one row, PageDown/PageUp move by the
visible row count, and Home/End clamp to the first and last row. Enter keeps the
control's native open/toggle behavior. Escape closes an open row detail first;
from a closed row it returns focus to the table port. Focus movement never
changes analysis scope or issues work.

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
7. direct Concordance/barcode-to-Reader navigation stays snapshot-bound;
8. the fixed dock reserves its combined height before the reading footer mounts,
   so Terms does not move when a chunk or first snapshot arrives;
9. Reader remains full-viewport, page-fitted, and scroll-locked at every width; and
10. Chromium functional plus compact WebKit suites pass from the
    production-shaped build.
