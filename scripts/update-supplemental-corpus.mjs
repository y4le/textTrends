#!/usr/bin/env node
/** Backward-compatible alias for the shared public corpus updater. */
import { refreshDemoCorpus } from './update-demo-corpora.mjs';
refreshDemoCorpus('classics').catch((error) => {
  console.error(error); process.exitCode = 1;
});
