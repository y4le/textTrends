# Work with texts and terms

Use these recipes in an existing workspace. The
[reference](reference.md) lists syntax and limits; the
[first lesson](tutorial.md) supplies a controlled starting example.

## Build an ordered corpus

1. Open Inputs and choose **Import and analyze**, or drop supported files in
   the acquisition area. Files are saved locally and activated for analysis.
2. Reorder Active inputs with the drag handle or its up/down controls. This
   order governs Trends, Matches, and reading across texts.
3. Expand a text's statistics to inspect its token count, vocabulary,
   sentence measures, and Source details. These remain full-text facts when
   another view has a selected range.

Use **Save to library** when you want to save files without activating them.
Activate saved files from Local library later. Removing an active text retains
its saved bytes; deleting a library file also removes every active text backed
by it. The deletion confirmation names that consequence.

To start with prepared texts, expand **Show options** under Add texts and pick
a sample. Samples add ordinary local texts and starter terms without replacing
your work. The Standard Ebooks catalog offers another acquisition path; adding
a title downloads its source archive from GitHub.

**Clear all** in Active inputs clears the active texts and terms together
while retaining the library. It is separate from deleting saved files.

## Track related names as one term

Open **Manage** in the Terms rail and edit or create a term. Enter comma-separated
aliases such as `Holmes, Sherlock Holmes`. They are alternatives within that
term. Choose exact matching or overlap counting only when those semantics fit
your question; the [syntax reference](reference.md#terms-and-find) defines them.

Show or hide terms to choose the comparison (at most five shown). Hidden terms
remain in the notebook. Use Manage to reorder, recolor, or remove terms; the
removal notice offers undo. Quick entry through **Add term** has different comma
semantics: `Holmes, Watson` creates two separate terms.

## Find a passage

1. Open **Find**, or press `/` or Ctrl/Cmd+F outside Speed.
2. Enter a word, phrase, or comma-separated aliases and submit.
3. Use Previous and Next to visit exact matching starts. Activate the ready
   result-progress action to open the current hit in Reader.
4. Choose **Save** to keep the submitted query as one shown notebook term, or
   close Find to return to the existing terms.

Find is temporary until saved. It searches indexed words and phrases;
[query syntax](reference.md#terms-and-find) differs from browser substring
search and Vocabulary's optional regex filter.

## Compare a passage with the rest

1. Open Trends and focus the graph's scrubber.
2. Move to a starting position, press `s`, extend with the arrow keys, then
   press Enter to commit the range. A mouse drag also selects a range; Help
   lists the touch gestures.
3. Open Compare and choose the selected-range comparison when other comparison
   modes are available. With one active text, this is the comparison mode.
4. Inspect side A (the selected tokens) against side B (the ready corpus outside
   them). Expand a term for exact counts, rates, log ratio, its interval, and G².

To select whole texts, activate a Trends title. Shift+Arrow from a focused title
extends through adjacent texts immediately. Clear the range from the scrubber
with Escape when no preview is active.

A range changes analytical scope. Matches and Reader continue to navigate the
full corpus. See [comparison interpretation](explanation.md#comparison).

## Read and change scale

Open Reader from a Matches row or the reading strip's passage. Use the page
controls to move through fitted prose. Tap a word to select a precise reading
position without changing the page.

On compact layouts, activate the title/position button to open Reader controls.
The sheet contains reference stepping, text movement, Atlas, Settings, and
Help as available. Wide layouts place those commands in side rails. Atlas
requires multiple readable texts; choose Equal to compare relative positions
or To scale to compare positions in shared token units. Select a position and
press Enter to read there.

Choose **Speed** in Read to enter paused at the selected/current word. Play
starts playback; the pace includes rests. Single arrows move one word and
double arrows move across the visible paused passage. Opening Speed settings
pauses playback. Return to Reader or Escape returns to prose at the displayed
token. [Speed settings](reference.md#speed) describes the controls.

## Save and load a workspace file

In **Inputs → Workspace file**, choose **Save workspace file** to download a
`.ttws` file containing all saved library texts, active text order and metadata,
terms, analysis settings, and display/reading preferences. Resolve pending or
failed imports and repair or remove damaged sources before saving.

Choose **Load workspace file**, select the backup, and review its counts.
**Replace workspace and load** replaces active texts, terms, and saved settings,
then reopens the app. Unrelated library texts are kept. Imported texts take the
names and metadata saved in the file. Save the current setup first if you want
to return to it; Cancel leaves it unchanged.

The file works in a fresh browser without downloading its texts again. Analysis
is rebuilt; selections, cursor position, open panels, and undo history reset.
If another tab reports that the workspace was replaced, reload that tab before
continuing. If settings restoration was interrupted, reload to finish it.

## Recover saved work

A workspace-save warning remains visible across places and Reader. Use its
retry action after resolving the storage problem; do not assume visible edits
were saved while the warning remains.

Inputs reports unavailable saved sources while allowing healthy texts to open.
Reimport the original file to repair its source, or use **Remove unavailable**
for that reference. Ordinary editing retains unavailable references rather than
silently deleting them.
A failed view offers reload or a return to Inputs.

Open **Help → Debug** (or Shift+D) for worker restart, analysis retry, workspace
save retry, or a metadata-only diagnostic report. Clearing the disposable cache
retains library files and the workspace, then rebuilds indexes. Full reset is
separate: it removes saved sources, workspace, caches, and owned preferences
after confirmation. If deletion is blocked, close other app tabs and retry.

Browser storage belongs to this origin and browser profile. Keep downloaded
workspace files somewhere you can access outside that browser.
