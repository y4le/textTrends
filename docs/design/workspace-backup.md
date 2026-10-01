# Workspace backup and restore

Inputs offers Save workspace file and Load workspace file. A backup contains
the entire healthy local library and the one active workspace. Loading replaces
active texts, notebook, and portable preferences; unrelated destination library
items remain. Imported identities take their archived bytes and library metadata.
On a fresh browser this recreates the saved setup without downloading sources.

## Portable state

`WorkspaceV1` remains the authority for text IDs, order, descriptive metadata,
terms/aliases/matching options/styles, shown terms, and Trends/Vocabulary/Compare
settings. The archive reuses `parseWorkspace`; it does not define a second
workspace validator. Warm extraction hints are omitted when saving.

Named preferences include theme/density, Speed pacing, Atlas normalization,
contextual trend-row sizing, and Matches/Vocabulary column proportions. Their
existing codecs validate wire values. Null means reset to the default. Browser
storage keys never come from the file. Tour progress, viewport measurements,
navigation, selections, cursor, open panes, undo, results, and worker caches do
not travel. Analysis is recomputed using the installed app's extraction recipes.

## File boundary

`workspace-backup.ts` reads/writes `.ttws`: ZIP32 with stored entries and no
archive comment. It contains `manifest.json` (schema
`texttrends/workspace-backup/1`) and `sources/<format>/<sha256>` entries. The
manifest contains creation time, workspace, named settings, and complete library
metadata, including original filenames. The v1 reader rejects compressed entries;
the writer feeds fflate in 256 KiB chunks with task yields. The reader validates
the bounded central directory, local headers, descriptors, contiguous offsets,
and CRCs, then reads source bytes by declared slice. It never scans payloads for
ZIP signatures: original EPUB bytes legitimately contain those signatures.

Limits are 1,024 saved texts, 32 MiB per source, 256 MiB total source bytes,
4 MiB manifest, and 261 MiB total file size. The active workspace retains the
existing 256-text/128 MiB source caps. These are admission limits, not measured
performance promises. Prepared restore bodies remain in memory until commit.

Before any write, validate the footer, entry names/counts, actual sizes, exact
manifest/workspace/settings shapes, source references, comparison IDs, and every
source SHA-256. Unknown versions, duplicates, unexpected files, missing sources,
and hash mismatches refuse the file. Failed/pending imports or damaged library
records must be resolved before exporting a complete backup; nothing is silently
dropped. Container validity does not guarantee a source will successfully extract
under every future app version; ordinary analysis failures remain visible.

## Restore lifecycle

1. Claim the existing library-operation lease and prepare the file without writes.
2. Show saved-text, active-text, and term counts plus replacement semantics.
   Cancel discards preparation and releases the lease.
3. On Replace workspace and load, recheck source integrity, suspend autosave,
   clear its timer, invalidate completion callbacks, and await every issued save.
4. One IDB readwrite transaction over files, bodies, and workspace adds/replaces
   imported sources, replaces the current workspace, records pending preferences,
   and advances the restore epoch. Only IDB requests occur inside it. Failure
   aborts all writes and resumes autosave of the original live setup.
5. Apply portable preferences with strict writes and read-back verification.
   Clear the pending record only on success. Shut down without flushing the old
   runtime and reopen Inputs with old source/range URL targets removed.

The existing startup path preserves saved document IDs and Compare references.
Live `replaceFiles` would allocate new IDs, and attaching a second session would
violate runtime ownership. A clean restart avoids a second hydration path.

If interrupted after IDB commit, startup replays pending settings before session
attachment and restarts once to pick up module-initialized preferences. Replay is
idempotent. A settings-storage failure retains the pending record, opens the
texts and terms normally, and reports that settings still need to finish. A
committed restore never resumes the old
autosave writer or offers cancellation as though the transaction had rolled back.

## Other tabs

Each library instance captures a restore epoch. Library reads and mutations check
it; mutations compare inside their transaction. Restore advances it atomically,
so older tabs cannot overwrite or delete the loaded setup and concurrent restores
cannot both commit from the same epoch. Stale tabs receive “Reload to continue.”
Full database deletion also retires every existing library connection. Those
instances refuse subsequent reads and writes until reload, so a stale tab cannot
recreate reset data after the epoch record has been deleted.
Ordinary edits within an epoch retain the existing last-write-wins model; this
feature adds no merging, tab election, or notification channel.

## Verification

`workspace-backup.test.ts` covers byte/metadata round trips, complete-file refusal,
container limits, cancellation, transactional rollback, stale instances, and
preference validation/replay. Store tests cover draining and resuming persistence.
`workspace-backup.spec.ts` exercises actual download/upload into a fresh browser,
inactive sources, IDs/order/terms/settings/Compare, reload, cancellation, invalid
files, recovery after settings-write failure, and an older tab trying to save
after replacement. It runs in Chromium
and compact WebKit.
