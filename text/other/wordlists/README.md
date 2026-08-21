# Ranked English common words

`common_words.txt` is the locked canonical ranking for the private deployment.
It contains 6,690 normalized, unique entries and is intentionally not rebuilt
from repository inputs.

Run `pnpm update:stoplist` from the repository root to regenerate only the
bounded worker module at `packages/core/src/ops/stoplist-en-data.ts`. The worker
module selects the first 2,000 entries that the default English segmenter can
emit as one lexical token.
