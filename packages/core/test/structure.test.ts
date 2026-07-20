/**
 * Structure core — contract §12.2/§12.3/§12.7. Hierarchy from candidates,
 * conservative chapter scan, section invariants, override application, and
 * char→token projection under token-start ownership.
 */
import { describe, expect, it } from 'vitest';
import {
  ROOT_KEY,
  StructureError,
  applyOverride,
  boundTitle,
  buildDetectedSections,
  charRangeToTokenRange,
  composeStructure,
  DEFAULT_STRUCTURE_RECIPE,
  emptyOverride,
  hashStructureOverride,
  lowerBound,
  projectSections,
  scanChapterHeadings,
  validateSectionTable,
  type StructureOverrideV1,
  type StructureSectionRecordV2,
} from '../src/index.ts';
import { scanMarkdownHeadings } from '../src/index.ts';
import { BOOK_LIKE_MD } from './fixtures/md/book-like.ts';

const recipe = DEFAULT_STRUCTURE_RECIPE;

describe('validateSectionTable invariants', () => {
  const text = 100;
  const root: StructureSectionRecordV2 = { key: ROOT_KEY, origin: 'fixed', level: 0, chars: { start: 0, end: text } };

  it('accepts a well-formed nested table and returns canonical order', () => {
    const table = validateSectionTable(
      [
        { key: 'b', origin: 'user', parent: 'a', level: 2, chars: { start: 20, end: 40 } },
        { key: 'a', origin: 'source', parent: ROOT_KEY, level: 1, chars: { start: 10, end: 50 } },
        root,
        { key: 'c', origin: 'source', parent: ROOT_KEY, level: 1, chars: { start: 60, end: 90 } },
      ],
      text,
    );
    expect(table.map((s) => s.key)).toEqual(['root', 'a', 'b', 'c']); // root, then dfs by char start
  });

  it('rejects a missing root, wrong root range, and empty non-root ranges', () => {
    expect(() => validateSectionTable([{ key: 'x', origin: 'user', parent: ROOT_KEY, level: 1, chars: { start: 0, end: 10 } }], text)).toThrow(/no 'root'/);
    expect(() => validateSectionTable([{ ...root, chars: { start: 0, end: 50 } }], text)).toThrow(/root range/);
    expect(() => validateSectionTable([root, { key: 'e', origin: 'user', parent: ROOT_KEY, level: 1, chars: { start: 10, end: 10 } }], text)).toThrow(/invalid/);
  });

  it('rejects partial overlaps, missing parents, cycles, and containment breaks', () => {
    expect(() =>
      validateSectionTable(
        [root,
          { key: 'a', origin: 'user', parent: ROOT_KEY, level: 1, chars: { start: 10, end: 40 } },
          { key: 'b', origin: 'user', parent: ROOT_KEY, level: 1, chars: { start: 30, end: 60 } }],
        text,
      ),
    ).toThrow(/overlap without nesting/);
    expect(() =>
      validateSectionTable([root, { key: 'a', origin: 'user', parent: 'ghost', level: 1, chars: { start: 10, end: 20 } }], text),
    ).toThrow(/missing parent/);
    expect(() =>
      validateSectionTable([root, { key: 'a', origin: 'user', parent: 'a', level: 1, chars: { start: 10, end: 20 } }], text),
    ).toThrow(/parent/);
    expect(() =>
      validateSectionTable(
        [root,
          { key: 'a', origin: 'user', parent: ROOT_KEY, level: 1, chars: { start: 10, end: 30 } },
          { key: 'b', origin: 'user', parent: 'a', level: 2, chars: { start: 20, end: 50 } }],
        text,
      ),
    ).toThrow(/not contained/);
  });

  it('rejects duplicate keys and oversized/ill-formed titles', () => {
    expect(() => validateSectionTable([root, { ...root, key: 'root' }], text)).toThrow(/duplicate/);
    expect(() =>
      validateSectionTable([root, { key: 'a', origin: 'user', parent: ROOT_KEY, level: 1, title: 'x'.repeat(513), chars: { start: 1, end: 2 } }], text),
    ).toThrow(/title/);
  });

  it('rejects an unknown section origin (closed persisted union)', () => {
    expect(() =>
      validateSectionTable(
        [root, { key: 'a', origin: 'foreign' as never, parent: ROOT_KEY, level: 1, chars: { start: 1, end: 2 } }],
        text,
      ),
    ).toThrow(/origin/);
  });

  it("an EMPTY document's root [0, 0) is valid (only non-root empties are rejected)", () => {
    const emptyRoot: StructureSectionRecordV2 = { key: ROOT_KEY, origin: 'fixed', level: 0, chars: { start: 0, end: 0 } };
    expect(validateSectionTable([emptyRoot], 0)).toEqual([emptyRoot]);
  });
});

describe('scanChapterHeadings (english-chapter-heading-v1)', () => {
  it('detects Part/Book/Chapter with arabic and validated roman numerals', () => {
    const text = [
      'front matter here',
      'Chapter 1',
      'text of one',
      'Chapter II. The Return',
      'more text',
      'CHAPTER IIII',       // invalid roman — rejected
      'Chapter 12: A Title',
    ].join('\n');
    const h = scanChapterHeadings(text);
    expect(h.map((x) => x.title)).toEqual(['Chapter 1', 'Chapter II. The Return', 'Chapter 12. A Title']);
  });

  it('is line-anchored — a mid-sentence "chapter 3" is not a heading', () => {
    expect(scanChapterHeadings('as noted in chapter 3 of the report')).toEqual([]);
  });

  it('ranks part < book < chapter for nesting', () => {
    const text = ['Part 1', 'Book 1', 'Chapter 1', 'Chapter 2'].join('\n');
    const h = scanChapterHeadings(text);
    expect(h.map((x) => x.rank)).toEqual([1, 2, 3, 3]);
  });
});

describe('buildDetectedSections', () => {
  it('builds a nested hierarchy from markdown candidates (book-like fixture)', () => {
    const candidates = scanMarkdownHeadings(BOOK_LIKE_MD);
    const table = buildDetectedSections(BOOK_LIKE_MD, candidates, recipe);
    // H1 title, two H2 chapters, an H3 under the second chapter.
    const nonRoot = table.filter((s) => s.key !== ROOT_KEY);
    expect(nonRoot.map((s) => s.title)).toEqual([
      'The Adventure of the Copper Manuscript',
      'Chapter I. The Letter',
      'Chapter II. The Visitor',
      "The Dealer's Account",
    ]);
    const h3 = nonRoot.find((s) => s.title === "The Dealer's Account")!;
    const h2b = nonRoot.find((s) => s.title === 'Chapter II. The Visitor')!;
    expect(h3.parent).toBe(h2b.key); // nested under its chapter
    // Sibling chapters are disjoint; each contained in the H1.
    expect(h2b.chars.start).toBeGreaterThan(0);
  });

  it('falls back to the chapter scan when there are no markdown candidates', () => {
    const text = ['Intro line.', 'Chapter 1', 'One.', 'Chapter 2', 'Two.'].join('\n');
    const table = buildDetectedSections(text, [], recipe);
    expect(table.filter((s) => s.key !== ROOT_KEY).map((s) => s.title)).toEqual(['Chapter 1', 'Chapter 2']);
    // First chapter ends where the second begins.
    const [c1, c2] = table.filter((s) => s.origin === 'heuristic');
    expect(c1!.chars.end).toBe(c2!.chars.start);
  });

  it('a doc with no headings is just the root', () => {
    const table = buildDetectedSections('plain prose with no structure at all', [], recipe);
    expect(table).toHaveLength(1);
    expect(table[0]!.key).toBe(ROOT_KEY);
  });

  it('an EMPTY document builds a root-only table', () => {
    const table = buildDetectedSections('', [], recipe);
    expect(table).toHaveLength(1);
    expect(table[0]!.chars).toEqual({ start: 0, end: 0 });
  });

  it('recognizes CR-only and Unicode-separator line breaks (linePolicy)', () => {
    expect(scanChapterHeadings('intro\rChapter 1\rbody').map((h) => h.title)).toEqual(['Chapter 1']);
    expect(scanChapterHeadings('a Chapter 2 b').map((h) => h.title)).toEqual(['Chapter 2']);
    // Exact anchors are preserved across CR terminators.
    const h = scanChapterHeadings('intro\rChapter 1\rbody')[0]!;
    expect('intro\rChapter 1\rbody'.slice(h.anchor, h.anchor + 9)).toBe('Chapter 1');
  });

  it('boundTitle backs off a high surrogate exactly at the 512 boundary', () => {
    // A pair straddling index 511/512: naive slice(0,512) keeps the lone
    // high surrogate; boundTitle must drop it. Precondition asserted.
    const title = `${'a'.repeat(511)}🎉tail`;
    expect(title.charCodeAt(511)).toBeGreaterThanOrEqual(0xd800); // high surrogate
    expect(title.charCodeAt(511)).toBeLessThanOrEqual(0xdbff);
    const bounded = boundTitle(title);
    expect(bounded).toBe('a'.repeat(511)); // the pair is dropped whole
    expect(bounded.length).toBe(511);
    expect(bounded.isWellFormed()).toBe(true);
    // A pair that ends exactly at 512 is kept intact (no over-eager backoff).
    const fits = `${'a'.repeat(510)}🎉`;
    expect(fits.length).toBe(512);
    expect(boundTitle(fits)).toBe(fits);
  });

  it('a chapter title long enough to bound builds to well-formed text', () => {
    // The heuristic prefix is "Chapter 1. " (11 units); place the emoji so
    // its pair straddles 512 in the FULL title.
    const tail = `${'a'.repeat(500)}🎉more`;
    const text = `Chapter 1. ${tail}`;
    const table = buildDetectedSections(text, [], recipe); // must not throw
    const heading = table.find((s) => s.origin === 'heuristic')!;
    expect(heading.title!.length).toBeLessThanOrEqual(512);
    expect(heading.title!.isWellFormed()).toBe(true);
  });
});

describe('applyOverride (§12.3)', () => {
  const detected = buildDetectedSections(
    ['Chapter 1', 'a', 'Chapter 2', 'b'].join('\n'),
    [],
    recipe,
  );
  const textLen = ['Chapter 1', 'a', 'Chapter 2', 'b'].join('\n').length;
  const base = emptyOverride('t', 'c', 'r');

  it('the empty override is identity', () => {
    const out = applyOverride(detected, base, textLen);
    expect(out.map((s) => s.title)).toEqual(detected.map((s) => s.title));
  });

  it('remove reparents children and drops the section', () => {
    const c1 = detected.find((s) => s.title === 'Chapter 1')!;
    const out = applyOverride(detected, { ...base, changes: [{ op: 'remove', target: c1.key }] }, textLen);
    expect(out.some((s) => s.key === c1.key)).toBe(false);
    expect(out.some((s) => s.title === 'Chapter 2')).toBe(true);
  });

  it('replace retitles/moves with a complete value and marks origin user', () => {
    const c1 = detected.find((s) => s.title === 'Chapter 1')!;
    const out = applyOverride(
      detected,
      { ...base, changes: [{ op: 'replace', target: c1.key, value: { parent: ROOT_KEY, level: 1, title: 'Renamed', chars: c1.chars } }] },
      textLen,
    );
    const updated = out.find((s) => s.key === c1.key)!;
    expect(updated.title).toBe('Renamed');
    expect(updated.origin).toBe('user');
  });

  it('rejects removing/replacing root, adding a duplicate key, and illegal results', () => {
    expect(() => applyOverride(detected, { ...base, changes: [{ op: 'remove', target: ROOT_KEY }] }, textLen)).toThrow(/root/);
    expect(() => applyOverride(detected, { ...base, changes: [{ op: 'add', key: ROOT_KEY, value: { level: 1, chars: { start: 1, end: 2 } } }] }, textLen)).toThrow(/root/);
    const c1 = detected.find((s) => s.title === 'Chapter 1')!;
    expect(() => applyOverride(detected, { ...base, changes: [{ op: 'add', key: c1.key, value: { level: 1, chars: { start: 1, end: 2 } } }] }, textLen)).toThrow(/already exists/);
    // A replace producing a range outside the parent fails validation.
    expect(() =>
      applyOverride(detected, { ...base, changes: [{ op: 'replace', target: c1.key, value: { parent: ROOT_KEY, level: 1, chars: { start: 0, end: textLen + 5 } } }] }, textLen),
    ).toThrow(StructureError);
  });

  it('APPLICATION is canonical: equal-hash overrides produce the same table regardless of array order', async () => {
    // The probe from the review: replace b (keeping parent a) + remove a.
    // Reversed array order must not change the OUTCOME, only be rejected or
    // accepted identically — equal hashes must mean equal application.
    const src = ['Part 1', 'x', 'Chapter 1', 'y'].join('\n');
    const table = buildDetectedSections(src, [], recipe);
    const part = table.find((s) => s.title === 'Part 1')!;
    const chapter = table.find((s) => s.title === 'Chapter 1')!;
    const forward: StructureOverrideV1 = {
      ...base,
      changes: [
        { op: 'replace', target: chapter.key, value: { parent: part.key, level: 2, title: 'Kept', chars: chapter.chars } },
        { op: 'remove', target: part.key },
      ],
    };
    const reversed: StructureOverrideV1 = { ...base, changes: [...forward.changes].reverse() };
    expect(await hashStructureOverride(forward)).toBe(await hashStructureOverride(reversed));
    // Equal hash MUST mean equal outcome. Here the replace keeps parent=part
    // while the canonical order removes part first, so BOTH must throw the
    // same way — never the pre-fix behavior of one succeeding, one failing.
    const runForward = () => applyOverride(table, forward, src.length);
    const runReversed = () => applyOverride(table, reversed, src.length);
    let fErr: string | null = null;
    let rErr: string | null = null;
    try { runForward(); } catch (e) { fErr = (e as Error).message; }
    try { runReversed(); } catch (e) { rErr = (e as Error).message; }
    expect(fErr).toBe(rErr);
    expect(fErr).not.toBeNull();

    // And a variant that reparents the chapter to ROOT succeeds identically
    // in either array order.
    const okForward: StructureOverrideV1 = {
      ...base,
      changes: [
        { op: 'replace', target: chapter.key, value: { parent: ROOT_KEY, level: 1, title: 'Kept', chars: chapter.chars } },
        { op: 'remove', target: part.key },
      ],
    };
    const okReversed: StructureOverrideV1 = { ...base, changes: [...okForward.changes].reverse() };
    expect(await hashStructureOverride(okForward)).toBe(await hashStructureOverride(okReversed));
    const a = applyOverride(table, okForward, src.length);
    const b = applyOverride(table, okReversed, src.length);
    expect(a.map((s) => [s.key, s.parent])).toEqual(b.map((s) => [s.key, s.parent]));
  });

  it('override hashing is canonical: change order does not matter; duplicates rejected', async () => {
    const a: StructureOverrideV1 = { ...base, changes: [{ op: 'remove', target: 'sec-0000' }, { op: 'add', key: 'z', value: { level: 1, chars: { start: 1, end: 2 } } }] };
    const b: StructureOverrideV1 = { ...base, changes: [{ op: 'add', key: 'z', value: { level: 1, chars: { start: 1, end: 2 } } }, { op: 'remove', target: 'sec-0000' }] };
    expect(await hashStructureOverride(a)).toBe(await hashStructureOverride(b));
    const dup: StructureOverrideV1 = { ...base, changes: [{ op: 'remove', target: 'x' }, { op: 'replace', target: 'x', value: { level: 1, chars: { start: 1, end: 2 } } }] };
    await expect(hashStructureOverride(dup)).rejects.toThrow(/multiple changes/);
  });
});

describe('char→token projection (§12.7 token-start ownership)', () => {
  // Token starts at char offsets 0,5,10,15,20 (five tokens).
  const starts = Uint32Array.from([0, 5, 10, 15, 20]);

  it('lowerBound finds the first start >= value', () => {
    expect(lowerBound(starts, 0)).toBe(0);
    expect(lowerBound(starts, 5)).toBe(1);
    expect(lowerBound(starts, 7)).toBe(2);   // boundary inside token 1 → owned by next
    expect(lowerBound(starts, 25)).toBe(5);
  });

  it('adjacent sections get DISJOINT token ranges even when a boundary splits a token', () => {
    // A boundary at char 7 falls inside token 1 (starts at 5). Ownership by
    // start: token 1 belongs to the section whose range contains char 5.
    const a = charRangeToTokenRange(starts, { start: 0, end: 7 });
    const b = charRangeToTokenRange(starts, { start: 7, end: 20 });
    expect(a).toEqual({ start: 0, end: 2 });   // tokens 0,1
    expect(b).toEqual({ start: 2, end: 4 });   // tokens 2,3 — no overlap with a
    expect(a.end).toBe(b.start);
  });

  it('projects a whole table parallel to its sections', () => {
    const sections: StructureSectionRecordV2[] = [
      { key: ROOT_KEY, origin: 'fixed', level: 0, chars: { start: 0, end: 25 } },
      { key: 'a', origin: 'source', parent: ROOT_KEY, level: 1, chars: { start: 0, end: 10 } },
      { key: 'b', origin: 'source', parent: ROOT_KEY, level: 1, chars: { start: 10, end: 25 } },
    ];
    const ranges = projectSections(sections, starts);
    expect(ranges).toEqual([
      { start: 0, end: 5 },
      { start: 0, end: 2 },
      { start: 2, end: 5 },
    ]);
  });
});

describe('composeStructure', () => {
  it('produces a validated StructureArtifactV2 with the supplied identities', () => {
    const candidates = scanMarkdownHeadings(BOOK_LIKE_MD);
    const artifact = composeStructure(BOOK_LIKE_MD, candidates, recipe, emptyOverride('t', 'c', 'r'), {
      text: 'th', candidates: 'ch', recipe: 'rh', override: 'oh',
    });
    expect(artifact.schema).toBe('texttrends/structure/2');
    expect(artifact.text).toBe('th');
    expect(artifact.override).toBe('oh');
    expect(artifact.sections[0]!.key).toBe(ROOT_KEY);
    expect(artifact.sections.length).toBe(5); // root + 4 headings
  });
});
