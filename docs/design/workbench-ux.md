# Width-first workbench UX and information architecture

*Current product-design authority for the textTrends shell and cross-device
presentation.*

**STATUS: IMPLEMENTED (updated 2026-08-25).**

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
| Trends | Where do tracked terms occur, which terms keep company, and where should I read? | trend plate, dispersion, Company, Reading Destinations, linked-range density against the corpus remainder |
| Matches | What contexts contain the terms? | continuous corpus-order grid, term membership, context, occurrence navigation |
| Vocabulary | What words characterize this scope? | frequency, document frequency, dispersion, richness |
| Compare | What distinguishes one side from another? | selected-range versus corpus-rest or text-versus-text profile and divergence, keyness controls, effect intervals and G² rankings, exact counts, per-side dispersion, row detail |

Compare reports whole-distribution vocabulary divergence and a two-sided text
profile above streamed log-ratio rankings. Its gear opens the app-wide Settings
pane at **This place** for sorting, per-side ranking direction, filters, and optional
95% effect-interval whiskers (hidden by default). Exact intervals remain in
term detail alongside signed G², the underlying counts, document ranges, and
per-side dispersion. Sort fields include the log-ratio point estimate and its
lower 95% confidence bound, as well as evidence and counts. A browser view
retains at most the first 50,000 ranks;
the visible progress line says when that display bound is reached so readers
can refine the filters for deeper ranks.
With one active text, Compare remains present in selected-range mode. Before a
range exists it explains how to create one in Trends; afterward side A is the
exact linked range and side B is every ready-corpus token outside that range.
With multiple texts, a linked range can be chosen as a side alongside the
existing text-versus-text and text-versus-rest modes.

At compact widths each ranking row preserves the complete term identity before
secondary statistics. The comparison bar remains visible, while the exact
signed lift is carried in the row's accessible name and disclosed detail rather
than forcing a clipped number into the primary scan line.

Vocabulary's **Settings → This place** section and Compare's settings Filters
section each expose a native “remove common words” slider from off (0, the
default) through the top 2,000 entries of the bundled English common-word
reference. Vocabulary applies the control live with the same debounce as its
text filter; Compare stages it with the rest of that form. The control and
export provenance state that this is a row filter: surviving counts and
statistical measures do not change, and Compare's whole-distribution divergence
does not move.

Trends keeps the term set fixed to the at-most-five groups already being
tracked. With no linked range, its second organ shows Reading Destinations for
one term; with two through five it adds Company when any pair shares a text.
Company keeps the two directional proximity rates separate and makes no association
claim. Pairs that never occur in the same text are omitted; when none remain,
the Company panel is omitted and Reading Destinations takes the full width.
Selecting a presented pair strictly focuses only Reading Destinations. A
destination exposes occurrence evidence and opens Reader at an exact winning
occurrence. These
surfaces require only indexed tokens and occurrences, so TXT is not a degraded
case and no inferred chapters or other document hierarchy are implied.

Once a linked range settles, the same organ is replaced by exact inside/rest
rates for the tracked terms. It never ranks vocabulary, discovers terms, or
adds G² evidence columns—the Compare place owns those jobs. Inputs remains the
home of exact per-document term counts.

Inputs, Trends, Matches, Vocabulary, and Compare form one ordered
**Workbench sections** tab list, with Inputs first. Compare is available when
at least one text is active. The complete five-place list remains in the
header only at widths where it and the scope signal fit without collision. It
bottom-docks below 960px; compact landscape keeps its left rail. This navigation
fit threshold is intentionally separate from the 600px compact-density
breakpoint. There is no hamburger or analytically ambiguous “More” menu.

The query string owns one presentation key:

| State | Carrier | Values |
|---|---|---|
| Place | `?p=` | `inputs`, `trends`, `matches`, `vocabulary`, `compare` |

Terms, source text, and workspace data never enter the query string.
With an empty corpus, a `compare` route is rewritten in place to Inputs. A
single active text keeps the route and presents the selected-range prompt.

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
title. Scope is a conditional single-line control: a complete loaded
whole-corpus state stays quiet, while a linked range, partial corpus, or active
loading state exposes a compact signal and a non-modal details surface. The
signal may truncate its title but never its numeric magnitude; when its own
track narrows, the visible magnitude switches to compact notation while Scope
details retain the exact value. Compact portrait
shortens the visible publisher signature to `textTrends` so the global Find,
Settings, and Help actions remain touch-sized and reachable; the link's
accessible name and destination retain the publisher identity. Widths below
960px move the Workbench section links to their governed bottom dock; compact
landscape uses its side dock. Neither placement duplicates the navigation DOM.

Full-screen modal panes and form layers overlay this flow. There are no permanent
desktop side rails. One fixed dock carries the authored Terms rail above the
transient source position, passage, trend, progress, and dispersion context.
Settings, Help, Credits & sources, and Debug use the same governed pane frame;
governed row details remain separate history layers.

### Scope organ

Scope states the corpus, included documents or linked range, token count, and
completeness. **Find**, **Settings**, and **Help** are pinned sibling actions at
every supported width rather than children of Scope's overflow region. Trends
and Compare keep contextual settings entrances inside their own analytical
plates; both open the same Settings pane rather than a second settings surface.
A versioned formatter contract exists for Trends, Vocabulary, and Compare
provenance, limitations, and result export, but no production surface invokes
it yet. Compare keeps its immediate profile, divergence, intervals, dispersion,
and row evidence in the governed analysis surface.

### Inputs acquisition states

Inputs gives the primary acquisition job the strongest action: **Import and
analyze**. With no active corpus, Add texts is expanded and leads with “Start
with your text”; prepared samples and Standard Ebooks remain subordinate ways
to begin. Once texts are active, acquisition collapses to the primary action
and an explicit **Show options** disclosure so corpus management receives the
space. The trust line “Processed in your browser · never uploaded” stays next
to the primary import path in both states.

The Local library is a separate save-without-activation path. **Save to
library** never implies analysis, while dropping or choosing files in Add texts
imports and activates them. Coarse targets keep their minimum size, disclosure
focus is restored when collapsing would otherwise strand it, and empty,
loading, failed, and populated states remain explicitly named.

### Settings and display preferences

There is one app-wide Settings pane with a stable order: **Display → This
place**, with This place present only where operative controls exist. The global
Settings entrance lands at Display; a contextual entrance opens the same pane
with This place aligned and focuses its first operative control. Closing or
pressing Escape restores the entrance focus.
Settings is transient UI: opening, switching entry section, applying, and
closing neither push nor replace browser history.

Display preferences apply immediately and are device-local. Theme and UI
density live in local storage, not in a workspace. Analytical settings remain
workspace-local: Trends and Compare use governed drafts until Apply, while
closing or Escape discards an unapplied draft. This place contains the real
Trends or Compare form where one exists; prose, tutorial hints, shortcuts, and
diagnostics do not live in Settings.

### Help, guidance, and credits

Help is a contextual utility rather than a renamed shortcut sheet or a second
settings hierarchy. It opens from the pinned header action, `?`, Reader, or the
speed reader and keeps four jobs together: **This view**, **Quick actions**,
**Method & privacy**, and **Keyboard & gestures**. This view names the current
place's governing task and offers one concise next-step hint. Quick actions link
to the existing Display settings surface and, only where the pinned header is
absent, corpus Find. Method & privacy carries the short methodological caveat
for the current surface and the browser-local processing promise. The keyboard
registry still generates the contextual key and gesture reference.

The Help footer links to **Credits & sources** and **Debug**. Credits is a nested
surface covering project authorship, bundled text provenance, the optional
GitHub source-download path for Standard Ebooks titles, and primary runtime
dependencies. Its Back action
returns to Help with focus on the credits entry. A handoff from Help to Settings,
Find, or Debug retains the original external invoking control for final focus
restoration. None of these surfaces participates in browser history.

UI density is a three-stop slider. Standard is the default; apart from the
automatic footer baseline below, Compact reproduces the rendered geometry that
predated the preference.

| Metric | Compact | Standard | Comfortable |
|---|---:|---:|---:|
| authored UI type (`xs` / `sm` / `md` / `lg`) | .6875 / .8125 / .9375 / 1.25rem | .75 / .875 / 1 / 1.3125rem | .8125 / .9375 / 1.0625 / 1.375rem |
| chrome target | 44px | 46px | 48px |
| Matches row pitch | 32px | 36px | 40px |
| Vocabulary row pitch (regular / compact width) | 34 / 44px | 38 / 48px | 42 / 52px |
| Terms rail (regular / compact width) | 48 / 50px | 52 / 54px | 56 / 58px |

Density scales authored UI type, chrome, Terms targets, table headers, and data
row pitch. It does not rescale analytical encodings, primary place plots,
barcodes, strokes, hit tolerances, Reader prose, or RSVP type. Reader chrome may
refit, but its reading type remains reader-owned.

Compact and Standard have one deliberate reading-footer layout rule: an
automatic workbench footer starts with the passage, padding, and lane gaps at
their readable floors while retaining the position status and occurrence
barcode. The squeezed Terms target follows the density scale: 24px in Compact,
34px in Standard, and 44px in Comfortable. Compact also starts its Trends graph
at the existing minimum readable height; Standard retains its authored
analytical strip. On
coarse layouts at Compact density, this releases the old minimum-strip reserve
so it cannot leave dead space above the shorter graph. Comfortable retains the
roomier authored footer.
An explicit resize remains authoritative across density changes; resetting the
resize returns to the active density's automatic baseline. Reader is excluded
because its separately governed compressed footer already starts the Trends
graph at this floor. On a live density change, Matches preserves its corpus
anchor, Vocabulary preserves the first fully visible row, and Compare
remeasures its virtual rows instead of pretending the old pitch still applies.

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
removal are intentionally reached through Manage and the visible Terms label
is omitted. Terms targets use density-specific minimums: 24px in Compact, 34px
in Standard, and 44px in Comfortable. The automatic Compact and Standard
states begin at those squeezed floors until the user expands the dock. A
removal Undo notice opens upward from the dock rather than covering the reading
lane.

At compact widths the visible buckets prioritize identity over bucket count.
At 390px, at least two complete term names remain readable, a live cue names
the linked-range state, and painted edge fades disclose horizontal overflow.
Add and Manage stay pinned; compact edit and removal still live in Manage.
Outside the explicit squeezed automatic state, touch/coarse targets retain
their authored minimum size without forcing the same floor onto fine-pointer
layouts.

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
rail. Reader keeps a compact Terms rail above its minimal analytical footer
while hiding the rest of the workbench chrome.

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
- in separate-row Equal and To scale views, a sticky full-width separator sets
  one device-local per-row height target; whitespace contracts before plot ink,
  titles stop painting below their legible lane while remaining keyboard and
  assistive-technology selectors, barcode rows miniaturize and then collapse as
  one discrete step, and Combined retains its authored height;
- dispersion rows embedded at the bottom of the plot;
- whole-text selection by activating a title, plus inclusive title-to-title
  press-and-drag selection in either reading-order direction;
- linked-range selection by mouse drag or keyboard, plus two-touch selection
  and a press-hold-then-tap alternative on touch screens; and
- exact graph values through the method/detail surfaces.

Pointer motion and touch reading move a transient cursor. Mouse and pen hover in
an exact barcode row snap only within the specified pixel tolerance; touch
stays on its direct raw position. This is decided per pointer event, so an iPad
trackpad retains precise hover and snapping while the same device keeps its
large touch controls. Density cells never pretend to be exact targets.
Two stationary touch taps, or a mouse double-click, within the main graph lane
clear a linked range.
Barcode rows, range handles, gaps, an active long-press anchor, and concurrent
two-finger range selection do not participate in that gesture. The first tap
retains ordinary reading feedback; the recognizing second tap is consumed.
Clicking an exact occurrence centers Matches; opening source text is an
explicit action from Matches or the global reading footer.

The fixed reading footer is the lower lane of the dock in all five workbench
places and in Reader. Its one corpus-order axis aligns a thin all-book
sparkline for every shown query, corpus progress, document boundaries, and the
resident multi-track dispersion barcode. Workbench places add a clipped
current passage and position-status lane; Reader omits both because its fitted
page already owns the source text. The
complete dock sits above the compact portrait Workbench sections dock and to the right of the
compact-landscape rail. The source line is a transient `reader-page/1` window.
Its independent single-flight lane frame-coalesces pointer samples, issues the
newest unserved position immediately, retains the last authenticated page while
the next is in flight, and saves no text or range.
The passage's native horizontal scrollport covers both the source line and its
book/token status line; the status is a pointer-transparent visual readout, so
wheel and touch gestures anywhere in that text area follow one scroll path.
On either analytical graph, a stationary double-click clears the linked range.
In the footer, holding and dragging the second press over the graph or barcode
replaces it with a newly brushed range. The graph clears on that second press;
the barcode retains its stationary Reader action and clears only once movement
turns the press into a brush. A plain first-press footer drag remains the
reading shuttle. Barcode and passage or status double-clicks retain their exact
navigation and Reader actions.
Absolute hover continues to seek the shared corpus
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

The text field above the table performs a case-insensitive literal substring
filter by default, before ranking and paging. Literal metacharacters are text,
not regular-expression syntax, and case folding does not merge vocabulary
types: `The` and `the` retain separate rows and counts even though a literal
query can include both in the result set. No accent folding is implied.

An inline **regex** checkbox deliberately opts into a case-sensitive Unicode
regular expression and retains the current query when switching modes. Invalid
regex drafts retain the preceding valid result until corrected. Empty text
means no filter and issues no filter request; the trailing × clears text while
retaining the local mode. Pointer toggles return focus and the caret to the
field, while keyboard activation leaves focus on the checkbox for repeat
toggling. Workspace restore maps former regex and legacy prefix fields into
regex mode; writers emit only the current `{ mode, query }` filter shape.

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

The terms remain fixed at their midpoint geometry even when the first or last
match lies far from a corpus edge. Otherwise empty half-viewport space before
the first match and after the last match is painted as a non-interactive corpus
edge band that names the exact token distance. The bands do not add rows,
change the physical/logical scroll mapping, or move an occurrence. Equivalent
hidden descriptions are attached to the grid; the painted copies are excluded
from the accessibility tree.

Activating a match opens Reader directly. Exact barcode occurrence
controls in Trends open Reader. The footer's barcode centers Matches in
place, while its current passage and status or barcode double-clicks open Reader
at the current or clicked position. The footer graph's double-press gesture is
reserved for linked ranges.

## Settings and provenance contract

The graph carries no embedded settings form. Its pinned **Trend settings**
entrance opens the app-wide Settings pane at This place, matching Compare's
plate-local entrance. The versioned provenance and result-export formatter
remains a tested library contract, not a visible or copyable pane in the
current product.

Changing result geometry reissues only baseline and selected trend lanes.
Changing resident presentation performs no worker query. Smoothing never
crosses document boundaries or bridges zero-denominator gaps, and exact raw
counts remain available for totals and provenance. Rates use the fixed,
explicit 10,000-token denominator; there is no denominator preference.

Place settings are a draft until Apply. A successful Apply closes the pane and
restores focus to its contextual entrance; an unchanged or rejected draft
remains open with an explicit status. Restore defaults changes only the draft,
while close and Escape discard it. Display changes are the deliberate
immediate exception. The pane itself is transient UI state and never adds,
replaces, or consumes a browser-history entry.

## Reader

Reader is a full-viewport reading surface at every width. It hides the
workbench header, place, and Lens chrome while keeping a resizable dock with a
compressed Terms row, the all-book graph, progress, and the dispersion
barcode. Downward resizing drops Terms first, then the barcode, then compresses
the graph to the thin progress line. It locks
both prose and the outer document against vertical scrolling and fits one
visual page from the real rendered text above that dock. It retains one
identity and DOM across viewport changes and exposes page navigation,
occurrence navigation, page status, query highlights, and an explicit Back
path. The highlighted prose has no duplicate legend; the retained Terms rail
is its visible query key. A compact notice remains only when marks were capped
or retain a query identity that has since changed.

Reader position and highlights are transient. The workspace contains notebook
and analysis-view settings, not reading position.

Reader owns the reading keys while it is open: `h`/Left/PageUp and
`l`/Right/PageDown use its fitted previous and next token boundaries, Home/End
request the document boundaries, and Escape follows the same governed Back path
as the visible control. Resize and font settlement preserve the current start
token and deliberately recompute later boundaries for the new geometry.
Each settled page also publishes the shared reading position: an initial
around-token request retains its exact anchor, while ordinary page turns use
the fitted page's first token. Every Reader entrance, including “read from
here,” moves that shared cursor to the requested reading position.

`w` and `b` move to the next and previous exact occurrence of any shown term
across the full declared corpus. Overlapping raw matches at one token start are
one stable reading stop with their member provenance combined; density barcode
buckets and linked analytical ranges never approximate or narrow this action.
The shared scrub position and Matches center follow the result, and an open
Reader replaces its current page around that exact occurrence.

## Reading position history

Reading positions form one bounded, session-only jump list independent of
browser Back and the governed Reader/row-detail layer stack. `Ctrl+O` visits an
older reading position and `Ctrl+I` revisits a newer one in both the workbench
and ordinary Reader. From 1200 CSS pixels up, the workbench header mirrors those
commands with labelled curved-arrow controls; narrower widths reserve that row
for the publisher, Scope, Lens, and pinned tools. Reader keeps the keys and Help
entries without adding a third previous/next pair to its header. A history traversal
retargets an open Reader in place and neither closes it nor pushes, replaces,
or consumes a browser-history entry.

Discrete evidence jumps record their departure and destination immediately.
Continuous footer/Trends scrubbing, Matches scrolling, keyboard reading, and
Reader page fitting update the source and shared cursor immediately but amend
one provisional history destination after 400ms of quiet. Forward history
survives traversal and small landing refinements, and clears only when a new
branch is committed. The capped list stores only snapshot, document, token,
and origin; it contains no source snippets and is not part of the workspace.
RSVP playback does not record each word; exiting records its settled stop.

## Keys and gestures

Vim and conventional bindings are simultaneous during ordinary navigation.
Explicit interaction modes are the narrow exception: at most one is active,
and a visible non-modal indicator always names it and provides a touch/coarse
entry and exit path. Temporary corpus Find is the first such mode. A central
registry is the source for event matching,
`aria-keyshortcuts`, and the contextual Help reference opened by `?` or the
visible Help control. The reference interleaves keyboard and touch gestures
under the surfaces they govern. Workbench Help includes Terms, the active place,
and its persistent reading footer, while Reader and speed-reader Help contain
only their owned actions. Debug remains reachable by touch from the Help footer
and globally with the explicit `Shift+D` chord.

Focused controls act first. A local handler that consumes an event prevents the
root dispatcher from reinterpreting it, and text inputs, selectors, editable
content, unrelated browser modifier chords, and IME composition retain their
native behavior. The explicit `Ctrl/Cmd-F` and `Ctrl/Cmd-G` Find chords are the
narrow semantic-search exception. The Ctrl-only `Ctrl+O` / `Ctrl+I` reading
history chords are a second explicit exception outside editing, dialogs,
menus, composition, and RSVP; Cmd+O / Cmd+I retain their platform meanings.
Help is a transient modal rather than navigable research
state; closing it with Escape, `?`, or its visible control restores the
invoking focus without adding browser history.

Two-key Vim sequences expire after 900ms and never create a persistent mode.
`gi`, `gt`, `gm`, and `gv` go to Inputs, Trends, Matches, and Vocabulary;
`gd` goes to Compare when at least one text is active and otherwise announces
why it is unavailable. `gf` focuses the reading footer and `gq` focuses the
first term visibility control in the fixed rail without scrolling the workbench.

Temporary dock composers use one shared two-row takeover at every width. A
44px input row sits below a 44px action row; an 8px fine-pointer or 12px
coarse-pointer clearance lane keeps the footer resize handle from intersecting
or capturing those controls. The bottom-pinned dock grows upward to reserve all
three lanes while the reading footer itself keeps the same height. Add shows
Add, More options, and Cancel in the upper row; its More action carries the
draft into the full editor. A pending removal notice is hidden only while this
composer is open and returns intact on close.

`/` and `Ctrl/Cmd-F` open temporary corpus Find. On the workbench Find replaces
the whole Terms rail. Its query field takes the lower row at every width; the
temporary upper row shows Find and Clear and close before submission, then
Previous, Next, Save, and Clear and close for a current submitted draft. Once a
result is ready it also shows the fixed-width result-progress action. Editing a
submitted query returns that upper row to Find and Clear and close until the
draft is submitted again. The visible progress is a bounded percentage
so arbitrarily large corpus totals cannot displace the close action; its
accessible name and live status retain the exact one-based match and total.
Save becomes a disabled Saved confirmation after promotion. Find accepts the Terms editor's comma-authored
aliases (words, phrases, and one-ended wildcards) as OR
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
After the matching window lands, the result action shows a bounded percentage
while retaining exact progress in its accessible name and live status. The
indicator is absent while a seek is pending. The ready explainer is actionable:
Enter opens Reader at that hit.
Save promotes the submitted aliases into one durable, active term and is
disabled when the active comparison or saved notebook is at capacity.
Escape or × clears the transient query and restores invoking focus. In Reader,
the same controls replace Terms in the retained dock rail.
While Find is already open, `Ctrl/Cmd-F` focuses the query field and selects
its complete draft so a replacement can be typed immediately.

Within the
Workbench sections, `h`/`l` and Left/Right move horizontal focus; tab focus does not
activate a destination until the link is invoked. With at least two active
texts, `v` on the Trends scrubber cycles the combined, equal-row, and shared-
token-scale presentations without issuing analysis, alongside its existing
Arrow, Page, Home/End, and range-selection keys.

The Trends title group contributes one Tab stop regardless of corpus size.
Left/Up and Right/Down move to the previous and next selectable title without
wrapping; Home/End move to the first and last, and titles for zero-token texts
are skipped. Enter or Space selects the focused text in full. Shift plus a
directional Arrow establishes the focused title as an anchor and immediately
applies an inclusive whole-text range through each newly focused title. This
immediate title-range contract is deliberate: unlike the token-precise
scrubber's preview-then-Enter model, every title is already a complete,
discrete selection endpoint.

On Trends, reading-footer shortcuts are also page fallbacks; the user does not
need to focus the footer before reading. A focused local control still wins:
the Trends scrubber keeps Arrow, Page, and Home/End movement and an active range
keeps Enter/Escape. Otherwise `h`/`l`, `H`/`L`, `w`/`W`, and `o` or Enter use
the same footer actions and source-honest passage cursor. On the focused footer,
`s` starts a keyboard range, movement keys extend it, Enter commits it, and
Escape cancels a preview or clears a committed range. Native Enter on a link or
button remains activation, never a Reader shortcut.

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
  targets to 44 pixels without inflating dense table rows. In short viewports,
  page and local-header chrome may interpolate to a 32px floor while the Terms
  rail retains its authored one-row target geometry.
- Editable compact inputs render at least 16px text.
- UI density is independent of responsive width and pointer precision; it
  changes authored pitch within the responsive composition rather than
  selecting another place layout.
- At 320px the page itself does not scroll horizontally; named data ports may.
- The Trends overview uses one column below 720 CSS pixels, leaving classic
  scrollbar headroom before its two bounded panels share a row.
- Viewport changes never alter corpus, scope, notebook, linked range,
  comparison sides, persisted views, or Reader identity and issue no analysis.
- Full-screen forms and utility panes trap focus and inert the workbench.
- Escape closes one transient pane and restores its invoking focus. Back closes
  exactly one governed history layer; utility panes do not participate in Back.
- Help can hand off directly to Settings, Find, or Debug without losing the
  original invoking control; closing the destination restores focus there.
- Credits & sources returns to Help with the credits entry focused; closing Help
  still restores the original external invoking control.
- Browser save shortcuts are not intercepted.
- Reduced motion removes nonessential transitions without removing state.

## Persistence and release gates

Workspace restore applies notebook and analysis-view state before queries
continue. Theme and density are device-local display preferences and never
travel with that workspace. The deletion undo stack and Reader navigation are
transient. Local files are deduplicated by content identity; workspace writes
are last-write-wins, with no multi-tab edit model.

The design remains complete while these gates hold:

1. no page-level horizontal overflow at 320, 390, 768, and 1440px;
2. one Terms rail and one active place at every width;
3. no persistent side rails beyond the transient corpus-reading instrument;
4. density-authored compact/coarse controls and keyboard-operable equivalents;
   the squeezed Terms rail uses 24 / 34 / 44px in Compact / Standard /
   Comfortable, while documented short-viewport page/local-header chrome may
   reach 32px;
5. viewport transforms issue no analysis and retain governed drafts and focus;
6. trend result-geometry changes issue only trend work;
7. direct Matches/barcode-to-Reader navigation stays snapshot-bound;
8. the fixed dock reserves its combined height before the reading footer mounts,
   so Terms does not move when a chunk or first snapshot arrives;
9. Reader remains full-viewport, page-fitted, and scroll-locked at every width; and
10. Chromium functional plus compact WebKit suites pass from the
    production-shaped build.
