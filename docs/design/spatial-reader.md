# Reader

Reader presents one authenticated token position through fitted Read prose or
a whole-text Atlas. Speed is a first-class Read mode with its own
[pacing and source contract](rsvp-reader.md). These are projections of the
existing Reader layer, not extra workbench places or browser-history entries.

Read uses selectable source DOM and prioritizes prose. Atlas compares document
extent and term evidence; categorical horizontal movement has meaning because
texts have a declared order. Arbitrary camera zoom, microscopic prose, synthetic
pages, and bitmap text would lose that meaning and native text behavior.
Continuous and reference prose remain [deferred](current-roadmap.md#deferred-designs).

## Position and navigation

Snapshot, document id, and document-local token identify the position.
`anchor: 'occurrence'` claims authenticated occurrence evidence;
`anchor: 'position'` claims only a location, including a density midpoint.
Numeric precision does not make a density destination an exact hit.

The existing Reader layer identifies the open destination; `scrub` publishes
the shared position. `readerCursorToken` is an ephemeral Read selection used
for the visible word and Speed entry and publishes that same token to `scrub`.
Atlas retains it only while the authenticated Read page remains valid. Pixel
positions, canvas residency, rail fit, scale, and sheet state are presentation.
Atlas normalization is device-local and independent of workspace Trends layout.

External evidence opens Read. Read/Atlas switches preserve the active text,
token, and evidence claim. Exact distinguishable marks can descend directly;
density descends to a position. Atlas body activation selects and stays in
Atlas; Enter or double activation descends. Exact reference stepping and
reading-history traversal preserve the current scale.

Previous/next text skips empty texts and maps relative position:

```text
target = round(currentToken / max(1, currentTokens - 1)
               × max(0, targetTokens - 1))
```

It yields a position claim. Fitted page rollover is different: forward enters
the next text's start, backward the prior text's final page. Home/End use real
active-text endpoints. Scale-aware keys and accessible labels come from
`shortcuts.ts`; shared command availability comes from `reader-commands.ts`.

## Fitted source

`reader-page/1` supplies bounded directional source slices, token geometry, and
query marks. The browser renders the actual marked text and fits the largest
token range that occupies the prose pane without vertical scrolling. Adjacent
forward pages meet at exact boundaries. A bounded session walk remembers pages
for reverse traversal until resize/font settlement invalidates their geometry.

Resize retains the current start token and recomputes subsequent boundaries.
An initial around-token request retains its exact anchor; an ordinary page turn
publishes the fitted page's first token. An exact selected word can move the
cursor without querying or changing page geometry. Anchor highlighting is
layout-neutral; bold weight must not move a page seam.

Read→Atlas issues no source query. Atlas→Read reuses a still-authenticated page
covering the token or requests the normal bounded source slice. Snapshot and
matching-identity guards remain mandatory. Stale query marks and capped marks
have conditional notices; source cannot silently claim a superseded query.

## Chrome and pointer ownership

Compact and regular Read have one 44px bottom bar: Back, previous page,
title/token/percentage, next page, and visible Speed entry. The position button
opens an overlay with exact page range, reference/text movement, endpoints,
scale, highlight key, Settings, and Help as applicable. Page labels collapse
to arrows below their fit threshold; Back stays visible.

Wide Read uses lateral rails only when the prose measure and both rails fit
the measured inline space. The right rail reuses the active text's resident
Atlas entry in Equal geometry, independent of the Atlas preference, with a
seekable extent and exact position. It adds no analysis lane. Wide Find replaces
that entry with its own horizontal progress control. Compact/regular layouts
use a three-pixel, non-interactive active-text progress rail with one non-live
`progressbar` semantic and visible endpoints.

`reader-position.ts` derives title, ordinal, token, percentage, and fitted range
once. The ready source owns document token count; snapshot-bound counts are
fallback data. Explicit cursor, authenticated source anchor, fitted page, and
Reader destination establish token precedence. Bars, rails, sheets, and status
consume this model. Read/Speed do not mount `WorkbenchDock`; Atlas retains it.

Find replaces Read controls without changing prose dimensions. Reader controls,
Help, Settings, and Speed tuning reuse utility focus/inert/Escape behavior;
opening them changes no fitted range or research state. Opening tuning pauses
Speed and closing it never resumes. There is no auto-hide timer or generic
centre-tap chrome mode.

One prose pointer owner arbitrates stable primary taps. Movement over 8px,
holds over 500ms, active selection, secondary pointers, or cancellation prevent
a Reader action. Interactive marks retain their action; painted source words
select their exact token even near an edge; blank edge space may page; blank
centre space does nothing. A caret resolver alone cannot distinguish blank
space because browsers clamp it to a nearby word. Painted-token rectangle
hit-testing supplies that distinction. Page buttons remain the dependable
non-gesture route; horizontal swipe does not take over browser history.

## Atlas projection

Atlas requires multiple readable texts. Every ready text has a semantic column
in declared order and a full authenticated token extent. Equal maps each
nonempty text to full height. To scale maps all texts to the longest token
domain; a shorter text's empty tail has no target. There is no Combined Atlas;
the workbench footer already owns the concatenated axis.

Marks use the resident full-corpus dispersion result (or effective Find).
Linked ranges never narrow column extents or evidence. The packed dispersion
CSR axis remains `snapshot.readyDocs`; projection joins declared-order columns
by document id rather than pretending the two arrays have interchangeable
indices. One track uses one exact/density representation across every column.

Exact vectors use a sum-preserving projection into bounded device rows.
Compressed exact pixels offer only position targets when individual ticks are
indistinguishable. Density bands retain exact transported totals and actual
per-column resolution. Eight to twelve bands are coarse; fewer than eight are
very coarse and visibly hatched. The shared 4,096-bucket budget can leave short
texts with little resolution; Equal/To scale do not create missing detail.

Keep lightweight shells for all documents and canvases only for a visible
overscan window plus independently pinned active/focused columns. No bitmap
width depends on total corpus size. Canvas backing sizes and paint rows are
DPR-bounded. Theme, resize, normalization, pan, and scale changes repaint
residents without analysis queries and refresh DPR on those reactive paths.

The plane and roving ruler each contribute one Tab stop. Left/Right select
texts, Up/Down and Page keys move position, Home/End choose endpoints, and
Enter opens Read. Exact `w`/`b` navigation remains available. Descriptions carry
term totals and density resolution, not just a route to a pixel. One polite
status announces committed movement. Hover does not publish a cursor.

Horizontal wheel/touch motion pans the named strip; dominant vertical wheel
moves the active position. Horizontal, Shift-wheel, and Ctrl/Meta-wheel retain
their native paths. Touch taps are distinguished from pans. Browser zoom is
never intercepted. Committed positions may request the existing bounded footer
passage; pan and hover do not.

No-term, loading, failed-dispersion, missing-extent, and coarse-density states
remain distinct. Extents and reading navigation can survive unavailable term
evidence. Old marks cannot appear under a new snapshot or matching identity.

## Reading-position history

The session jump list is independent of browser Back and Reader/detail layers.
Discrete evidence jumps record departure and destination immediately.
Continuous scrubbing, Matches scrolling, page fitting, and keyboard movement
publish immediately while settling one provisional destination after 400ms of
quiet. History recording never debounces source delivery.

Traversal preserves forward history through small landing refinements; a new
committed branch clears it. Entries contain only snapshot, document, token,
and origin. Ctrl+O/I retarget an open Reader without history-layer writes.
Speed does not record every frame; exit records its settled stop. Browser Back
and Reader close stay with the navigation controller.

## Acceptance gates

Read stays full-viewport and scroll-locked with selectable source at every
width. At 390×844, steady chrome is at most 52px excluding safe areas and
conditional notices, and prose gets at least 75% of height. At 320px and 200%
zoom, Back and controls remain reachable with 44px targets and no page overflow.
Sheets and Find do not refit prose; native selection, word taps, blank-edge
paging, exact-token Speed exit, and cross-text rollover remain distinct.

Read↔Atlas preserves snapshot/text/token and evidence claims. Presentation
changes issue no analysis. Density sums and actual band counts remain honest;
To scale rejects empty tails. The Bible and Quran, separately and together,
cover uneven density. The 66-text/five-exact-track browser gate bounds resident
canvases and fails Atlas-attributed tasks at 100ms. Tests cover up to 256
column shells; that is not a larger-token-tier measurement.

If bounded canvas residency or density resolution fails those gates, design a
separate bounded visible-document `atlas/1` projection before changing the
worker boundary. Do not fabricate detail or widen transport on the main thread.
