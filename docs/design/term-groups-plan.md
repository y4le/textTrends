# Term groups + query notebook — Slice 1 plan

*Slice 1 of the adopted build order (synthesis §11 addendum, 2026-07-29 roadmap
audit). Branch `feature/product-slices`. The governing Codex planner ruling
(`req_consult_1f290683aa4f5640`, Parley session `ses_44293cff245eacef`) is
recorded below VERBATIM. The five-commit sequence A–E is the implementation
order; every commit gets a Codex review-diff.*

---

Ruling: approve Slice 1 with blocking amendments. The overall product direction is right, but do not make `TermGroupSpec.id` serve simultaneously as user-interface identity, semantic/cache identity, and persistence identity; do not silently truncate an open-ended notebook to five tracks; and do not expose arbitrary affix/phrase authoring until the shared contract rejects empty and pathological inputs.

One terminology correction matters for implementation: the existing `MatchMode` values are `sensitive | folded`, not `exact | folded`. The UI may say “Exact,” but stored and wire values must remain `sensitive`.

## 1. Data model

Adopt stable UUIDs, but keep the notebook model distinct from the core query spec:

```ts
interface NotebookGroupV1 {
  id: string; // stable UUID
  name: string;
  members: readonly GroupMember[];
  countOverlaps: boolean;
}

interface QueryNotebookV1 {
  schema: "texttrends/query-notebook/1";
  groups: readonly NotebookGroupV1[];
}
```

Derive the core value as `{ id, members, countOverlaps }`. Do not add `name`, `muted`, `solo`, or style state to `TermGroupSpec`; those are presentation/query-selection concerns. Give members stable UUIDs too: editing a member preserves its ID, replacing or adding one creates a new ID. Inject the UUID factory into pure actions/builders so tests stay deterministic; call `crypto.randomUUID()` only at an action boundary.

There are two identities with different jobs:

- `group.id` is stable UI/notebook identity. Rename and semantic edits preserve it. Focus, style assignment, selection, and editor state use it.
- `termGroupIdentity(group)` is semantic identity. Worker occurrence caches and stale-result admission use it. Names, mute state, and style do not affect it.

Do not hard-cap the notebook at five. Set a separate generous product guard such as `MAX_NOTEBOOK_GROUPS = 64`, while preserving `MAX_KWIC_TRACKS = 5` as the maximum active comparison tracks. A notebook may contain more than five groups, but at most five may be active. Never implement “first five unmuted” as an implicit truncation rule: refuse the sixth activation with an explicit message. Batch quick-add must not silently activate only part of the batch; either reject atomically or create the excess visibly inactive and report that outcome. I prefer atomic rejection for v1.

Model “muted” as membership in `activeGroupIds`, not a property on the semantic group. Active order is notebook order filtered by that set. Preserve a group’s assigned style slot through rename, member edits, and reorder; active slots must remain unique.

Solo is transient view state (`soloGroupId: string | null`), not serialized group data. In v1 allow solo only for an active group. It temporarily projects the effective active set to that one group without mutating `activeGroupIds` or the concordance filter; clearing solo restores the prior state exactly. Removing the soloed group clears solo.

The app needs one additional stale-result guard. Maps may remain keyed by the stable group UUID, but every issued trend/KWIC/passage intent must also capture the current `termGroupIdentity`. A result may commit only when both its request/epoch and semantic identity still match. Otherwise a member edit under the same UUID can admit a result for the previous semantics. A rename must not requery; a member or `countOverlaps` edit must invalidate and reissue all affected evidence.

Before the member editor lands, strengthen the shared admission contract. Today an empty prefix or suffix stem can resolve against every vocabulary entry, and the narrowers admit empty or effectively unbounded structures. Export and reuse one set of v1 limits/validation in core and the protocol narrower. At minimum enforce:

- nonempty, unique group/member IDs, with bounded ID length;
- 1–32 members per group;
- nonempty, bounded token/stem/surface strings;
- phrases of 1–16 nonempty surfaces;
- legal `sensitive | folded` modes;
- bounded app names (for example, nonblank NFC and at most 128 code units);
- no duplicate semantic members in one app-authored group.

The app should canonicalize user text to NFC. A one-surface phrase may be canonicalized to a token. This is validation hardening rather than a protocol feature addition, so it need not change protocol version, but it deserves protocol-level tests and the production-build gate.

## 2. Persistence

Use store-only session state in Slice 1, with the versioned `QueryNotebookV1` codec/validator defined now. Be explicit in release notes and the UI that this iteration is session-scoped and does not yet fulfill the roadmap’s “persistent notebook” promise.

Reject the proposed localStorage/IDB “class-3 stash.” A hand-authored notebook is irreplaceable class-1 user data, not an evictable derived cache, and an ad hoc stash would create a second persistence authority beside the project store. A share URL is transport, not local durability; nuqs should not be allowed to define the only canonical representation after the fact.

When durability is pulled forward, use the same versioned notebook codec in either a deliberate class-1 workspace record or a manifest V2 after deciding how query workspaces attach to built-in/read-only corpora. That deserves a migration/CAS/reload-tested storage commit. If reload persistence becomes a hard acceptance condition for Slice 1, insert that commit rather than smuggling persistence into a UI change.

## 3. UX

Keep quick-add, but make it append-only and clearly subordinate to the notebook. After submission it clears; it is no longer the authoritative rendering of the group list. Each comma item creates a named, single-token, folded/folded group.

The notebook panel should provide add, rename, remove, active/mute, solo, reorder, member editing, and counts. Use accessible Up/Down controls for v1; drag-and-drop is optional polish, not a requirement. Preserve the current separate chart-focus and concordance-selection concepts.

Mute and `kwicEnabledSeries` must remain orthogonal:

- active/mute controls whether the group participates in the global comparison: trends, passage marks, and eligibility for KWIC;
- the concordance toggle controls only whether an effective active group is included in the KWIC panel;
- focus remains chart emphasis only;
- solo is a transient projection of the active set.

Effective KWIC groups are `effectiveActiveGroupIds ∩ kwicEnabledGroupIds`. Do not collapse mute into the KWIC toggle; that would remove the useful ability to hide one concordance track without changing the chart or passage annotations. Use distinct labels such as “Shown in analysis” and “Included in concordance,” not two visually identical eye controls.

Use an explicit draft-and-Apply editor so keystrokes do not launch worker queries. “Alias” means another OR member; it is not a second expression language. If shorthand is accepted, define it narrowly:

- one trailing `*` means prefix;
- one leading `*` means suffix;
- bare `*`, both ends, and internal asterisks are errors;
- quotes are only an editing convenience and are compiled to an explicit phrase member.

Do not silently split phrases on arbitrary whitespace as the canonical rule. Prefer ordered token chips. If quote-to-phrase uses tokenization, run the same `Intl.Segmenter` adapter for the selected/effective language and show the compiled tokens for confirmation; otherwise defer that convenience. Keep `crossSentence` false and out of the basic editor for now.

Default `countOverlaps` to `false`, matching current app behavior. Explain it in user language: off counts overlapping aliases/phrases once; on counts every member match and can intentionally double-count overlapping evidence.

Live totals must have explicit states. Show a number only for a ready result whose UUID and semantic identity match the current group. Inactive means “Not run”; pending and error are distinct; corpus-partial totals must be labeled partial. Zero-hit is a real ready state, not a missing result.

The full corpus-aware query composer promised in the synthesis addendum is not completed by this quick-add/member editor. Vocabulary-backed suggestions and precommit hit estimates require a bounded vocabulary query operation and, under the simplification plan, the just-in-time `QueryExecutor` work. Record that as a follow-on vertical; do not claim it complete in Slice 1.

## 4. Amended commit sequence

Use five reviewed commits rather than four.

### A. Harden group admission

Add shared limits/validation in core and reuse it in wire narrowing before arbitrary authored members become reachable. Cover every member kind and both match dimensions, empty affixes/tokens/phrases, maximum sizes, duplicate IDs, and malformed shapes. Preserve a golden test for `termGroupIdentity`, including member order and `countOverlaps`.

Verification: root typecheck and unit suites; production build plus the bundle check because this touches core/protocol admission.

### B. Behavior-preserving notebook/store cutover

Introduce the versioned notebook module, injected ID creation, semantic snapshot keys, and derived active track intents. Keep the existing comma-input UI and replacement behavior for this commit only. Reconcile surviving simple groups by their previous NFC semantic identity so their newly assigned UUID, focus, style, and concordance selection survive ordinary edits where possible. Remove `groupFor()` and pass exact authored specs through the store.

Tests must prove stable UUIDs across rename/member edits, stable member IDs on edit, rename causes no worker request, a semantic edit under the same UUID rejects the old result and reruns trend/KWIC/passage, all exact group fields reach each operation, and focus/concordance state is normalized after removal.

Verification: typecheck and unit suites. A production build is optional here because neither protocol nor storage format changes.

### C. Notebook panel and active-set UX

Make quick-add append-only; add rename/remove/reorder/active/mute/solo and correctly qualified live totals. Delete the temporary replacement-mode transition code. Preserve style identity and make the five-active limit explicit.

Tests must cover more than five visible notebook entries, refusal of a sixth activation with no silent truncation, batch-add behavior, reorder preserving IDs/styles/focus, removal cleanup, mute versus concordance orthogonality, solo/restore, and count status transitions. Include keyboard and accessible-name/pressed-state assertions.

Verification: typecheck and unit suites; production build and bundle check for the material UI/chunk change.

### D. Member editor and evidence identity

Add alias/token/phrase/prefix/suffix editing, per-member match toggles, overlap control, validation messages, explicit Apply, and zero-hit surfacing. At the same time fix the KWIC view projection: retain enough of `groupId`, `members`, and node span to render/identify evidence correctly. The current `${seriesId}:${doc}:${pos}` row key is insufficient when `countOverlaps` yields multiple member/span matches at the same start; use a stable full evidence key including series/group, document, start, node end, and contributing members.

Tests must cover parser/compiler edge cases, empty-affix rejection, mixed sensitive/folded members, a multi-token phrase’s full KWIC node text, two valid overlap rows at the same position with distinct keys, and the semantic-edit stale-result race. Also verify passage marks use the full phrase span.

Verification: typecheck and unit suites; production build and bundle check.

### E. Browser acceptance

Add a deterministic fixture-corpus Playwright spec proving that a multi-member group drives trends, passage, and KWIC; phrase and prefix members merge as OR alternatives; KWIC shows the complete phrase span; mute removes the track globally; the concordance filter remains orthogonal; solo restores state; and a valid query can display zero hits. Include at least one match-mode assertion if the fixture supports a clear case/diacritic distinction. No live network.

Verification: targeted Playwright while developing, then the full functional/e2e matrix at phase end. Fix any product bug in D or a separate remediation commit before landing a test-only commit that depends on it.

If durable notebook persistence is pulled into this slice, insert a separate storage commit between B and C with migration, compare-and-swap/conflict, built-in-corpus, reload, and production-build coverage.

## 5. Required invariants and risk rulings

1. A UUID identifies a notebook object; `termGroupIdentity` identifies its matching semantics. Neither substitutes for the other.
2. Rename, reorder, focus, style, mute, and concordance selection never alter semantic identity or trigger unnecessary occurrence work.
3. Member or overlap edits preserve group UUID but change semantic identity and invalidate trend, KWIC, and passage evidence.
4. No async result commits unless request epoch, corpus snapshot, group UUID, and issued semantic identity are all current.
5. Notebook order is explicit; active track order is the ordered active subset; it is unique and never exceeds five. Nothing is silently dropped.
6. Removal cleans group results, active state, focus, solo, concordance selection, editor drafts, and style ownership. Muting destroys none of those durable notebook semantics.
7. Focus, solo, active/mute, and concordance selection are separate state machines with explicit normalization. Effective KWIC is always a subset of effective active groups.
8. Every user-authored group accepted by the app also passes the same core/wire semantic validator. Empty affixes can never reach resolution.
9. `countOverlaps` defaults false. When true, evidence rows at identical positions remain independently renderable and keyed.
10. Multi-token phrase KWIC and passage spans include the entire phrase, while context remains correctly bounded.
11. A displayed total is never stale or ambiguously partial; “not run,” pending, error, ready-zero, and partial-ready are distinguishable.
12. Group names are presentation text only, normalized and rendered as text, never treated as IDs, cache keys, or markup.
13. This slice introduces no durable project-schema change and no new persistence authority.

The largest missed risk was not phrase rendering itself—the core KWIC materializer already supports multi-token node spans—but the UI projection discarding that evidence and using a colliding row key. The second is empty-affix amplification in the current permissive contract. Both are blocking fixes before the member editor is considered complete.
