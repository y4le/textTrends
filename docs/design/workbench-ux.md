# Workbench UX

The shell keeps the path from corpus to terms, analysis, and source visible.
Scope is computational inclusion; terms are authored queries; focus is visual
emphasis; reading position is transient navigation. These states must not
silently substitute for one another.

[Workbench reference](../reference.md) owns user-facing controls and defaults.
[Reader](spatial-reader.md), [Matches](continuous-matches.md), and
[guided learning](guided-learning.md) own their specialized contracts.

## Shell and places

Exactly one of Inputs, Trends, Matches, Vocabulary, and Compare is mounted.
They form an ordered Workbench sections tab list. Empty workspaces open Inputs;
active corpora open Trends unless `?p=` supplies another valid place. Compare
requires at least one active text; one-text corpora use the selected-range
prompt. Source text and queries never enter route state.

The header contains publisher identity, conditional Scope, navigation, Find,
Settings, and Help. Complete whole-corpus scope is quiet; partial, loading, or
linked-range states expose magnitude and details. Titles may truncate, but the
numeric magnitude retains a readable compact form with exact detail available.
Navigation bottom-docks below 960px; compact landscape uses the side dock.
This fit threshold is separate from the 600px compact-density breakpoint.
There is one navigation DOM, no persistent desktop side panel, and no repeated
place title inside the analytical surface.

The workbench dock reserves the Terms rail and expected reading-footer height
before lazy chunks or a first snapshot arrive. Empty workspaces keep Terms
without a reading lane. The footer is the shared corpus-order reading
instrument; it does not own analytical scope or durable notebook state.
Read and Speed have their own chrome; only Atlas retains the analytical dock.

## Inputs and acquisition

Active inputs owns declared order. Add texts leads with Import and analyze;
prepared samples and the Standard Ebooks catalog are secondary acquisition
paths. With texts present, options can collapse. Local library has a separate
save-without-activation action. Removing an active text retains library bytes;
deleting a source confirms its name and removes all active references to it.
Clear all resets active texts and terms together while retaining the library.

OS files, saved-file activation, demos, catalog downloads, and deletion share
one exclusive library-operation lease. Imports pause reordering and expose
pending/failed rows. Prepared demos become ordinary library texts. Menu/sample
loads are additive; one-shot demo URLs acquire and admit before atomically
replacing the research configuration. Failures before admission preserve it.

Inputs uses `corpusInventory`, a separate full-corpus resident, for stable text
facts and source diagnostics. Linked selection cannot cancel or relabel that
baseline. Selection-following inventory serves Vocabulary and contextual
methods. Both are snapshot-bound. Every active term remains reachable in the
per-text table, including inside a named horizontal data port on narrow screens.
Titles are display names; document ids remain the identity for joins.

## Terms and Find

The rail is one scrolling row with Add term and Manage pinned. There is no
selected term; shown terms have equal status and all participate in navigation. The
notebook's bounded groups and shown projection are separate. Removing a group
creates a five-item undo stack. Compact edit/removal goes through Manage.
At 390px, at least two complete term names remain readable and overflow has a
painted cue. Undo opens above the dock.

Manage supports pointer and keyboard reorder through the same command.
Reordering starts only on the handle; edge scrolling updates insertion position,
a second touch cancels, and lost capture clears the gesture. Automatic colors
use a theme-aware maximin palette with the publisher's reserved spot-color
clearance. Manual six-digit hex overrides stay fixed across themes; low
contrast produces a warning without changing the choice. Color, line style,
and text jointly identify terms.

Quick entry, Manage, and Find compile comma aliases into one OR group through
the core alias compiler. One explicit primary interaction is active at a time
(`none`, Find, or Speed); utility panes
are separate. Find owns its own submitted identity and bounded analysis lanes,
while draft keystrokes remain in the composer. Only Save mutates the notebook.

Opening Find immediately dims durable trend/barcode context and disables its
hits. A submitted Find overlays it as the sole interactive track. Ghost lines
and Find use one y-scale; paint waits for every non-failed scale contributor.
Only Find supplies totals, hover values, and navigation. Closing restores
durable residents. Snapshot replacement/disposal clears Find; scrubbing and
notebook edits do not. Speed suspends Find as described in its own contract.

Workbench Add/Find composers reserve two 44px rows plus clearance for the dock
resize handle. Result progress is visibly bounded while accessible status
retains exact rank/total. More options carries the Add draft into Manage once.
Read's Find takeover preserves prose geometry and does not depend on the dock.

## Analytical presentation

React SVG and canvas own analytical rendering and interaction. A small pure
geometry/scale dependency can be justified individually; a general chart
runtime must not take ownership of token geometry, accessibility, or source
navigation.

Trends uses one y-scale for shown tracks, declared token geometry, and a hard
path break at each document boundary. Exact marks may snap for mouse/pen
within the defined tolerance; touch remains direct and density never snaps.
Pointer precision is determined per event, independently of coarse layout.

Separate Equal and To scale rows share a device-local requested row height and
its width/pointer/track context. Resizing spends whitespace, then title space,
then plot/barcode ink; the final barcode collapse is discrete so shrinking a
row cannot grow the plot. Hidden titles remain keyboard/assistive selectors.
Combined keeps its own height. Resize and presentation changes reuse residents.

Title selection includes whole texts; Shift+Arrow and title dragging extend
inclusive ranges immediately. Token-level keyboard ranges preview until Enter.
Graph double activation clears a range only outside barcode rows, handles,
active holds, or two-pointer gestures. Exact occurrence controls can open
Reader; footer barcode activation centers Matches, while its passage opens
Reader. Density activation publishes a position without claiming a hit.

With no linked range, Trends shows Reading Destinations and, when a pair shares
a text, Company. Pair focus reissues only Destinations. A range cancels pending
overview work and replaces it with inside/rest rates; matching overview
residents may be reused when the range clears. Vocabulary discovery and keyness
remain in their own places. [Statistics](statistics.md) owns their meanings.

Tables preserve term identity before secondary statistics at compact widths.
Vocabulary filtering is literal by default; RE2JS regex loads only on demand.
Compare columns are independent rankings; Reverse rankings changes ranking
direction, not side identity. Common-word filters remove rows before ranking
and paging without changing measurement denominators or divergence.

## Utilities, input, and focus

Settings, Help, Credits, Debug, Reader controls, and Speed tuning use the
utility-pane focus/inert boundary and do not enter browser history. Global
Settings opens Display; contextual entrances align This place and focus the
first operative control. Display is immediate and device-local. Trends and
Compare forms are workspace-setting drafts; Apply commits, while close/Escape
discards. Unchanged/rejected drafts stay open with status.

Help combines current-view guidance, actions, method/privacy, and registry-owned
keyboard/gesture reference. Credits returns to Help. A handoff to Settings,
Find, or Debug preserves the original external invoker for final focus return.
The guide's non-modal card is a separate contract.

Native editing, IME, focused controls, and consumed local events precede root
shortcuts. The explicit Find and Ctrl-only reading-history chords are narrow
exceptions; unrelated browser chords retain their meaning. Two-key sequences
expire. Tables use roving row controls; virtual Matches owns active-descendant
focus instead. Escape closes one applicable layer. Browser Back belongs to the
navigation controller, not utility visibility or the reading jump list.

## Responsive and recovery gates

Compact is below 600px, regular 600–1023px, wide at least 1024px. Pointer class
is independent. Coarse controls normally have 44px targets; short-viewport
page/local headers may reach 32px. Automatic squeezed Terms follows density
floors of 24/34/44px (Compact/Standard/Comfortable). Editable compact inputs use
at least 16px type. Reader controls retain their stricter 44px floor.

Density changes authored UI type and row pitch, not plot encodings or
Reader/Speed type. Explicit dock resizing wins until reset. Matches preserves
its corpus anchor, Vocabulary its first complete row, and Compare remeasures
rows. The page must not overflow horizontally at 320px; named data ports may.
Reduced motion removes nonessential motion while retaining state cues.

Viewport transformations preserve corpus, scope, notebook, drafts, comparison
sides, and Reader identity. They issue no analysis; a fitted Reader may need
its ordinary bounded source continuation. Trend result-geometry changes issue
only the corresponding trend lanes.

Save failure/retry remains visible across workbench places and Reader.
Damaged library entries cannot prevent healthy work from opening; unavailable
active references survive autosave until repaired or removed. Lazy-view errors
preserve navigation and a recovery route. Debug's copied report is allowlisted
metadata with no source/query text, names, passages, result rows, or bytes.
Cache eviction and full reset have distinct consequences and close database
owners before deletion; blocked deletion cannot report success.
