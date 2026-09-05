# Review implementation

Follow-up to the [fresh review](full-review-2026-09-04.md). All ten numbered findings are addressed.
Important implementation and architecture choices were discussed with Opus through Parley, and
each focused commit received an Opus review of its exact staged candidate before committing.

| Finding | Result | Commit |
| --- | --- | --- |
| 1 | Demo replacement acquires and admits sources before replacing research; failures preserve the prior workspace. | `155ce25` |
| 2 | Workspace save failure and retry remain visible across analytical views and Reader. | `473982b` |
| 3 | Healthy research opens around damaged saved items; unavailable active references survive autosave and support targeted repair/removal. | `61d9e83` |
| 4 | Failed lazy views preserve navigation, offer reload/Inputs recovery, and hand focus to the recovered view. | `d22e7d7` |
| 5 | EPUB chapter admission follows declared manifest paths, with one shared extraction budget. | `556e64f` |
| 6 | IndexedDB v2 separates metadata from bodies; upgrade is atomic and preserves original data on failure. | `79aeb00` |
| 7 | Source deletion confirms the named text and warns when it will also leave Active inputs. | `006f66e` |
| 8 | Library search is literal; Vocabulary regex uses a lazy, pinned RE2JS engine and recoverable unsupported-syntax errors. | `cc3322a` |
| 9–10 | Import copy lists supported extensions; “Reverse rankings” matches the Compare action and its accessible name. | `96b46bb` |

The [application composition note](../architecture/application-composition.md) records the
architecture boundaries, stylesheet-order proof, and deliberate follow-ups. The work retains one
composed runtime, immutable identity fences, operation leases, existing query policy, and the
current browser-local workspace model.

Validation results are recorded after the completed stack, separately from the historical baseline
in the original review. The earlier interrupted browser run was invalidated by two builds sharing
`apps/web/dist`; subsequent browser builds were serialized. Two earlier timing-sensitive checks
were corrected to establish their intended state before measuring navigation or playback; a third
received the same 30-second Matches readiness allowance as its siblings. All three then passed
repeated runs. None of those interrupted or failed runs is counted as a passing suite.

## Completed-stack validation

- `pnpm test`: 55 script tests and 1,724 Vitest tests passed; one live-provider test skipped.
- Chromium functional and compact WebKit: 295 passed, 18 conditional skips.
- Isolated Chromium benchmark project: all five checks passed. Cold all-ready 539 ms, warm
  reopen 186 ms, cancellation acknowledgment p95 0.3 ms. Atlas had no attributed task at or above
  100 ms in the gated interaction windows.
- `pnpm build`: recursive typechecks, production build, and bundle contract passed. Entry
  82,685 gzip bytes against the 90,000-byte budget.

The subsequent removal of unused library regex-error styles also passed the focused library
search browser case and a fresh production build.

These are local results for the tested corpus tiers and browser projects. They do not constitute
physical-device, screen-reader, live-provider availability, or larger-corpus performance claims.
