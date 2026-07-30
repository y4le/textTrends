# Durable research state and source-free sharing — plan

*The durable-state/share phase selected with product Slices 3 and 4. Governing
Claude Opus planner ruling: Parley request
`req_consult_a2002d56c2327772`, session `ses_cad54a4d184a8c0d`, artifact
`art_sha256_c27b4b4a264a71518248b3c59162d88624c4852049b44c9f631cd550c4d0c842`.*

**STATUS: PLANNED (2026-07-30).**

## Storage boundary

Research state is a separate class-1 user-data record with the same project
ID and its own compare-and-swap revision. It is not embedded in or referenced
from `ProjectManifestV1`, and it is not an artifact-cache entry.

The four reasons, recorded explicitly:

1. A research edit must not deep-hash and rewrite a corpus manifest; the edit
   cadences and conflict domains are different.
2. Corrupt research state must never block opening an otherwise valid corpus.
3. The built-in Sherlock manifest is intentionally read-only, while its
   notebook, named selections, and pins must still persist locally.
4. Irreplaceable authored class-1 data must not share eviction or repair
   semantics with derived artifact caches.

The shape is an exact versioned record:

```ts
interface ResearchStateV1 {
  readonly schema: "texttrends/research-state/1";
  readonly project: string;
  readonly revision: number; // safe integer >= 1
  readonly notebook: QueryNotebookV1;
  readonly active: readonly string[];
  readonly kwicEnabled: readonly string[];
  readonly selections: readonly SavedSelectionV1[]; // <= 32
  readonly pins: readonly SavedPinV1[];             // <= 8
  readonly views: {
    readonly trend: TrendViewV1;
    readonly inventory: InventoryViewV1;
    readonly keyness: KeynessViewV1;
  };
}
```

Style slots are not stored: they are derived deterministically by
`reconcileStyleSlots` from active order. Focus, solo, and other presentation
state are also absent. This deliberately resolves an inconsistency in the
planner ruling, whose example record included `styleSlots` while its authority
rules classified them as derived/ephemeral; derivation is the controlling
decision and preserves a single style-slot authority.

Core is the sole admission authority. Before this schema lands,
`parseQueryNotebook`, `NOTEBOOK_LIMITS_V1`, and the member-shape guard move
mechanically to `packages/core/src/project/notebook.ts`; the app module
re-exports them while retaining app-only editing/style helpers. Duplicating
the notebook validator in the worker is forbidden.

`parseResearchState(value: unknown)` is total, exact, bounded-before-scan, and
rejects sparse arrays. It refuses an active set above `MAX_KWIC_TRACKS`; it
never silently truncates to five. IDs in `active` or `kwicEnabled` that are
absent from the admitted notebook are dropped during restoration. Any other
deep-parse failure, including an over-cap active set, classifies the stored
record as `DATA_CORRUPT`: the raw record is retained and never overwritten.

`upgradeStoredResearchState(raw: unknown): unknown` runs on read before deep
validation. It is identity in v1 but establishes the migration seam. A future
migration may touch only recognizably old records and never “repair”
corruption.

## Store and protocol

The user-data database gains a dedicated research object store in a schema
migration. `UserDataStore` and its in-memory parity implementation expose:

```ts
getResearch(project: string): Promise<ResearchStateV1 | null>;
putResearch(
  next: ResearchStateV1,
  expectedRevision: number,
): Promise<{ revision: number }>;
```

The record's revision is the sole CAS authority. A mismatch is
`REVISION_CONFLICT` and includes `currentRevision`. A stored record that fails
even its shallow envelope check is `DATA_CORRUPT`, retained, and never
overwritten. A closed store rejects instead of masquerading as a miss.
Research operations do not touch the artifact cache.

Protocol arms are `research-load`, `research-loaded`,
`research-missing`, `research-save`, and `research-saved`, reusing
`user-data-error`. There is no delete arm in v1.

Conflict UX never auto-merges. It says that the project was edited in another
tab and offers Reload (discard local semantic edits) or Overwrite (save
against the now-current revision).

## Semantic and ephemeral state

The generating rule, recorded verbatim:

> A field is semantic iff a colleague reproducing your finding needs it.

Semantic state includes:

- notebook groups, members, overlap flags, names, and order;
- active group IDs and KWIC-enabled IDs;
- trend view (`series`/`by-book`) and section-marks toggle;
- focused document;
- inventory filter, sort, and page size;
- keyness side membership expressed by TextHash lists, filters, sort, and
  page size;
- named saved selections;
- saved pins for durability only (pins are not shared).

Ephemeral state includes the live linked token selection, scrub and passage
positions, reader navigation, KWIC center, chart-focused series,
`soloGroupId`, table page offsets, style slots, hovers, pending/loading/error
state, editor drafts, announcements, and bootstrap state.

Autosave runs 1.5 seconds after the last semantic change and immediately on
`visibilitychange: hidden`. Renames are semantic; focus, solo, scrubbing, and
page navigation do not schedule saves. A research load/save failure is
visible but never blocks analysis.

## Durable character anchors

Token coordinates are never durable authority. The only durable coordinate
is:

```ts
interface CharAnchorV1 {
  readonly doc: string;
  readonly text: string; // TextHash
  readonly chars: { readonly start: number; readonly end: number };
}

interface SavedSelectionV1 {
  readonly id: string;
  readonly name: string;
  readonly anchor: CharAnchorV1;
}

interface SavedPinV1 {
  readonly id: string;
  readonly note: string;
  readonly anchor: CharAnchorV1;
  readonly captured: readonly {
    readonly seriesId: string;
    readonly groupId: string;
    readonly identity: string;
    readonly label: string;
  }[];
}
```

At most 32 named selections and eight durable pins are admitted. A ninth pin
is refused visibly, matching the existing session cap.

Two named operations bridge transient and durable coordinates:

- `anchor-tokens/1`: one validated token range to its TextHash and UTF-16
  character anchor using canonical token starts and `tokenEndChar`;
- `compile-anchor/1`: up to 64 anchors to per-anchor `ok` token range,
  `empty`, `text-mismatch` with expected/actual hashes, or `missing-doc`.

The restore-behavior table is:

| Change after save | Restore |
|---|---|
| tokenizer/index recipe changes, same TextHash | Recompile character span to current tokens |
| extraction/source changes TextHash | Retain in “needs review”; never guess |
| structure correction changes | Recompile normally; structure is irrelevant |
| declared document order changes | Recompile by document/TextHash; order is irrelevant |
| document missing | Retain as unavailable |

Saved selections reapply by compiling to a current live token range. Saved
pins re-resolve their passage using the labels/semantic identities captured
at pin time. A mismatch is visibly quarantined rather than silently
re-anchored.

## Share link contract

Sharing is transport, not durability. The bespoke v1 record is:

```ts
interface ShareLinkV1 {
  readonly s: 1;
  readonly n: QueryNotebookV1;
  readonly a: readonly number[]; // active group indices
  readonly k: readonly number[]; // KWIC-enabled group indices
  readonly v: {
    readonly t?: TrendViewV1;
    readonly i?: InventoryViewV1;
    readonly y?: KeynessViewV1;
  };
  readonly x: readonly {
    readonly d: string; // sender doc id, only to map anchors
    readonly h: string; // TextHash
    readonly t?: string; // bounded title hint, rendered as text
  }[];
  readonly r?: readonly CharAnchorV1[];
}
```

Encoding is `canonicalJson` → UTF-8 →
`CompressionStream("deflate-raw")` → unpadded base64url in the URL fragment
`#s=<payload>`.

A fragment is a privacy requirement: it is not sent in an HTTP request, does
not reach static-host logs, and does not ride in a `Referer` header. The owner
ratified replacing the earlier aspirational `nuqs` choice for this feature:
`nuqs` is query-string oriented, adds no compression, and would not reduce the
small bespoke codec.

Caps:

- `SHARE_MAX_URL_UNITS = 8_192` for the full URL. Encoding refuses above the
  cap with a message naming what the user can drop; it never truncates.
- `SHARE_MAX_INFLATED_BYTES = 256 * 1024`, enforced while inflating and before
  JSON parsing as a decompression-bomb guard.
- Decoded records go through total `parseShareLink` and
  `parseQueryNotebook`, with exact records, dense arrays, and bounds checked
  before scanning.

Matching is by TextHash, never sender document ID. Sender IDs only associate
anchors with the `x` hash entries.

- all matched: apply all shareable state;
- partial: apply notebook/views and matched anchors, retain a banner naming
  the number of unmatched documents;
- none matched: still apply notebook/views and name missing title hints;
- never auto-fetch anything named by a link.

The payload contains group specs/names, semantic view configuration, content
hashes, and character coordinates. It contains no source text, excerpts,
KWIC rows, passage text, captured pin evidence, file paths, or source bytes.
Pins are not shared in v1; their source-free anchors may be shared and
re-pinned by the recipient. The copy UI previews a payload summary before
copying. Tests scan decoded/encoded fixtures for known corpus substrings.

`TrendViewV1`, `InventoryViewV1`, and `KeynessViewV1` in the share record are
the same exact semantic view records stored in research state. Including the
trend section-marks toggle intentionally widens the planner's compact
`"series" | "by-book"` proposal because the ruling's semantic-field rule says
a colleague needs that toggle to reproduce the view.

## Owner ratifications

The owner ratified the bespoke compressed fragment codec and the eight-pin
durability cap on 2026-07-30. `docs/design/product-decisions.md` records the
provenance; the other four cross-phase ratifications are summarized in the
Slice-3 plan. None remains an unacknowledged planner recommendation.

## Reviewed commit sequence

### 5A — notebook codec to core

Move the admission authority mechanically and keep import-boundary and
existing notebook fixtures green.

### 5B — research schema, store, and CAS

Add core schema/parser/migration, IDB and memory store parity, protocol arms,
handler routing, corruption retention, CAS conflicts, and closed-store tests.

### 5C — character-anchor operations

Add both operations and exact round-trip, recipe-change, mismatch,
missing-document, empty-anchor, and structure-independence coverage.

### 5D — session load/restore/autosave

Wire research lanes into project lifecycle, built-in support, semantic-change
debounce, hidden-page flush, anchor restoration, visible errors, and explicit
conflict actions.

### 5E — saved selections and durable pins UI

Add save/reapply lists, notes, caps, captured labels, unavailable and
needs-review quarantine.

### 5F — share codec and UI

Add fragment encoding/decoding, caps and bomb guard, hostile-input admission,
payload summary, TextHash matching, partial-load banners, and privacy tests.

### 5G — browser acceptance

Author, save, pin, reload, share into matching and mismatching corpora, and
exercise a two-tab conflict with Reload/Overwrite.

Every nontrivial commit is reviewed through Parley to `looks-good`. Storage,
protocol, core-surface, and bundle changes run root typecheck, all units,
production build, and the bundle contract. Phase end also runs full functional
Playwright and serial benchmarks without live network.
