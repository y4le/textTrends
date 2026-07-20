/** Golden markdown fixture — the 'technical' corpus shape for the
 *  literal-indexing spike (md-spike.test.ts) and the extraction core's
 *  tests. A TS module so core tests stay platform-pure (no fs). */
export const TECHNICAL_MD = `---
title: Field Notes
author: A. Researcher
tags: [corpus, tooling]
---

# Field Notes on Corpus Tooling

See the [main project](https://example.com/projects/textTrends?ref=notes) and
the [related survey](https://example.com/survey#section-2) for background.

## Setup

Install the toolchain:

\`\`\`sh
pnpm install --frozen-lockfile
pnpm --filter @texttrends/web build && echo "built successfully"
\`\`\`

The \`segment()\` function accepts a locale parameter. Reference-style links
are also common: see [the spec][encoding] and <https://encoding.spec.whatwg.org/>.

[encoding]: https://encoding.spec.whatwg.org/#names-and-labels

## Results

<table><tr><td>corpus</td><td>462k tokens</td></tr></table>

Inline code like \`createDocumentIndex(text, batch, recipe)\` appears often in
technical prose, as do longer fenced examples:

\`\`\`ts
const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
console.log(shard.vocabulary.length);
\`\`\`

Setext headings also exist
--------------------------

And a closing paragraph of ordinary prose to balance the sample, with enough
words to make the proportions meaningful rather than degenerate.
`;
