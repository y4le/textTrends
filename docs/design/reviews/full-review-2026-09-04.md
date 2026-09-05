**textTrends review — 2026-09-04**

Reviewed commit `0b4e896`. This is a review and proposed work order; application code was not changed.

The ten numbered findings have since been addressed; see the [implementation record](implementation-2026-09-04.md). The observations, verification, and source line references below describe the reviewed commit.

textTrends has a capable analytical core and a distinctive, coherent reading experience. Its best feature is the connection between a position in a chart and the actual passage. The largest opportunities are protecting research state, making measurements self-explanatory, and reducing the amount of application policy concentrated in a few files.

I would prioritize reliability and interpretation before expanding the feature set. Three reproduced failures affect saved work or access to it. The core's identity checks, bounded results, and separation from browser infrastructure are foundations to retain.

**Evidence and scope.** I reviewed the five workbench places, the Terms workflow, Read and Speed, acquisition and persistence, application state and routing, worker/client boundaries, representative extraction and statistical kernels, build configuration, and test coverage. I exercised the app in isolated browser contexts with the Sherlock sample and small imported files, inspected desktop and 390px layouts, and injected specific failures. The build and unit checks passed. Browser-suite results are recorded at the end. This is broad coverage, not a claim that every branch or statistical method has been independently proved.

The findings below distinguish reproduced failures, directly observable behavior, and architectural recommendations. P1 means address before relying on the app for substantial research; P2 means a material reliability or usability issue; P3 means a smaller clarity fix.

1. **P1 — A failed replacement demo clears existing research. Reproduced.**

   In [demo-loader.ts](../../../apps/web/src/lib/demo-loader.ts#L103), replacement calls `clearActiveInputsAndTerms()` before `library.add()` and before loading the saved files for activation. Fetch verification succeeds first, but storage and activation can still fail afterward.

   Reproduction: create a workspace with `my-research.txt` and the term `Hello`; open `?demo=austen` while making source-file writes throw `QuotaExceededError`. Before: one active text and one term. After: zero texts and zero terms, with “The austen demo could not be loaded.” Existing source bytes survive in the library, but the research configuration has been cleared.

   Stage acquisition and validate activation before committing replacement. Treat the corpus, terms, and comparison configuration as one replacement operation, with persistence observing only the committed outcome. If activation can fail after the commit begins, restore the previous configuration. Add failure coverage for library writes, source reads, and activation refusal; the existing tests cover fetch failure only.

2. **P1 — Workspace save errors are hidden in the analytical views. Reproduced.**

   The store records failures correctly in [store.ts](../../../apps/web/src/lib/store.ts#L6323), but the ordinary error/retry UI exists only in [ProjectPanel.tsx](../../../apps/web/src/components/ProjectPanel.tsx#L790). Debug exposes the state separately.

   Reproduction: import a text, switch to Trends, reject writes to the `workspace` object store, and add a term. Trends displays the new term and results without a save warning. Switching to Inputs reveals “Workspace could not be saved … retry.” Someone continuing analysis has no visible reason to know the changes are unsaved.

   Put persistence status and a persistent failure/retry action in shared application chrome, including Reader. Keep routine successful saves unobtrusive; make failure visible where the user is working. Test a save failure originating outside Inputs and verify recovery clears the warning.

3. **P1 — One damaged unused library record prevents the healthy workspace from opening. Reproduced.**

   [local-library.ts](../../../apps/web/src/lib/local-library.ts#L177) throws on the first invalid record while listing the entire library. [store-instance.ts](../../../apps/web/src/lib/store-instance.ts#L165) requires that listing during bootstrap. The exception prevents session attachment.

   Reproduction: save a healthy active text, add a malformed *unused* record to `files`, and reload. The app reports “a saved local file is damaged — reload the page to retry”; the import controls are unavailable. Reloading encounters the same record again. Debug's full reset is much broader than the actual damaged item.

   Return healthy entries together with damaged-record diagnostics. Preserve damaged bytes for recovery, identify affected active documents, and provide targeted removal or quarantine. An unrelated damaged file should not block healthy files or force a full-library reset. Keep byte integrity validation at the point of actual source use.

4. **P2 — A failed lazy page import blanks the entire app. Reproduced against the built app.**

   [main.tsx](../../../apps/web/src/main.tsx#L14) has no error boundary. [App.tsx](../../../apps/web/src/App.tsx#L51) uses lazy imports and Suspense, which handles waiting but does not recover from a rejected import.

   Reproduction: import a text, abort the `ComparePlace-*.js` request, and select Compare. The browser reports “Failed to fetch dynamically imported module” and `#root` has zero children. Navigation and recovery controls disappear with the page.

   Add an application fallback and a place-level boundary that preserves usable navigation and provides a clear reload/recovery action. Account for React.lazy retaining a rejected import when designing retry. Test failed imports, in addition to the existing tests for delayed imports.

5. **P2 — EPUB acquisition ignores manifest-declared chapters unless their filenames end in lowercase `.xhtml`. Reproduced.**

   The ZIP filter in [epub.ts](../../../packages/epub/src/epub.ts#L60) admits only `container.xml`, `.opf`, and `.xhtml`. Later, [opf.ts](../../../packages/epub/src/opf.ts#L186) selects spine items by their declared `application/xhtml+xml` media type. These policies disagree.

   I built four otherwise equivalent small EPUBs with a matching OPF manifest. `chapter.xhtml` parsed; `chapter.html`, `chapter.htm`, and `chapter.XHTML` all failed with “EPUB is missing spine document,” even though the file was present in the archive.

   Discover the package and required spine paths from the container and manifest, then admit those exact archive entries while preserving the aggregate decompression budget. Extending the extension allowlist would cover examples but leave the underlying dependency on filename spelling.

6. **P2 — Listing library metadata reads every saved source into memory. Instrumented reproduction.**

   [local-library.ts](../../../apps/web/src/lib/local-library.ts#L177) uses `getAll('files')`; each value contains its full `ArrayBuffer`. `list()` discards the bytes only after retrieval. This work is also requested by bootstrap and by multiple refresh paths in [ProjectPanel.tsx](../../../apps/web/src/components/ProjectPanel.tsx#L117).

   Instrumenting a real Chromium IndexedDB request with eight inactive 1 MiB files showed that returning eight metadata items retrieved 8,388,608 source bytes. The cost scales with the entire saved library, including inactive texts, rather than the active corpus. This is an I/O and allocation finding; I did not extrapolate a large-corpus latency number from it.

   Separate lightweight metadata from source blobs, maintain their relationship transactionally, and let listing query metadata alone. A shared library subscription can also replace overlapping refresh triggers. Verify that startup and opening Inputs do not retrieve inactive source bodies.

7. **P2 — A single library-row click permanently deletes a source and removes its active document. Observed behavior and code.**

   [ProjectPanel.tsx](../../../apps/web/src/components/ProjectPanel.tsx#L346) calls `localLibrary.delete()` directly. The small `delete` control is beside `add`; there is no confirmation or undo. Bulk deletion asks for confirmation, and term deletion offers undo, so recovery expectations differ across neighboring workflows.

   Use a reversible deletion window or a targeted confirmation that names the text and states whether it is active. Keep ordinary removal from active inputs lightweight. A reader should be able to tell whether an action removes a text from the current analysis or destroys its saved copy.

8. **P2 — User regexes can block the UI or the shared analysis worker. Code path confirmed; bounded timing reproduction.**

   [ProjectPanel.tsx](../../../apps/web/src/components/ProjectPanel.tsx#L86) evaluates the library regex synchronously during rendering, for every filename. [frequency.ts](../../../packages/core/src/ops/frequency.ts#L355) applies native regexes inside the shared worker's vocabulary loop. Syntax validation and query-length limits do not bound the execution time of one match; cooperative checkpoints cannot interrupt a native regex already executing.

   The same library matching operation, `new RegExp('^(a+)+$', 'iu').test('a'.repeat(26) + '.txt')`, occupied a local Node process synchronously for approximately 1.6 seconds. This is evidence of the blocking mechanism, not a browser performance benchmark. Larger failing inputs can take substantially longer.

   Make library search literal by default, consistent with Vocabulary's default. If arbitrary regex support remains, use an execution strategy that can be interrupted or a restricted engine with bounded behavior. Debouncing and syntax validation alone do not solve the problem. Test recovery from a slow filter without discarding the corpus.

9. **P2 — The first-run import promise includes unsupported PDF files. Direct code/UI mismatch.**

   [ProjectPanel.tsx](../../../apps/web/src/components/ProjectPanel.tsx#L603) advertises “text, Markdown, HTML, EPUB, or PDF.” [SOURCE_FORMATS](../../../packages/core/src/extract/formats.ts#L47) contains TXT, Markdown, EPUB, and HTML only, and library admission rejects `.pdf`.

   Remove PDF from the copy and derive user-facing supported-format descriptions from the same catalog as the picker. PDF support would be a separate extraction feature, with its own reading-order and text-quality requirements.

10. **P3 — Compare's “Swap” action reverses rankings rather than exchanging inputs. Direct code/UI mismatch.**

    [ComparePanel.tsx](../../../apps/web/src/components/compare/ComparePanel.tsx#L154) flips `dirA` and `dirB` while leaving the selected texts unchanged. The visible button says “Swap,” while its accessible name expands that to “Swap — Reverse both rankings.” Beside two text selectors, “Swap” strongly suggests exchanging left and right texts.

    Rename the action “Reverse rankings,” or implement actual side exchange and expose ranking direction separately. Align visible text, accessible name, and behavior.

The following are **product recommendations**, rather than claims of broken computation.

| Experience | What I observed | Recommended improvement |
| --- | --- | --- |
| First visit | The screen immediately shows empty Active inputs, nine sample choices, an expanded 20-row catalog, an empty saved library with regex controls, and the Terms dock. The purpose is less prominent than the acquisition mechanics. | Lead with one sentence explaining the payoff, one import action, and one suggested sample. Put the remaining samples and catalog behind deliberate expansion; reveal empty-library management as it becomes useful. Preserve direct access for returning users. |
| First useful result | Importing one's own text leaves the user to choose a term. The Trends empty state gives a next action, but no concrete example from that text. | After import, offer “Track a term” and “Read this text.” Consider a few vocabulary-backed suggestions after the bounded vocabulary result exists. Keep suggested terms optional and explicit. |
| Trends interpretation | The default view provides position-linked lines and strips, but units, binning, and scale behavior require discovery through settings, Help, or the tour. | Add a compact caption reflecting current settings, such as “Occurrences per 10,000 tokens · 40 bins per text,” plus a clear explanation of equal versus proportional text widths. Keep it truthful when the settings change. |
| Compare interpretation | Default rows show values such as `8.297` without a visible metric label or axis ticks. The log₂ meaning is in accessible labels and details. Left and right terms share a row by rank, which can imply a pairwise relationship. | Show the metric and ranking criterion near the chart, label the shared scale, and explain that the two columns are independent rankings. Retain the useful row details and uncertainty options. |
| Vocabulary | The first view gives raw frequency and several technical dispersion columns equal prominence. Library and vocabulary filters use different default matching semantics. | Keep full analytical access, but consider a simpler initial column set and readable measurement labels. Make literal filtering consistent, with an explicit regex option. Make common-word filtering discoverable when the user wants distinctive vocabulary. |
| Mobile Trends | The plot is followed by Company and all twelve destination excerpts, creating a long page of results with little progressive disclosure. | Show a small initial set of reading destinations with “Show more,” and make the relation between Company selection and recommended passages explicit. The short path into a source passage deserves more prominence. |
| Taking work away | There is no production result-download or workspace-backup UI. The versioned result/provenance formatters exist in `provenance.ts`, but production code does not import that module. | Expose a scoped result export with the method, filters, corpus identity, and completeness information. Separately provide workspace backup/restore, including a clear choice about source bytes. Displayed rows and complete results must be distinguished when exporting bounded tables. |

Screenshots from the review: [first visit](full-review-2026-09-04-assets/first-visit.png), [Compare](full-review-2026-09-04-assets/compare.png), and [mobile Reader](full-review-2026-09-04-assets/reader-mobile.png).

The mobile Reader is a particularly good direction: prose dominates, position remains available, and the control bar keeps reading actions close. The wide Reader's source overview, shared highlights, and passage navigation make the analytical context useful while reading. Preserve those strengths when simplifying the surrounding app. The guided tour and keyboard/touch contracts are also valuable; the goal is to make ordinary screens understandable before a tour is needed.

For **architecture and cleanup**, I would work at the following seams.

| Area | Evidence | Concrete next step |
| --- | --- | --- |
| Application runtime | `store.ts` is 6,672 lines and combines state/types, workspace serialization, save scheduling, history, notebook edits, query issuance, and Reader/Find/Speed behavior. `App.tsx` adds 1,125 lines of navigation, shortcut, focus, and utility-pane policy. | Keep one composed store and runtime. Extract workspace persistence first, then navigation/history, then query controllers and Reader interaction. Give each unit explicit dependencies and disposal. Move shared domain types out of the runtime module so views need not treat it as a general contract barrel. |
| Large interaction components | `TrendPanel.tsx` is 2,867 lines, `WorkbenchFooter.tsx` 1,602, `KwicPanel.tsx` 1,210, and `QuerySurface.tsx` 806. | Separate rendering sections from controller hooks along existing concepts: trend stage, row presentation, range interaction, term authoring, and footer navigation. Reuse the existing pure gesture and geometry functions. Extract a whole responsibility at a time so the files become easier to reason about. |
| Styles | `tokens.css` is 8,609 lines of tokens, global rules, layouts, and feature styles; substantial inline styles remain in components. | Leave actual tokens and foundational rules in the shared stylesheet. Move feature rules into ordered feature stylesheets while preserving cascade order. Centralize recurring button/icon primitives when touching those features. Verify computed layout and browser behavior after moves. |
| Query scheduling | Every new snapshot calls `runQueries`, `runInventory`, `runFrequency`, and `runKeyness` in `acceptSessionState`, regardless of the visible place. | Measure the work performed during multi-file import and rapid selection changes. Keep data needed by shared chrome warm; consider deferred or idle work for hidden-only tables. Record work avoided, first-result time, and tab-switch latency before changing scheduling. This is an optimization hypothesis, not a measured regression. |
| Test coupling | Alongside strong behavioral tests, some tests read source files and require exact CSS strings or specific TSX ownership paths, for example `guide-anchors.test.ts`. | Keep source checks for genuine package and bundle boundaries. Prefer rendered semantics and behavior for UI ownership and styling contracts, so safe component extraction does not require rewriting incidental string assertions. |
| Unused capability and stale explanation | `provenance.ts` has tested formatters but no production consumer. Several source comments still narrate old slice/milestone transitions. | Connect the formatter to the proposed export surface or explicitly defer and isolate it. Replace historical implementation narration with current invariants, reasons, and boundary examples as files are touched. |

The existing separation between `core`, `extractors`, `epub`, `standard-ebooks`, and `rsvp` is appropriate. The worker/client boundary, immutable snapshots, content identities, operation leases, bounded caches, and pure view models solve real problems. I found stronger reasons to improve the application's composition and acquisition failure boundaries than to replace those foundations.

One browser-local workspace and last-write-wins persistence are explicit product decisions. A future second-tab notice or write-ownership mechanism would make that policy easier to live with, especially when opening comparison links in another tab. I would discuss that as a product tradeoff, not silently introduce merging or multiple-workspace semantics during cleanup.

My suggested **implementation order** is:

1. Protect research state: atomic demo replacement, shared persistence failure UI, and per-record recovery.
2. Make failures recoverable: error boundaries and manifest-driven EPUB admission. Fix PDF and Swap wording in small independent changes.
3. Improve trust in everyday actions: recoverable source deletion, bounded search behavior, visible measurement captions, and backup/export.
4. Refactor persistence and library metadata access while those boundaries are under test; then split the application runtime and the largest UI components incrementally.
5. Simplify first-run and mobile result presentation. Measure hidden analysis work and larger library/corpus behavior before optimizing scheduling or changing kernel architecture.

Verification: `pnpm test` passed 54 script tests and 1,678 Vitest tests across 145 passing files; one live Standard Ebooks test/file was skipped. `pnpm build` passed recursive typechecking, the production build, and the bundle contract. The production entry measured 82,229 gzip bytes against the 90,000-byte budget. The combined Chromium functional and compact WebKit run passed 286 tests with 18 conditional skips in 9.7 minutes. The isolated Chromium benchmark run passed all five checks in 30.2 seconds.

The benchmark reported 733 ms to all-ready for its cold sample, a 312 ms warm reopen, and 3.0 ms cancellation-acknowledgment p95 against the 250 ms gate. The 66-text, five-track Atlas stayed within its canvas budget and had no tasks reaching the 100 ms threshold in the attributed interaction windows. These local results support retaining the current engine architecture while improving acquisition and application boundaries; they do not establish performance at the larger deferred corpus tiers.

Manual failure probes used isolated browser storage. The damaged-record, storage-quota, and chunk-fetch errors above were deliberately injected to test recovery; they were not observed as spontaneous failures during the ordinary sample workflow. No physical-device, screen-reader, live-provider availability, or formal 10M/50M-token performance claim follows from this review.
