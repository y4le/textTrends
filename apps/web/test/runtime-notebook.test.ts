/** notebook behavior through the live application runtime. */

import { describe, expect, it } from 'vitest';

import { coreGroupOf, groupTitle, type NotebookGroupV1 } from '../src/lib/notebook.ts';

import { fakeTrend, fakeMatches, harness, editTerm, flush } from './support/runtime-harness.ts';

describe('query notebook — identity discipline', () => {
  const groupsOf = (f: ReturnType<typeof harness>) => f.store.getState().notebook.groups;

  /** Same UUID, different MATCHING semantics. */
  const semanticEdit = (g: NotebookGroupV1): NotebookGroupV1 => ({
    ...g,
    aliases: ['holm*'],
  });

  it('starter suggestions are append-only: a duplicate matching identity is skipped (UUID, member ids, and global activation untouched)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setGroupActive(holmes!.id, false);
    f.store.getState().mergeStarterTerms('holmes, watson'); // holmes skipped, watson appended
    const after = groupsOf(f);
    expect(after.map(groupTitle)).toEqual(['holmes', 'moriarty', 'watson']);
    expect(after[0]!.id).toBe(holmes!.id); // the duplicate touched nothing
    expect(after[0]!.aliases).toEqual(holmes!.aliases);
    expect(after[1]!.id).toBe(moriarty!.id); // append-only: nothing replaced
    expect(f.store.getState().activeGroupIds.has(holmes!.id)).toBe(false);
    expect(f.store.getState().activeGroupIds.has(after[2]!.id)).toBe(true);
    expect(f.store.getState().series.map((series) => series.id))
      .toEqual([moriarty!.id, after[2]!.id]);
  });

  it('rename preserves the UUID and issues NO worker request; the projection relabels', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const g = groupsOf(f)[0]!;
    const issued = f.issued.length;
    editTerm(f.store.getState(), g.id, { displayName: 'The Detective' });
    expect(f.issued.length).toBe(issued); // invariant 2: no occurrence work
    expect(groupsOf(f)[0]!.id).toBe(g.id);
    expect(f.store.getState().series[0]!.label).toBe('The Detective');
    expect(f.store.getState().trends.get(g.id)).toBeDefined(); // results retained
  });

  it('adds one authored term from comma aliases and derives worker members on issue', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    const id = f.store.getState().addTerm({
      aliases: [' NYC ', 'NY', 'New York', 'New Yo*', 'NY'],
    });
    expect(id).not.toBeNull();
    const term = groupsOf(f).at(-1)!;
    expect(term).toMatchObject({
      id,
      aliases: ['NYC', 'NY', 'New York', 'New Yo*'],
      exactMatch: false,
    });
    expect(groupTitle(term)).toBe('NYC');
    expect(coreGroupOf(term).members.map((member) => member.kind))
      .toEqual(['token', 'token', 'phrase', 'phrase']);
    expect(f.store.getState().activeGroupIds.has(term.id)).toBe(true);
  });

  it('refuses an authored style collision for a new active term', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('Holmes');
    const holmes = groupsOf(f)[0]!;
    expect(f.store.getState().addTerm({
      aliases: ['Watson'],
      style: holmes.style,
    })).toBeNull();
    expect(groupsOf(f).map(groupTitle)).toEqual(['Holmes']);
    expect(f.store.getState().notebookError)
      .toBe('Holmes already uses that color and line type');
  });

  it('commits exact-match alias edits explicitly and reissues matching work', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('Holmes');
    const term = groupsOf(f)[0]!;
    const issued = f.issued.length;
    expect(f.store.getState().saveTerm(term.id, {
      aliases: ['Holmes', 'Sherlock Holmes'],
      exactMatch: true,
      countOverlaps: false,
      style: term.style,
    })).toBe(true);
    const edited = groupsOf(f)[0]!;
    expect(edited.aliases).toEqual(['Holmes', 'Sherlock Holmes']);
    expect(edited.exactMatch).toBe(true);
    expect(coreGroupOf(edited).members.every((member) =>
      member.match.case === 'sensitive' && member.match.diacritics === 'sensitive')).toBe(true);
    expect(f.issued.length).toBeGreaterThan(issued);
  });

  it('refuses an edit that would duplicate another term matching identity', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('wolf, bear');
    const [wolf, bear] = groupsOf(f);
    const issued = f.issued.length;
    expect(f.store.getState().saveTerm(bear!.id, {
      aliases: ['wolf'],
      exactMatch: wolf!.exactMatch,
      countOverlaps: false,
      style: bear!.style,
    })).toBe(false);
    expect(groupsOf(f)[1]!.aliases).toEqual(['bear']);
    expect(f.store.getState().notebookError).toMatch(/already has/);
    expect(f.issued.length).toBe(issued);
  });

  it('allows identity-neutral style repair when a legacy notebook already contains duplicate terms', () => {
    const f = harness();
    f.store.getState().mergeStarterTerms('wolf');
    const original = groupsOf(f)[0]!;
    const duplicate = {
      ...original,
      id: 'legacy-duplicate',
      style: { color: 'orange' as const, line: 'dash' as const },
    };
    f.store.setState({
      notebook: {
        schema: 'texttrends/query-notebook/3',
        groups: [original, duplicate],
      },
    });
    editTerm(f.store.getState(), duplicate.id, { style: { color: 'gold', line: 'fine-dot' } });
    expect(groupsOf(f)[1]!.style).toEqual({ color: 'gold', line: 'fine-dot' });
    expect(f.store.getState().notebookError).toBeNull();
  });

  it('a member edit preserves the UUID, changes semantic identity, and reissues trend and matches', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const g = groupsOf(f)[0]!;
    const trendsBefore = f.trends().length;
    const kwicsBefore = f.kwics().length;
    const original = coreGroupOf(g).members[0]!;
    editTerm(f.store.getState(), g.id, { aliases: ['holmes', 'sherlock'], countOverlaps: false });
    expect(groupsOf(f)[0]!.id).toBe(g.id); // UUID stable (invariant 3)
    expect(f.trends().length).toBeGreaterThan(trendsBefore);
    expect(f.kwics().length).toBeGreaterThan(kwicsBefore);
    // The EXACT authored spec reaches EVERY operation's wire request — the
    // COMPLETE group value (ids, kinds, match modes, countOverlaps), deep-equal
    // against the authored expectation on trend and matches.
    const authored = {
      id: g.id,
      members: [
        original,
        { id: 'a1', kind: 'token', surface: 'sherlock', match: { case: 'folded', diacritics: 'folded' } },
      ],
      countOverlaps: false,
    };
    const trendWire = (f.trends().filter((t) => !t.cancelled).at(-1)!.query as { group: unknown }).group;
    expect(trendWire).toEqual(authored);
    const kwicWire = (f.kwics().filter((t) => !t.cancelled).at(-1)!.query as { tracks: { seriesId: string; group: unknown }[] }).tracks;
    expect(kwicWire).toEqual([{ seriesId: g.id, group: authored }]);
  });

  it('an identity-NEUTRAL member apply (same semantics) reissues nothing', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const g = groupsOf(f)[0]!;
    const issued = f.issued.length;
    editTerm(f.store.getState(), g.id, { aliases: g.aliases, countOverlaps: g.countOverlaps });
    expect(f.issued.length).toBe(issued);
  });

  it('a SEMANTIC-ONLY stale settlement cannot commit — trend and KWIC (no epoch advance, leases still current)', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const g = f.store.getState().notebook.groups[0]!;
    const trend = f.trends().filter((t) => !t.cancelled).at(-1)!;
    const kwic = f.kwics().filter((t) => !t.cancelled).at(-1)!;
    // Change the group's SEMANTICS without any action: no lane superseded, no
    // reissue, no epoch advance — only the issued-identity guard stands
    // between the old results and the store (review-B round-1 finding).
    f.store.setState({ notebook: { schema: 'texttrends/query-notebook/3', groups: [semanticEdit(g)] } });
    expect(trend.cancelled).toBe(false); // the lease is genuinely still alive
    expect(kwic.cancelled).toBe(false);
    trend.resolve({ op: 'trend', trend: fakeTrend(3) });
    kwic.resolve(fakeMatches(1)); // rows empty: adoption alone is the probe
    await flush();
    expect(f.store.getState().trends.get(g.id)!.status).toBe('pending'); // never adopted
    expect(f.store.getState().kwic!.state.status).toBe('pending');
  });

  it('rejects an invalid member set with one bounded notebookError and NO state change or reissue', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes');
    const g = groupsOf(f)[0]!;
    const issued = f.issued.length;
    editTerm(f.store.getState(), g.id, { aliases: ['*'], countOverlaps: false });
    expect(f.store.getState().notebookError).toMatch(/use one \*/);
    expect(groupsOf(f)[0]!.aliases).toEqual(g.aliases);
    expect(f.issued.length).toBe(issued);
    f.store.getState().clearNotebookError();
    expect(f.store.getState().notebookError).toBeNull();
  });
});

describe('query notebook — active set, solo, order, and style', () => {
  const groupsOf = (f: ReturnType<typeof harness>) => f.store.getState().notebook.groups;

  it('mute drops and restores the track globally while preserving its style slot', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    const styleBefore = f.store.getState().styles.get(moriarty!.id);
    f.store.getState().setGroupActive(moriarty!.id, false); // mute
    expect(f.store.getState().series.map((s) => s.id)).toEqual([holmes!.id]);
    const live = f.trends().filter((t) => !t.cancelled);
    expect(live.map((t) => t.groupId)).toEqual([holmes!.id]);
    let matches = f.kwics().filter((query) => !query.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(matches.tracks.map((track) => track.seriesId)).toEqual([holmes!.id]);
    f.store.getState().setGroupActive(moriarty!.id, true); // unmute
    expect(f.store.getState().series.map((s) => s.id)).toEqual([holmes!.id, moriarty!.id]);
    matches = f.kwics().filter((query) => !query.cancelled).at(-1)!.query as { tracks: { seriesId: string }[] };
    expect(matches.tracks.map((track) => track.seriesId)).toEqual([holmes!.id, moriarty!.id]);
    expect(f.store.getState().styles.get(moriarty!.id)).toBe(styleBefore); // style identity survived
  });

  it('persists style-only edits without reissuing and protects active survivors on collision', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('a, b');
    const [a, b] = groupsOf(f);
    const issued = f.issued.length;
    editTerm(f.store.getState(), a!.id, { style: { color: 'gold', line: 'dot' } });
    expect(groupsOf(f)[0]!.style).toEqual({ color: 'gold', line: 'dot' });
    expect(f.issued.length).toBe(issued);

    editTerm(f.store.getState(), b!.id, { style: { color: 'gold', line: 'dot' } });
    expect(f.store.getState().notebookError).toMatch(/already uses/);
    expect(groupsOf(f)[1]!.style).not.toEqual(groupsOf(f)[0]!.style);

    f.store.getState().setGroupActive(b!.id, false);
    editTerm(f.store.getState(), b!.id, { style: { color: 'gold', line: 'dot' } });
    expect(groupsOf(f)[1]!.style).toEqual({ color: 'gold', line: 'dot' });
    f.store.getState().setGroupActive(b!.id, true);
    expect(groupsOf(f)[0]!.style).toEqual({ color: 'gold', line: 'dot' });
    expect(groupsOf(f)[1]!.style).not.toEqual(groupsOf(f)[0]!.style);
  });

  it('reassigns a returning automatic color that an active survivor already uses', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('a, b');
    const [a, b] = groupsOf(f);

    f.store.getState().setGroupActive(b!.id, false);
    editTerm(f.store.getState(), b!.id, { style: { color: 'blue', line: 'dash' } });
    expect(groupsOf(f)[1]!.style).toEqual({ color: 'blue', line: 'dash' });
    f.store.getState().setGroupActive(b!.id, true);

    expect(groupsOf(f)[0]!.style).toEqual(a!.style);
    expect(groupsOf(f)[1]!.style.color).not.toBe(a!.style.color);
    expect(new Set(f.store.getState().series.map((item) => item.style.color))).toHaveLength(2);
  });

  it('refuses one automatic color on two active terms even with different lines', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('a, b');
    const [a, b] = groupsOf(f);

    editTerm(f.store.getState(), a!.id, { style: { color: 'gold', line: 'dot' } });
    editTerm(f.store.getState(), b!.id, { style: { color: 'gold', line: 'dash' } });

    expect(f.store.getState().notebookError).toMatch(/already uses/);
    expect(groupsOf(f)[1]!.style.color).not.toBe('gold');
  });

  it('refuses only exact custom color/line collisions and allows nearby authored colors', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('a, b');
    const [a, b] = groupsOf(f);
    editTerm(f.store.getState(), a!.id, { style: { color: '#a1b2c3', line: 'dash' } });
    expect(groupsOf(f)[0]!.style).toEqual({ color: '#a1b2c3', line: 'dash' });

    editTerm(f.store.getState(), b!.id, { style: { color: '#a1b2c3', line: 'dash' } });
    expect(f.store.getState().notebookError).toMatch(/already uses/);
    expect(groupsOf(f)[1]!.style).not.toEqual(groupsOf(f)[0]!.style);

    editTerm(f.store.getState(), b!.id, { style: { color: '#a1b2c4', line: 'dash' } });
    expect(groupsOf(f)[1]!.style).toEqual({ color: '#a1b2c4', line: 'dash' });
  });

  it('uses five distinct colors before varying line type for new active terms', () => {
    const f = harness();
    for (let index = 0; index < 5; index++) {
      f.store.getState().addTerm({ aliases: [`term-${index}`] });
    }
    expect(new Set(groupsOf(f).map((group) => group.style.color)).size).toBe(5);
    expect(new Set(groupsOf(f).map((group) => group.style.line)).size).toBe(5);
  });

  it('refuses a sixth activation while allowing hidden authored terms', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('a, b, c, d, e');
    const sixth = f.store.getState().addTerm({ aliases: ['f'] })!;
    expect(groupsOf(f)).toHaveLength(6);
    expect(f.store.getState().activeGroupIds.has(sixth)).toBe(false);
    f.store.getState().setGroupActive(sixth, true);
    expect(f.store.getState().notebookError).toBe('Hide a shown term first — 5 is the maximum.');
    expect(f.store.getState().activeGroupIds.size).toBe(5);
    f.store.getState().setGroupActive(groupsOf(f)[0]!.id, false);
    f.store.getState().setGroupActive(sixth, true);
    expect(f.store.getState().activeGroupIds.has(sixth)).toBe(true);
  });

  it('solo projects the comparison to ONE group and clearing restores the prior projection exactly', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty, watson');
    const before = f.store.getState().series.map((s) => s.id);
    const target = before[1]!;
    f.store.getState().setSolo(target);
    expect(f.store.getState().series.map((s) => s.id)).toEqual([target]);
    const live = f.trends().filter((t) => !t.cancelled);
    expect(live.map((t) => t.groupId)).toEqual([target]);
    f.store.getState().setSolo(null);
    expect(f.store.getState().series.map((s) => s.id)).toEqual(before); // exact restore
    expect(f.store.getState().activeGroupIds.size).toBe(3); // never mutated
  });

  it('solo is refused for a muted group and cleared when its group deactivates', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setGroupActive(moriarty!.id, false);
    f.store.getState().setSolo(moriarty!.id);
    expect(f.store.getState().notebookError).toMatch(/active/);
    expect(f.store.getState().soloGroupId).toBeNull();
    f.store.getState().setSolo(holmes!.id);
    expect(f.store.getState().soloGroupId).toBe(holmes!.id);
    f.store.getState().setGroupActive(holmes!.id, false);
    expect(f.store.getState().soloGroupId).toBeNull(); // normalized away
  });

  it('reorder is a refused-unless-total permutation, preserves UUIDs/slots, and reissues nothing', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    const styles = new Map(f.store.getState().styles);
    const issued = f.issued.length;
    f.store.getState().reorderGroups([moriarty!.id]); // not total → refused
    expect(f.store.getState().notebookError).toMatch(/every group/);
    f.store.getState().reorderGroups([moriarty!.id, holmes!.id]);
    expect(groupsOf(f).map((g) => g.id)).toEqual([moriarty!.id, holmes!.id]);
    expect(f.store.getState().series.map((s) => s.id)).toEqual([moriarty!.id, holmes!.id]);
    expect(f.store.getState().styles.get(holmes!.id)).toBe(styles.get(holmes!.id)); // styles pinned
    expect(f.store.getState().styles.get(moriarty!.id)).toBe(styles.get(moriarty!.id));
    expect(f.issued.length).toBe(issued); // invariant 2: no reissue
  });

  it('removal cleans results, effective Matches projection, solo, and style ownership', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = groupsOf(f);
    f.store.getState().setSolo(moriarty!.id);
    f.store.getState().removeGroup(moriarty!.id);
    const state = f.store.getState();
    expect(state.notebook.groups.map((g) => g.id)).toEqual([holmes!.id]);
    expect(state.soloGroupId).toBeNull();
    expect(state.styles.has(moriarty!.id)).toBe(false);
    expect(state.activeGroupIds.has(moriarty!.id)).toBe(false);
    expect(state.series.map((series) => series.id)).toEqual([holmes!.id]);
  });
});

describe('query notebook — effective-intent gating', () => {
  it('mutations OUTSIDE the effective comparison reissue nothing: soloed mute, soloed-out semantic edit, soloed append', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = f.store.getState().notebook.groups;
    f.store.getState().setSolo(holmes!.id);
    // Settle solo's trend so we can prove READY evidence survives untouched.
    const soloTrend = f.trends().filter((t) => !t.cancelled).at(-1)!;
    soloTrend.resolve({ op: 'trend', trend: fakeTrend(4) });
    await flush();
    expect(f.store.getState().trends.get(holmes!.id)!.status).toBe('ready');
    const issued = f.issued.length;
    // 1. Mute the solo'd-out group: the projected series is unchanged.
    f.store.getState().setGroupActive(moriarty!.id, false);
    // 2. Semantically edit the muted group (identity changes, projection doesn't).
    editTerm(f.store.getState(), moriarty!.id, { aliases: ['mor*'], countOverlaps: false });
    // 3. Append while soloed: the new group is active but not projected.
    f.store.getState().mergeStarterTerms('watson');
    expect(f.issued.length).toBe(issued); // NOT ONE query issued or cancelled
    expect(f.store.getState().trends.get(holmes!.id)!.status).toBe('ready'); // evidence intact
    expect(soloTrend.cancelled).toBe(false); // and its (settled) job was never cancelled
    // Clearing solo NOW restores the full comparison and reissues once.
    f.store.getState().setSolo(null);
    expect(f.issued.length).toBeGreaterThan(issued);
    // The restored comparison = the projected series (holmes + watson;
    // moriarty stays muted) — one live trend per projected group.
    const live = f.trends().filter((t) => !t.cancelled);
    expect(new Set(live.map((t) => t.groupId)))
      .toEqual(new Set(f.store.getState().series.map((s) => s.id)));
    expect(f.store.getState().series.map((s) => s.label)).toEqual(['holmes', 'watson']);
  });

  it('a rename or reorder inside the projection still reissues nothing (unchanged effective intent)', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1');
    f.store.getState().mergeStarterTerms('holmes, moriarty');
    const [holmes, moriarty] = f.store.getState().notebook.groups;
    const issued = f.issued.length;
    editTerm(f.store.getState(), holmes!.id, { displayName: 'Detective' });
    f.store.getState().reorderGroups([moriarty!.id, holmes!.id]);
    expect(f.issued.length).toBe(issued);
  });
});

it('reuses the live authored identity when adding a duplicate exact term', () => {
  const f = harness();
  const first = f.store.getState().addTerm({ aliases: ['Holmes'], exactMatch: true });
  const active = f.store.getState().activeGroupIds;
  expect(f.store.getState().addTerm({ aliases: ['Holmes'], exactMatch: true })).toBe(first);
  expect(f.store.getState().notebook.groups).toHaveLength(1);
  expect(f.store.getState().activeGroupIds).toBe(active);
  expect(f.store.getState().notebookError).toBeNull();
  f.runtime.dispose();
});
