# Continuous Matches

Matches is one logical, full-corpus result with bounded transport, resident
rows, and DOM. Its scroll position and the shared reading cursor are two
controls for the same declared-sequence position. A linked analytical range
only highlights rows; it never filters, reorders, or reissues Matches.

## Kernel and ordering

`packages/core/src/ops/matches.ts` owns the bounded k-way merge over one to five
ordered occurrence vectors. The shared occurrence cache is the only owner of
full vectors. One track occurrence remains one row, including distinct spans
or memberships at the same token. Final order is document ordinal, token start,
span length ascending, track ordinal, then lexicographic member ordinals.
Raw occurrence emission uses different same-start ordering and cannot substitute.

Five tracks at the 200,000-occurrence per-track cap yield at most
1,000,000 rows.
The merge does not materialize or sort that whole result. Sparse rank/global-
token samples begin at rank zero and only occur at duplicate-run boundaries,
at least 128 rows apart. A run has at most 160 rows, so adjacent samples are
at most 287 rows apart and the axis has at most 7,813 entries (about 61 KiB).

Position lookup binary-searches tracks. Rank lookup uses the preceding sparse
sample, reconstructs its merge frontier at the run-boundary token, and walks
at most 287 rows before materializing a window of at most 500. Deep and shallow
planning have the same bound after occurrence acquisition; a cache miss still
pays bounded construction cost.

## Worker and residents

`matches-window/1` accepts a position or rank anchor, rows before/after,
context-token width, and `includeAxis`. It accepts no caller selection. Results
carry exact total, anchor rank, first returned rank, rows, and optional fresh
sparse arrays. For position anchors, the preceding distinct-position bracket
lets the client keep a fractional rank without snapping the source cursor.

Left/right context marks come from the admitted occurrence tracks, with
context-relative UTF-16 spans and contributing track ordinals. They exclude
the row node, clip at context bounds, merge overlaps, and retain at most 32
mentions nearest the node on each side. Truncation flags also disclose text
caps. Only the sparse axis transfers buffers; row records are cloned and
resident occurrence buffers are never transferred.

The executor checks cancellation after preparation, each track acquisition,
numeric planning, and materialization. Its occurrence cache has simultaneous
five-entry/48-MiB ceilings; the separate small axis cache has five-entry/512-KiB
ceilings. Range/full-corpus entries compete within the same occurrence budget;
selection thrash must not be mistaken for guaranteed warm refills.

The store fences the current axis/window by snapshot and ordered matching-track
identity. The mounted surface requests a latest-wins window near a resident
edge or an external off-window position. Resident scrolling issues no query.
`setScrub` publishes the shared position and schedules the independent footer
passage, not Matches analysis.

An exact activation can carry a one-shot reveal target to disambiguate a row
from the corpus sentinel or same-token siblings. It is consumed on matching
window settlement and cleared on incompatible identity changes. A settled
reveal applies only at its document/token cursor. `setScrub` retires it on
movement without discarding resident rows. Programmatic reveal records that cursor
as self-published so resize and context changes preserve same-token rank. Raw or density
activation carries no invented occurrence provenance. Exact stepping collapses
a same-token cluster to one stop; without finer provenance, Matches reveals its
first row. Activation may re-enable its track but does not clear a range.

## Scroll geometry

The shared `SequenceLayout` owns document bases and corpus token counts.
Matches maps global token, logical fractional rank, bounded physical scroll,
and resident/overscan rank through pure view geometry.

```text
physical extent = min(totalRows × rowHeight, SAFE_SCROLL_EXTENT)
logical 0       = corpus-start sentinel
logical i + 0.5 = occurrence row i
logical total  = corpus-end sentinel
```

Sentinels are positions, not rows. Occurrence centers remain half a row interval
inside corpus endpoints; no blank spacer scales with a source gap. Empty
results disable mapping and leave the cursor unchanged. Empty documents own no
token position. A one-token corpus may map distinct scroll positions to the
same token.

Rows retain fixed pitch around the viewport's midpoint even when the physical
scroll range is compressed. A bounded overlay renders visible/overscan rows;
resize and font settlement preserve the logical anchor, not raw `scrollTop`.
Sparse samples supply a monotone approximation outside the resident window;
exact correction stays anchored at the midpoint and cannot oscillate.

Duplicate ranks share a token. Between distinct positions, rank/token mapping
interpolates without rewriting the external cursor. Generic external movement
chooses the leftmost coordinate at a token; a reveal target selects the intended
row. Source-gap interpolation and sentinels make the mapping invertible apart
from integer rounding. Programmatic scroll is immediate, frame-fenced, and
compared with the self-published rank/cursor to prevent feedback loops.

## Layout and accessibility

The usable scrollport excludes header, controls, dock, navigation, safe areas,
and visual keyboard. Its pointer-transparent midpoint line is hidden from
assistive technology. Non-interactive corpus-edge bands name the exact distance
to first/last occurrence without adding rows or changing geometry; equivalent
hidden descriptions are exposed once.

Columns exactly partition the port; Matches has no horizontal scroll axis.
Context tracks store a scale-independent left/right ratio. Node, book, and
token tracks retain preferred character widths; automatic book/token labels
adapt to the measured port. Narrow ports can shrink fixed tracks. Column
resizing is session-unlocked, pointer-captured, and keyboard-operable; cancelled
capture restores committed widths. Context clipping preserves the left tail
and right beginning. Highlights reuse occurrence projection, never rematch text.

The virtual grid contributes one Tab stop and an `aria-activedescendant` for
the pinned active row, with logical row count/index metadata. Keyboard movement
requests bounded off-window rows, Enter opens Reader, and Reader Back restores
the stable grid. Recycled row controls are not individual Tab stops. Native
table roving-focus helpers cannot own this recycling lifecycle.

## Verification

Core fixtures compare exact position/deep-rank windows with a full merge oracle,
including 160-row duplicate runs, phrase membership, sparse boundaries, empty
results, foreign identities, and both occurrence bounds. Geometry tests cover
gap/duplicate inverses, endpoint sentinels, capping, resize, and feedback fences.

Browser checks cover footer/Matches synchronization, exact reveal targets,
zero-query resident scroll and range changes, bounded DOM, active-descendant
survival, no skipped endpoint rows, and a midpoint within one CSS pixel across
supported viewports. Continuous scrolling retains the 100ms long-task gate.
Performance claims must include deep-window cache misses and five-term
selection thrash, not just warm lookup.
