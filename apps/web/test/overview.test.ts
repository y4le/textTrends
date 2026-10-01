/** overview behavior through the live application runtime. */

import { describe, expect, it, vi } from 'vitest';

import { WorkerClientError } from '../src/lib/client.ts';

import { coreGroupOf } from '../src/lib/notebook.ts';

import { type Issued, sessionState, fakeCompanyResult, fakeDestinationsResult, fakeMatches, fakeReaderPage, harness, editTerm, flush, semanticEditTop } from './support/runtime-harness.ts';

describe('dispersion barcode lane', () => {
  it('rides the trend burst: pending with the series, ready on result, cleared when the comparison empties', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    expect(f.store.getState().dispersion!.state.status).toBe('pending');
    const q = f.issued.filter((x) => x.op === 'dispersion' && !x.cancelled).at(-1)!;
    const wire = q.query as { tracks: { seriesId: string }[]; request: { method: string } };
    expect(wire.request.method).toBe('dispersion/1');
    expect(wire.tracks.map((t) => t.seriesId)).toEqual(f.store.getState().series.map((s) => s.id));
    q.resolve({ op: 'dispersion', dispersion: { method: 'dispersion/1', geometry: null, tracks: [] } });
    await flush();
    expect(f.store.getState().dispersion!.state.status).toBe('ready');
    f.store.getState().removeGroup(f.store.getState().series[0]!.id);
    expect(f.store.getState().dispersion).toBeNull(); // no comparison → no strip
  });

  it('a SEMANTIC-ONLY stale dispersion settlement cannot commit (identity guard, no epoch advance)', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const g = f.store.getState().notebook.groups[0]!;
    const q = f.issued.filter((x) => x.op === 'dispersion' && !x.cancelled).at(-1)!;
    f.store.setState({ notebook: { schema: 'texttrends/query-notebook/3', groups: [semanticEditTop(g)] } });
    expect(q.cancelled).toBe(false); // the lease is genuinely alive
    q.resolve({ op: 'dispersion', dispersion: { method: 'dispersion/1', geometry: null, tracks: [] } });
    await flush();
    expect(f.store.getState().dispersion!.state.status).toBe('pending'); // never adopted
  });

  it('exact activation preserves global activation and requests the effective Matches tracks', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const sid = f.store.getState().series[0]!.id;
    const activeBefore = [...f.store.getState().activeGroupIds];
    f.store.getState().centerKwicAt(sid, 'a', 3);
    expect([...f.store.getState().activeGroupIds]).toEqual(activeBefore);
    const q = f.kwics().filter((x) => !x.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(q.tracks.map((t) => t.seriesId))
      .toEqual(f.store.getState().series.map((series) => series.id));
    expect(f.store.getState().matchesReveal)
      .toMatchObject({ seriesId: sid, doc: 'a', token: 3 });
  });

  it('density activation publishes only a cursor while exact activation carries a reveal identity', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const sid = f.store.getState().series[0]!.id;
    f.store.getState().centerKwicAt(sid, 'a', 42, { kind: 'bucket', count: 17 });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 42 });
    expect(f.store.getState().matchesReveal).toBeNull();
    f.store.getState().centerKwicAt(sid, 'a', 7); // occurrence: no origin marker
    expect(f.store.getState().matchesReveal).toMatchObject({ seriesId: sid, doc: 'a', token: 7 });
    f.store.getState().setGroupActive(sid, false);
    expect(f.store.getState().matchesReveal).toBeNull();
  });

  it('centerKwicAt requests immediately — no debounce, ready-doc gated', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const sid = f.store.getState().series[0]!.id;
    const count = f.kwics().length;
    f.store.getState().centerKwicAt(sid, 'a', 42);
    expect(f.kwics().length).toBe(count + 1);
    const centered = f.kwics().at(-1)!.query as { request: { anchor: unknown } };
    expect(centered.request.anchor).toEqual({ kind: 'position', doc: 'a', token: 42 });
    f.store.getState().centerKwicAt(sid, 'zz', 1); // not a ready doc → refused
    expect(f.kwics().length).toBe(count + 1);
  });

  it('retains resident rows and reuses the sparse axis across neighboring windows', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const first = f.kwics().at(-1)!;
    first.resolve(fakeMatches(20));
    await flush();
    const resident = f.store.getState().kwic!.resident;
    const axis = f.store.getState().kwic!.axis;
    expect(axis).not.toBeNull();

    f.store.getState().requestMatchesWindow({ kind: 'rank', rank: 10 });
    const second = f.kwics().at(-1)!;
    expect((second.query as { request: { includeAxis: boolean } }).request.includeAxis).toBe(false);
    expect(f.store.getState().kwic).toMatchObject({
      resident,
      axis,
      state: { status: 'pending' },
    });
    second.resolve(fakeMatches(20, [], false));
    await flush();
    expect(f.store.getState().kwic!.axis).toBe(axis);
  });

  it('does not refetch a fully resident result when viewport window geometry changes', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const sid = f.store.getState().series[0]!.id;
    const groupId = f.store.getState().notebook.groups[0]!.id;
    f.kwics().at(-1)!.resolve(fakeMatches(1, [{
      seriesId: sid,
      groupId,
      doc: 'a',
      pos: 5,
      members: [0],
      node: { start: 10, end: 16 },
      left: 'left',
      leftMarks: [],
      leftMarksTruncated: false,
      nodeText: 'holmes',
      right: 'right',
      rightMarks: [],
      rightMarksTruncated: false,
    }]));
    await flush();
    const count = f.kwics().length;

    f.store.getState().requestMatchesWindow(
      { kind: 'position', doc: 'a', token: 9 },
      { before: 40, after: 40 },
    );

    expect(f.kwics()).toHaveLength(count);
    expect(f.store.getState().kwic).toMatchObject({
      request: {
        anchor: { kind: 'position', doc: 'a', token: 9 },
        before: 40,
        after: 40,
      },
      state: { status: 'ready' },
    });
  });

  it('refetches resident rows when the bounded context reserve grows', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const first = f.kwics().at(-1)!;
    first.resolve(fakeMatches());
    await flush();
    const axis = f.store.getState().kwic!.axis;

    f.store.getState().requestMatchesWindow(
      { kind: 'rank', rank: 0 },
      { before: 24, after: 24, contextTokens: 128 },
    );

    const expanded = f.kwics().at(-1)!;
    expect(expanded).not.toBe(first);
    expect(expanded.query).toMatchObject({
      request: { contextTokens: 128, includeAxis: false },
    });
    expect(f.store.getState().kwic).toMatchObject({
      request: { contextTokens: 128 },
      resident: { contextTokens: 64 },
      state: { status: 'pending' },
    });

    expanded.resolve(fakeMatches(0, [], false));
    await flush();
    expect(f.store.getState().kwic).toMatchObject({
      axis,
      resident: { contextTokens: 128 },
      state: { status: 'ready' },
    });
  });

  it('serves cursor motion from resident rows and cancels an obsolete outside-window request on reversal', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const sid = f.store.getState().series[0]!.id;
    const groupId = f.store.getState().notebook.groups[0]!.id;
    const row = (pos: number) => ({
      seriesId: sid,
      groupId,
      doc: 'a',
      pos,
      members: [0],
      node: { start: pos * 2, end: pos * 2 + 6 },
      left: 'left',
      leftMarks: [],
      leftMarksTruncated: false,
      nodeText: 'holmes',
      right: 'right',
      rightMarks: [],
      rightMarksTruncated: false,
    });
    f.kwics().at(-1)!.resolve({
      op: 'matches-window',
      window: {
        method: 'matches-window/1',
        total: 100,
        trackCount: 1,
        anchorRank: 11,
        firstRank: 10,
        preceding: null,
        rows: [row(100), row(150), row(200)],
        axis: { ranks: Uint32Array.of(0, 99), globalTokens: Uint32Array.of(0, 999) },
      },
    });
    await flush();
    const resident = f.store.getState().kwic!.resident;
    const count = f.kwics().length;

    for (let token = 110; token < 150; token++) {
      f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token });
    }
    f.store.getState().requestMatchesWindow({ kind: 'rank', rank: 11 });
    expect(f.kwics()).toHaveLength(count);
    expect(f.store.getState().kwic!.resident).toBe(resident);

    f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 250 });
    const outside = f.kwics().at(-1)!;
    expect(f.kwics()).toHaveLength(count + 1);
    expect(f.store.getState().kwic!.state.status).toBe('pending');
    f.store.getState().requestMatchesWindow({ kind: 'position', doc: 'a', token: 150 });
    expect(outside.cancelled).toBe(true);
    expect(f.kwics()).toHaveLength(count + 1);
    expect(f.store.getState().kwic).toMatchObject({
      resident,
      state: { status: 'ready' },
    });
  });

  it('uses exact provenance to disambiguate and consume a same-position reveal', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const sid = f.store.getState().series[0]!.id;
    const groupId = f.store.getState().notebook.groups[0]!.id;
    f.store.getState().centerKwicAt(sid, 'a', 7, {
      kind: 'occurrence',
      groupId,
      members: [1],
    });
    const request = f.kwics().at(-1)!;
    request.resolve({
      op: 'matches-window',
      window: {
        method: 'matches-window/1',
        total: 20,
        trackCount: 1,
        anchorRank: 12,
        firstRank: 11,
        preceding: null,
        rows: [
          {
            seriesId: sid,
            groupId,
            doc: 'a',
            pos: 7,
            members: [0],
            node: { start: 14, end: 20 },
            left: 'left',
            leftMarks: [],
            leftMarksTruncated: false,
            nodeText: 'holmes',
            right: 'right',
            rightMarks: [],
            rightMarksTruncated: false,
          },
          {
            seriesId: sid,
            groupId,
            doc: 'a',
            pos: 7,
            members: [1],
            node: { start: 14, end: 20 },
            left: 'left',
            leftMarks: [],
            leftMarksTruncated: false,
            nodeText: 'holmes',
            right: 'right',
            rightMarks: [],
            rightMarksTruncated: false,
          },
        ],
        axis: { ranks: Uint32Array.of(0), globalTokens: Uint32Array.of(0) },
      },
    });
    await flush();
    expect(f.store.getState().matchesReveal).toBeNull();
    expect(f.store.getState().kwic!.resident?.revealRank).toBe(12);
    f.store.getState().setScrub({ doc: 'a', token: 8 });
    expect(f.store.getState().kwic!.resident?.revealRank).toBeNull();
    expect(f.store.getState().kwic!.resident?.rows).toHaveLength(2);
  });
});

describe('Company and Reading Destinations overview lanes', () => {
  it('posts overview work after the primary burst and isolates sibling failures', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    const start = f.issued.length;
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const burst = f.issued.slice(start);
    const lastTrend = burst.findLastIndex((entry) => entry.op === 'trend');
    const dispersion = burst.findIndex((entry) => entry.op === 'dispersion');
    const company = burst.findIndex((entry) => entry.op === 'company');
    const destinations = burst.findIndex((entry) => entry.op === 'destinations');
    expect(lastTrend).toBeGreaterThanOrEqual(0);
    expect(dispersion).toBeGreaterThan(lastTrend);
    expect(company).toBeGreaterThan(dispersion);
    expect(destinations).toBeGreaterThan(company);
    expect(f.store.getState().company?.state.status).toBe('pending');
    expect(f.store.getState().destinations?.state.status).toBe('pending');

    const companyQuery = f.companies().at(-1)!;
    const destinationsQuery = f.destinations().at(-1)!;
    companyQuery.reject(new Error('company failed independently'));
    destinationsQuery.resolve(fakeDestinationsResult(destinationsQuery));
    await flush();
    expect(f.store.getState().company?.state).toEqual({
      status: 'error',
      message: 'company failed independently',
    });
    expect(f.store.getState().destinations?.state.status).toBe('ready');
  });

  it('uses canonical semantic track order and reissues only Destinations for pair focus', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [first, second] = f.store.getState().series;
    const originalCompany = f.companies().at(-1)!;
    const originalDestinations = f.destinations().at(-1)!;
    const companyCount = f.companies().length;

    // Reorder presentation before focusing: the worker ordinals must still
    // come from canonical series-id order, not current notebook order.
    f.store.getState().reorderGroups([second!.id, first!.id]);
    f.store.getState().setDestinationFocus([second!.id, first!.id]);
    expect(originalDestinations.cancelled).toBe(true);
    expect(originalCompany.cancelled).toBe(false);
    expect(f.companies()).toHaveLength(companyCount);
    expect(f.destinations()).toHaveLength(2);
    const focused = f.destinations().at(-1)!;
    const focusedWire = focused.query as {
      tracks: readonly { readonly seriesId: string }[];
      request: { readonly focus: { readonly a: number; readonly b: number } | null };
    };
    expect(focusedWire.tracks.map((track) => track.seriesId)).toEqual(['u1', 'u2']);
    expect(focusedWire.request.focus).toEqual({ a: 0, b: 1 });
    expect(f.store.getState().destinationFocus).toEqual({ seriesIds: ['u1', 'u2'] });

    // A raced all-track result is fenced by the Destinations lease only.
    originalDestinations.resolve(fakeDestinationsResult(originalDestinations));
    await flush();
    expect(f.store.getState().destinations?.state.status).toBe('pending');
    focused.resolve(fakeDestinationsResult(focused));
    originalCompany.resolve(fakeCompanyResult(originalCompany));
    await flush();
    expect(f.store.getState().destinations?.state.status).toBe('ready');
    expect(f.store.getState().company?.state.status).toBe('ready');

    // Focus is part of the resident key: clearing a settled focus must issue
    // a fresh all-track ranking without touching Company.
    f.store.getState().setDestinationFocus(null);
    expect(f.companies()).toHaveLength(companyCount);
    expect(f.destinations()).toHaveLength(3);
    expect((f.destinations().at(-1)!.query as {
      request: { readonly focus: unknown };
    }).request.focus).toBeNull();

    const beforePresentationEdits = {
      company: f.companies().length,
      destinations: f.destinations().length,
    };
    editTerm(f.store.getState(), first!.id, { displayName: 'Detective' });
    editTerm(f.store.getState(), first!.id, { style: { color: 'gold', line: 'dot' } });
    f.store.getState().applyTrendSettings({
      bins: { mode: 'per-doc', count: 40 },
      measure: { kind: 'rate', denominator: 10_000, smoothing: 5, showRaw: true },
    });
    expect(f.companies()).toHaveLength(beforePresentationEdits.company);
    expect(f.destinations()).toHaveLength(beforePresentationEdits.destinations);
  });

  it('invalidates ready residents when a matching identity changes', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const company = f.companies().at(-1)!;
    const destinations = f.destinations().at(-1)!;
    company.resolve(fakeCompanyResult(company));
    destinations.resolve(fakeDestinationsResult(destinations));
    await flush();
    const oldCompanyKey = f.store.getState().company!.trackKey;
    const oldDestinationsKey = f.store.getState().destinations!.resultKey;
    const group = f.store.getState().notebook.groups[0]!;
    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add should create a token');

    editTerm(f.store.getState(), group.id, { aliases: ['watson'], countOverlaps: false });
    expect(f.companies()).toHaveLength(2);
    expect(f.destinations()).toHaveLength(2);
    expect(f.store.getState().company?.state.status).toBe('pending');
    expect(f.store.getState().destinations?.state.status).toBe('pending');
    expect(f.store.getState().company!.trackKey).not.toBe(oldCompanyKey);
    expect(f.store.getState().destinations!.resultKey).not.toBe(oldDestinationsKey);
  });

  it('ignores invalid focus identities before they can reach worker ordinals', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [first] = f.store.getState().series;
    const count = f.destinations().length;
    expect(() => f.store.getState().setDestinationFocus([first!.id, first!.id])).not.toThrow();
    expect(() => f.store.getState().setDestinationFocus([first!.id, 'unknown'])).not.toThrow();
    expect(f.destinations()).toHaveLength(count);
    expect(f.store.getState().destinationFocus).toBeNull();
  });

  it('refuses mismatched worker track/focus echoes and maps overview caps honestly', async () => {
    const mismatched = harness();
    mismatched.port.publishSnapshot('g1', 's1', ['a']);
    mismatched.store.getState().mergeStarterTerms('holmes, moriarty');
    const company = mismatched.companies().at(-1)!;
    const destinations = mismatched.destinations().at(-1)!;
    const companyData = fakeCompanyResult(company);
    if (companyData.op !== 'company') throw new Error('expected fake Company result');
    company.resolve({
      op: 'company',
      company: {
        ...companyData.company,
        tracks: companyData.company.tracks.map((track, index) =>
          index === 0 ? { ...track, seriesId: 'wrong-series' } : track),
      },
    });
    const destinationsData = fakeDestinationsResult(destinations);
    if (destinationsData.op !== 'destinations') throw new Error('expected fake Destinations result');
    destinations.resolve({
      op: 'destinations',
      destinations: {
        ...destinationsData.destinations,
        focus: { a: 0, b: 1 },
      },
    });
    await flush();
    expect(mismatched.store.getState().company?.state).toEqual({
      status: 'error',
      message: 'worker returned mismatched Company data',
    });
    expect(mismatched.store.getState().destinations?.state).toEqual({
      status: 'error',
      message: 'worker returned mismatched Reading Destinations data',
    });

    const capped = harness();
    capped.port.publishSnapshot('g1', 's1', ['a']);
    capped.store.getState().mergeStarterTerms('holmes, moriarty');
    capped.companies().at(-1)!.reject(
      new WorkerClientError('WORKER_ERROR', 'cap', 'CAP_EXCEEDED'),
    );
    await flush();
    expect(capped.store.getState().company?.state).toEqual({
      status: 'error',
      message: 'This overview is too large to analyse exactly — remove a tracked term or text.',
    });
  });

  it('cancels overview work for a linked range and reuses exact ready residents on clear', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const companyQuery = f.companies().at(-1)!;
    const destinationsQuery = f.destinations().at(-1)!;
    companyQuery.resolve(fakeCompanyResult(companyQuery));
    destinationsQuery.resolve(fakeDestinationsResult(destinationsQuery));
    await flush();
    const companyResident = f.store.getState().company;
    const destinationsResident = f.store.getState().destinations;
    const counts = {
      company: f.companies().length,
      destinations: f.destinations().length,
    };

    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 1, end: 3 } }],
    });
    expect(companyQuery.cancelled).toBe(false); // settled residents need no cancel
    expect(destinationsQuery.cancelled).toBe(false);
    expect(f.store.getState().company).toBe(companyResident);
    expect(f.store.getState().destinations).toBe(destinationsResident);

    f.store.getState().setLinkedSelection(null);
    expect(f.companies()).toHaveLength(counts.company);
    expect(f.destinations()).toHaveLength(counts.destinations);
    expect(f.store.getState().company).toBe(companyResident);
    expect(f.store.getState().destinations).toBe(destinationsResident);
  });

  it('clears cancelled pending states and reissues them on deselection', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const pendingCompany = f.companies().at(-1)!;
    const pendingDestinations = f.destinations().at(-1)!;
    f.store.getState().setLinkedSelection({
      snapshot: 's1',
      ranges: [{ doc: 'a', tokens: { start: 1, end: 3 } }],
    });
    expect(pendingCompany.cancelled).toBe(true);
    expect(pendingDestinations.cancelled).toBe(true);
    expect(f.store.getState().company).toBeNull();
    expect(f.store.getState().destinations).toBeNull();

    f.store.getState().setLinkedSelection(null);
    expect(f.companies()).toHaveLength(2);
    expect(f.destinations()).toHaveLength(2);
    expect(f.store.getState().company?.state.status).toBe('pending');
    expect(f.store.getState().destinations?.state.status).toBe('pending');
  });

  it('shows Destinations but no Company for a single active term', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    expect(f.companies()).toHaveLength(0);
    expect(f.store.getState().company).toBeNull();
    expect(f.destinations()).toHaveLength(1);
    expect(f.store.getState().destinations?.state.status).toBe('pending');
  });
});

describe('global footer passage intent', () => {
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const cursorToken = (entry: Issued) => (
    entry.query as { request: { cursor: { kind: string; token: number } } }
  ).request.cursor.token;

  it('issues immediately on its own reader lane and retains only the latest pending cursor', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');

    f.store.getState().setScrub({ doc: 'a', token: 10 });
    expect(f.readers()).toHaveLength(1);
    expect(cursorToken(f.readers()[0]!)).toBe(10);
    f.store.getState().setScrub({ doc: 'a', token: 30 });
    expect(f.readers()).toHaveLength(1);
    f.readers()[0]!.resolve(fakeReaderPage(0, 20, 1_000));
    await settle();

    expect(f.readers()).toHaveLength(2);
    expect(cursorToken(f.readers()[1]!)).toBe(30);
    expect(f.store.getState().footerPassage).toMatchObject({
      snapshot: 's1',
      doc: 'a',
      page: { tokens: { start: 0, end: 20 } },
      state: { status: 'pending' },
    });
    expect((f.readers()[1]!.query as { tracks: unknown[] }).tracks).toHaveLength(1);
    f.runtime.dispose();
    expect(f.readers()[1]!.cancelled).toBe(true);
  });

  it('keeps at most one request active and pumps only the newest pending cursor', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().mergeStarterTerms('holmes');
      f.store.getState().setScrub({ doc: 'a', token: 20 });
      const first = f.readers()[0]!;

      f.store.getState().setScrub({ doc: 'a', token: 500 });
      f.store.getState().setScrub({ doc: 'a', token: 700 });
      expect(f.readers()).toHaveLength(1);

      first.resolve(fakeReaderPage(0, 400, 1_000));
      await settle();
      expect(f.readers()).toHaveLength(2);
      expect(cursorToken(f.readers()[1]!)).toBe(700);
      expect(f.store.getState().footerPassage?.state.status).toBe('pending');
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps source reading available with zero query series', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().setScrub({ doc: 'a', token: 12 });

      expect(f.readers()).toHaveLength(1);
      expect((f.readers()[0]!.query as { tracks: unknown[] }).tracks).toEqual([]);
      f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
      await settle();
      expect(f.store.getState().footerPassage?.state.status).toBe('ready');
      expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 12 });
      f.port.publishSnapshot('g2', 's2', ['a']);
      expect(f.store.getState().scrub).toBeNull();
      expect(f.store.getState().footerPassage).toBeNull();
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a source error and retries the current cursor without touching settled KWIC', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().mergeStarterTerms('holmes');
      const matches = f.kwics().at(-1)!;
      matches.resolve(fakeMatches(0));
      await settle();
      f.store.getState().setScrub({ doc: 'a', token: 25 });
      f.readers()[0]!.reject(new Error('source failed'));
      await settle();
      expect(f.store.getState().footerPassage?.state).toEqual({
        status: 'error',
        message: 'source failed',
      });
      const kwicCount = f.kwics().length;

      // An unchanged settled axis position retries only source residency.
      f.store.getState().setScrub({ doc: 'a', token: 25 });
      expect(f.kwics()).toHaveLength(kwicCount);
      expect(f.readers()).toHaveLength(2);
      f.store.getState().runFooterPassage();
      expect(f.readers()).toHaveLength(2); // same request remains active
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a serving canonical page, then reissues immediately when track semantics change', async () => {
    vi.useFakeTimers();
    try {
      const f = harness();
      f.port.publishSnapshot('g1', 's1', ['a']);
      f.store.getState().mergeStarterTerms('holmes');
      f.store.getState().setScrub({ doc: 'a', token: 40 });
      f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
      await settle();
      expect(f.store.getState().footerPassage?.state.status).toBe('ready');

      f.store.getState().setScrub({ doc: 'a', token: 80 });
      expect(f.readers()).toHaveLength(1);

      f.store.getState().mergeStarterTerms('watson');
      expect(f.readers()).toHaveLength(2);
      expect(cursorToken(f.readers()[1]!)).toBe(80);
      expect((f.readers()[1]!.query as { tracks: unknown[] }).tracks).toHaveLength(2);
      f.port.emit(sessionState(null));
      expect(f.readers()[1]!.cancelled).toBe(true);
      expect(f.store.getState().footerPassage).toBeNull();
      f.readers()[1]!.resolve(fakeReaderPage(0, 100, 1_000));
      await settle();
      expect(f.store.getState().footerPassage).toBeNull();
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-centers before a measured row margin reaches a resident page edge', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setFooterPassageMargin(30);
    f.store.getState().setScrub({ doc: 'a', token: 200 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 400, 1_000, 'a', 200));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 210 });
    expect(f.readers()).toHaveLength(1);
    f.store.getState().setScrub({ doc: 'a', token: 380 });
    expect(f.readers()).toHaveLength(2);
    expect(cursorToken(f.readers()[1]!)).toBe(380);
    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 400 } },
      state: { status: 'pending' },
    });
    f.runtime.dispose();
  });

  it('waives the row margin at document edges', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setFooterPassageMargin(30);
    f.store.getState().setScrub({ doc: 'a', token: 5 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 400, 400, 'a', 5));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 1 });
    f.store.getState().setScrub({ doc: 'a', token: 399 });
    expect(f.readers()).toHaveLength(1);
    f.runtime.dispose();
  });

  it('re-evaluates a larger measured margin once and terminates at the new anchor', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 200 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 400, 1_000, 'a', 200));
    await settle();
    f.store.getState().setScrub({ doc: 'a', token: 380 });
    expect(f.readers()).toHaveLength(1);

    f.store.getState().setFooterPassageMargin(30);
    expect(f.readers()).toHaveLength(2);
    f.store.getState().setFooterPassageMargin(30);
    expect(f.readers()).toHaveLength(2);
    f.readers()[1]!.resolve(fakeReaderPage(180, 580, 1_000, 'a', 380));
    await settle();
    expect(f.readers()).toHaveLength(2);
    f.runtime.dispose();
  });

  it('cancels an obsolete request when a reversal returns to the resident page', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 40 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 500 });
    const obsolete = f.readers()[1]!;
    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'pending' },
    });
    f.store.getState().setScrub({ doc: 'a', token: 50 });

    expect(obsolete.cancelled).toBe(true);
    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'ready' },
    });
    f.runtime.dispose();
  });

  it('retains authenticated source when the next passage request fails', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 40 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 500 });
    f.readers()[1]!.reject(new Error('source failed'));
    await settle();

    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'error', message: 'source failed' },
    });
    f.runtime.dispose();
  });

  it('clears a failed request when the resident page serves the returned cursor', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setScrub({ doc: 'a', token: 40 });
    f.readers()[0]!.resolve(fakeReaderPage(0, 100, 1_000, 'a', 40));
    await settle();

    f.store.getState().setScrub({ doc: 'a', token: 500 });
    f.readers()[1]!.reject(new Error('source failed'));
    await settle();
    f.store.getState().setScrub({ doc: 'a', token: 50 });

    expect(f.store.getState().footerPassage).toMatchObject({
      page: { tokens: { start: 0, end: 100 } },
      state: { status: 'ready' },
    });
    f.store.getState().runFooterPassage();
    expect(f.readers()).toHaveLength(2);
    f.runtime.dispose();
  });
});
