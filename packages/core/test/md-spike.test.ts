/**
 * Markdown literal-indexing pollution — the REPRODUCIBLE measurement behind
 * the ingest-structure plan's spike decision (plan "Spike result" section;
 * review round 1 required the methodology to be executable, not prose).
 *
 * Region definitions (a token is POLLUTED iff its start offset lies in any
 * region; overlapping regions do not double-count):
 * - front matter: the leading `---\n…\n---\n` block, delimiters included;
 * - fenced code: opening ``` line through closing ``` line, INCLUDING the
 *   info string (`sh`, `ts` are literal indexed tokens in the region);
 * - inline code: backtick spans on one line, backticks included;
 * - link destination: the text between `](` and `)`;
 * - reference definition: the ENTIRE `[label]: url` line — the label is
 *   markup apparatus, not prose;
 * - reference-link LABEL in prose (`[text][label]` — the second bracket
 *   pair): markup apparatus, polluted;
 * - autolink: `<http…>` spans;
 * - raw HTML: each `<…>` TAG span only — text content BETWEEN tags renders
 *   as document content and is deliberately counted as prose.
 */
import { describe, expect, it } from 'vitest';
import { createDocumentIndex, segment, DEFAULT_INDEX_RECIPE } from '../src/index.ts';
import { BOOK_LIKE_MD } from './fixtures/md/book-like.ts';
import { TECHNICAL_MD } from './fixtures/md/technical.ts';

type Region = readonly [start: number, end: number, kind: string];

export function markdownPollutionRegions(text: string): Region[] {
  const regions: [number, number, string][] = [];
  const frontMatter = /^---\n[\s\S]*?\n---\n/.exec(text);
  if (frontMatter) regions.push([0, frontMatter[0].length, 'front-matter']);
  for (const m of text.matchAll(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm)) {
    regions.push([m.index, m.index + m[0].length, 'fence']);
  }
  for (const m of text.matchAll(/`[^`\n]+`/g)) {
    regions.push([m.index, m.index + m[0].length, 'inline-code']);
  }
  for (const m of text.matchAll(/\]\(([^)\n]*)\)/g)) {
    regions.push([m.index + 2, m.index + 2 + m[1]!.length, 'link-dest']);
  }
  for (const m of text.matchAll(/^\[[^\]\n]+\]:[^\n]*$/gm)) {
    regions.push([m.index, m.index + m[0].length, 'link-ref-def']);
  }
  for (const m of text.matchAll(/\]\[([^\]\n]+)\]/g)) {
    regions.push([m.index + 2, m.index + 2 + m[1]!.length, 'link-ref-label']);
  }
  for (const m of text.matchAll(/<https?:[^>\n]+>/g)) {
    regions.push([m.index, m.index + m[0].length, 'autolink']);
  }
  for (const m of text.matchAll(/<\/?[a-zA-Z][^>\n]*>/g)) {
    regions.push([m.index, m.index + m[0].length, 'html-tag']);
  }
  return regions;
}

async function measure(text: string) {
  const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
  const regions = markdownPollutionRegions(text);
  let polluted = 0;
  for (let i = 0; i < shard.startsUtf16.length; i++) {
    const start = shard.startsUtf16[i]!;
    if (regions.some(([a, b]) => start >= a && start < b)) polluted++;
  }
  return { tokens: shard.startsUtf16.length, polluted };
}

describe('markdown literal-indexing pollution (spike golden baseline)', () => {
  it('book-like prose is unpolluted — the basis for shipping literal-v0', async () => {
    const { tokens, polluted } = await measure(BOOK_LIKE_MD);
    expect(tokens).toBe(177);
    expect(polluted).toBe(0);
  });

  it('technical markdown is heavily polluted — the recorded boundary of the decision', async () => {
    const { tokens, polluted } = await measure(TECHNICAL_MD);
    expect(tokens).toBe(146);
    expect(polluted).toBe(68);
    expect(polluted / tokens).toBeGreaterThan(0.4); // material, per the plan
  });
});
