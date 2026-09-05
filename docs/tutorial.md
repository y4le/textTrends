# Follow a word into its source

This lesson takes a word from an exact count to its surrounding text and back
to the workbench. Start with the app running as described in the
[README](../README.md#run-locally), in an empty workspace. Use a separate browser
profile if you already have research saved.

## Import a small text

Save the following as `weather.txt`:

```text
Rain crossed the valley.
The road stayed quiet.
Rain reached the village.
At dusk, the rain stopped.
```

In Inputs, choose **Import and analyze** and select `weather.txt`. Wait for the
text to finish indexing. It appears in Active inputs and is saved in the Local
library.

## Track rain

Choose **Add term** (the `+` control) in the Terms rail, enter `rain`, and
submit. Open Trends.
The `rain` term reports three occurrences; the default matching includes both
`Rain` and `rain`. The line and strip place those occurrences along the text.

## Open a passage

Open Matches. Its three rows show `rain` with the text on either side, in
source order. Activate the second row to open Reader at “Rain reached the
village.” The destination word is marked in the extracted source.

Choose **back** to return to Matches. The reading position remains at that
passage; the reading strip and Matches share that position. The saved term
remains in the notebook.

Continue with [finding and comparing passages](how-to.md#find-a-passage) or
[interpreting the measurements](explanation.md).
