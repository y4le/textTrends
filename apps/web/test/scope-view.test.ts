import { describe, expect, it } from 'vitest';
import type { InventoryResultV1 } from '@texttrends/core';
import type { InventoryState } from '../src/lib/store.ts';
import type { ScopeInput } from '../src/lib/scope-view.ts';
import { corpusName, scopeView } from '../src/lib/scope-view.ts';

const inventoryResult = (
  selectedDocs = 6,
  tokens = 461_992,
  missingDocs: readonly string[] = [],
): InventoryResultV1 => ({
  method: 'inventory/1',
  selection: 'sha256:scope-test' as InventoryResultV1['selection'],
  order: [],
  totals: {
    selectedDocs,
    expectedDocs: 6,
    missingDocs: missingDocs.length,
    tokens,
    lexicalTokens: tokens,
    numeralTokens: 0,
    types: 0,
    hapax: 0,
    sentences: 0,
    paragraphs: 0,
    charsUtf16: 0,
  },
  documents: [],
  rhythm: null,
  growth: null,
  sections: null,
  missingDocs,
  mattrWindow: 500,
});

const readyInventory = (
  selectedDocs = 6,
  tokens = 461_992,
  missingDocs: readonly string[] = [],
): InventoryState => ({
  snapshot: 'snapshot-1',
  selection: null,
  state: { status: 'ready', result: inventoryResult(selectedDocs, tokens, missingDocs) },
});

const input = (overrides: Partial<ScopeInput> = {}): ScopeInput => ({
  project: { kind: 'builtin', id: 'builtin/sherlock', docCount: 6 },
  snapshot: {
    snapshot: 'snapshot-1',
    readyDocs: ['a', 'b', 'c', 'd', 'e', 'f'],
    missingDocs: [],
  },
  inventory: readyInventory(),
  linkedSelection: null,
  titleByDoc: new Map([['a', 'A Study in Scarlet']]),
  pins: { needingReview: 0 },
  loadingPhase: null,
  ...overrides,
});

describe('scopeView', () => {
  it('is honest while the snapshot or inventory is unavailable', () => {
    const loading = scopeView(input({
      snapshot: null,
      inventory: null,
      loadingPhase: 'opening corpus…',
    }), 'trends');
    expect(loading.readyText).toBe('opening corpus…');
    expect(loading.docsInScope).toBeNull();
    expect(loading.tokensInScope).toBeNull();
    expect(loading.segments.some((segment) => segment.endsWith('tokens'))).toBe(false);

    const pending = scopeView(input({
      inventory: {
        snapshot: 'snapshot-1',
        selection: null,
        state: { status: 'pending' },
      },
    }), 'trends');
    expect(pending.tokensInScope).toBeNull();
    expect(pending.segments).not.toContain('461,992 tokens');
  });

  it('omits unknown document totals while a range inventory is pending', () => {
    const linkedSelection = {
      snapshot: 'snapshot-1',
      ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
    } as const;
    const pending = scopeView(input({
      linkedSelection,
      inventory: {
        snapshot: 'snapshot-1',
        selection: linkedSelection,
        state: { status: 'pending' },
      },
    }), 'trends');
    expect(pending.docsInScope).toBeNull();
    expect(pending.segments).not.toContain('6 books in scope');
    expect(pending.segments).not.toContain('all 6 books');
    expect(pending.range?.label).toBe('A Study in Scarlet · tokens 1–3 · 3 tokens');
  });

  it('refuses a ready inventory result issued for a departed scope or snapshot', () => {
    const staleRange = {
      snapshot: 'snapshot-1',
      ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
    } as const;
    const staleSelection = scopeView(input({
      linkedSelection: null,
      inventory: {
        ...readyInventory(1, 3),
        selection: staleRange,
      },
    }), 'trends');
    expect(staleSelection.docsInScope).toBeNull();
    expect(staleSelection.tokensInScope).toBeNull();
    expect(staleSelection.segments).toContain('all 6 books');
    expect(staleSelection.segments).not.toContain('3 tokens');

    const staleSnapshot = scopeView(input({
      snapshot: {
        snapshot: 'snapshot-2',
        readyDocs: ['a', 'b', 'c', 'd', 'e', 'f'],
        missingDocs: [],
      },
      inventory: readyInventory(),
    }), 'trends');
    expect(staleSnapshot.tokensInScope).toBeNull();
  });

  it('uses resident inventory totals for document and token scope', () => {
    const view = scopeView(input(), 'trends');
    expect(view.docsInScope).toBe(6);
    expect(view.tokensInScope).toBe(461_992);
    expect(view.segments).toContain('all 6 books');
    expect(view.segments).toContain('461,992 tokens');
    expect(view.readyText).toBe('6/6 books ready');
  });

  it('renders a half-open committed range as 1-based inclusive evidence', () => {
    const view = scopeView(input({
      inventory: {
        ...readyInventory(1, 3),
        selection: {
          snapshot: 'snapshot-1',
          ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
        },
      },
      linkedSelection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 0, end: 3 } }],
      },
    }), 'trends');
    expect(view.docsInScope).toBe(1);
    expect(view.range).toEqual({
      docTitle: 'A Study in Scarlet',
      firstToken: 1,
      lastToken: 3,
      tokens: 3,
      documents: 1,
      label: 'A Study in Scarlet · tokens 1–3 · 3 tokens',
    });
    expect(view.segments).toContain('1 book in scope');
  });

  it('labels the endpoints and total of a cross-book range', () => {
    const linkedSelection = {
      snapshot: 'snapshot-1',
      ranges: [
        { doc: 'a', tokens: { start: 8, end: 10 } },
        { doc: 'b', tokens: { start: 0, end: 4 } },
      ],
    } as const;
    const view = scopeView(input({
      linkedSelection,
      inventory: {
        snapshot: 'snapshot-1',
        selection: linkedSelection,
        state: { status: 'ready', result: inventoryResult(2, 6) },
      },
      titleByDoc: new Map([
        ['a', 'Alpha'],
        ['b', 'Beta'],
      ]),
    }), 'trends');
    expect(view.range).toEqual({
      docTitle: 'Alpha → Beta',
      firstToken: 9,
      lastToken: 4,
      tokens: 6,
      documents: 2,
      label: 'Alpha token 9 → Beta token 4 · 6 tokens across 2 books',
    });
    expect(view.segments).toContain('2 books in scope');
  });

  it('reports partial readiness without pretending unavailable books are ready', () => {
    const view = scopeView(input({
      snapshot: {
        snapshot: 'snapshot-1',
        readyDocs: ['a', 'b', 'c', 'd'],
        missingDocs: ['e', 'f'],
      },
      inventory: readyInventory(4, 100, ['e', 'f']),
    }), 'trends');
    expect(view.partial).toBe(true);
    expect(view.readyText).toBe('4/6 books ready');
    expect(view.segments).toContain('partial corpus');
  });

  it('states the Compare range exception only where it applies', () => {
    const linkedSelection = {
      snapshot: 'snapshot-1',
      ranges: [{ doc: 'a', tokens: { start: 2, end: 5 } }],
    } as const;
    expect(scopeView(input({ linkedSelection }), 'compare').exception).toBe(
      'Compare uses declared sides A and B · the active trend range does not apply',
    );
    expect(scopeView(input({ linkedSelection }), 'trends').exception).toBeNull();
  });

  it('does not change its announcement for focus-only state outside its input', () => {
    const first = scopeView(input(), 'trends').announcement;
    const second = scopeView(input(), 'trends').announcement;
    expect(second).toBe(first);
    expect(scopeView(input({
      linkedSelection: {
        snapshot: 'snapshot-1',
        ranges: [{ doc: 'a', tokens: { start: 1, end: 3 } }],
      },
    }), 'trends').announcement).not.toBe(first);
  });
});

describe('corpusName', () => {
  it('names built-in, imported, and not-yet-loaded corpora without collisions', () => {
    expect(corpusName({ kind: 'builtin', id: 'builtin/sherlock', docCount: 6 })).toBe('Sherlock Holmes');
    expect(corpusName({ kind: 'builtin', id: 'builtin/asoif', docCount: 5 })).toBe('A Song of Ice and Fire');
    expect(corpusName({ kind: 'builtin', id: 'builtin/lotr', docCount: 3 })).toBe('The Lord of the Rings');
    expect(corpusName({ kind: 'user', id: 'user/default', docCount: 2 })).toBe('Imported corpus');
    expect(corpusName(null)).toBe('Preparing corpus');
  });
});
