/** rsvp behavior through the live application runtime. */

import { describe, expect, it } from 'vitest';

import type { QueryResultDataV4 } from '../src/worker/protocol-v4.ts';

import { RSVP_RHYTHM_PRESETS, RSVP_RHYTHM_RESET } from '@texttrends/rsvp';

import { type Issued, fakeTrend, fakeReaderPage, harness, flush } from './support/runtime-harness.ts';

describe('RSVP interaction ownership', () => {
  const stepResultFor = (
    entry: Issued,
    hit: {
      readonly doc: string;
      readonly token: number;
      readonly spanTokens: number;
      readonly members: readonly number[];
    } | null,
  ): QueryResultDataV4 => {
    const track = (entry.query as {
      tracks: readonly { seriesId: string; group: { id: string } }[];
    }).tracks[0]!;
    return {
      op: 'occurrence-step',
      seriesId: track.seriesId,
      groupId: track.group.id,
      step: { method: 'occurrence-step/1', hit, atEdge: hit === null },
    };
  };

  function latestReaderSource(f: ReturnType<typeof harness>): Issued {
    const request = f.readers().filter((entry) => (
      entry.query as { request: { maxTokens: number } }
    ).request.maxTokens === 4_096).at(-1);
    if (request === undefined) throw new Error('expected a full Reader source request');
    return request;
  }

  async function readyReader(
    f: ReturnType<typeof harness>,
    anchorToken = 4,
  ): Promise<void> {
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: anchorToken, from: 'occurrence', anchor: 'occurrence',
    });
    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', anchorToken));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:fit',
    });
  }

  it('enters only from a ready source at the published anchor and remembers accepted pace', async () => {
    const f = harness(undefined, {
      rsvpPacing: {
        wpm: 375,
        wordsPerFrame: 2,
        frameCharLimit: 24,
        sentencePauseMs: 250,
        paragraphPauseMs: 800,
        lengthEmphasis: 50,
      },
    });
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().openReader({
      snapshot: 's1', doc: 'a', token: 4, from: 'occurrence', anchor: 'occurrence',
    });
    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });

    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', 4));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:fit',
    });
    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toEqual({
      kind: 'rsvp',
      rsvp: {
        snapshot: 's1', doc: 'a', docTokenCount: 12, startToken: 4,
        wpm: 375, wordsPerFrame: 2, frameCharLimit: 24, sentencePauseMs: 250,
        paragraphPauseMs: 800, lengthEmphasis: 50, playing: true,
      },
      suspended: { kind: 'none' },
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });

    f.store.getState().setRsvpPacing({
      wpm: 425,
      wordsPerFrame: 9,
      frameCharLimit: 100,
      sentencePauseMs: 750,
      paragraphPauseMs: 100,
      lengthEmphasis: -10,
    });
    f.store.getState().setRsvpPlaying(false);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 40,
        sentencePauseMs: 750,
        paragraphPauseMs: 750,
        lengthEmphasis: 0,
        playing: false,
      },
    });
    f.store.getState().exitRsvp(5);
    latestReaderSource(f).resolve(fakeReaderPage(5, 12, 12));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 5, end: 9 }, geometry: '800x600:fit',
    });
    f.store.getState().enterRsvp(false);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        startToken: 5,
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 40,
        sentencePauseMs: 750,
        paragraphPauseMs: 750,
        lengthEmphasis: 0,
        playing: false,
      },
    });
    f.store.getState().closeReader();
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    expect(f.store.getState().readerPlace).toBeNull();
    f.runtime.dispose();
  });

  it('starts paused Speed reading at the explicit Reader cursor ahead of the source anchor', async () => {
    const f = harness();
    await readyReader(f, 4);
    const issuedBeforeCursor = f.issued.length;

    f.store.getState().setReadingCursor(6);
    f.store.getState().enterRsvp(false);

    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: { startToken: 6, playing: false },
    });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 6 });
    expect(f.issued).toHaveLength(issuedBeforeCursor);
    f.runtime.dispose();
  });

  it('preserves frame preferences when applying a rhythm preset or reset', async () => {
    const f = harness(undefined, {
      rsvpPacing: {
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 24,
        sentencePauseMs: 250,
        paragraphPauseMs: 800,
        lengthEmphasis: 50,
      },
    });
    await readyReader(f);
    f.store.getState().enterRsvp(false);

    f.store.getState().setRsvpPacing(RSVP_RHYTHM_PRESETS.study);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        wpm: 425,
        wordsPerFrame: 3,
        frameCharLimit: 24,
        sentencePauseMs: 500,
        paragraphPauseMs: 900,
        lengthEmphasis: 100,
      },
    });

    f.store.getState().setRsvpPacing(RSVP_RHYTHM_RESET);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      rsvp: {
        wpm: 300,
        wordsPerFrame: 3,
        frameCharLimit: 24,
        sentencePauseMs: 350,
        paragraphPauseMs: 700,
        lengthEmphasis: 100,
      },
    });
    f.runtime.dispose();
  });

  it('refuses an unfitted backward source and drops RSVP only when navigation lands', async () => {
    const f = harness();
    await readyReader(f);
    const previous = f.store.getState().readerNavigation?.previous;
    if (previous === null || previous === undefined) throw new Error('expected a previous page');
    f.store.getState().navigateReader(previous);
    latestReaderSource(f).resolve(fakeReaderPage(0, 3, 12));
    await flush();
    expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'before', token: 3 });
    expect(f.store.getState().readerPage?.state.status).toBe('ready');
    expect(f.store.getState().readerVisibleRange).toBeNull();

    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 1, end: 3 }, geometry: '800x600:back',
    });
    f.store.getState().enterRsvp(true);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp', rsvp: { startToken: 1 },
    });

    expect(f.store.getState().popLayer()).toBe(true);
    expect(f.store.getState().readerPlace).toBeNull();
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    f.runtime.dispose();
  });

  it('publishes without touching fitted navigation and exits exactly during a seek', async () => {
    const f = harness();
    await readyReader(f);
    const navigation = f.store.getState().readerNavigation;
    const issued = f.issued.length;
    f.store.getState().enterRsvp(true);
    const enteredHistory = f.store.getState().positionHistory;
    expect(enteredHistory.entries.at(-1)).toMatchObject({
      doc: 'a', token: 4, origin: 'reader',
    });
    const interaction = f.store.getState().interaction;
    const place = f.store.getState().readerPlace;
    f.store.getState().publishRsvpPosition(-1);
    f.store.getState().rsvpSeek(12);
    f.store.getState().exitRsvp(1.5);
    expect(f.store.getState().interaction).toBe(interaction);
    expect(f.store.getState().readerPlace).toBe(place);
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    f.store.getState().publishRsvpPosition(5);
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 5 });
    expect(f.store.getState().positionHistory).toBe(enteredHistory);
    expect(f.store.getState().stepPositionHistory(-1)).toBeNull();
    expect(f.store.getState().positionHistory).toBe(enteredHistory);
    f.store.getState().setScrub({ doc: 'a', token: 9 });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 5 });
    expect(f.store.getState().readerNavigation).toBe(navigation);
    expect(f.issued).toHaveLength(issued);

    f.store.getState().rsvpSeek(5);
    expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'from', token: 5 });
    expect(f.store.getState().readerPage?.state.status).toBe('pending');
    f.store.getState().publishRsvpPosition(6);
    f.store.getState().exitRsvp(6);
    expect(f.store.getState().interaction).toEqual({ kind: 'none' });
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 6 });
    expect(f.store.getState().positionHistory.entries.at(-1)).toMatchObject({
      doc: 'a', token: 6, origin: 'reader',
    });
    expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'from', token: 6 });
    expect(f.store.getState().readerCursorToken).toBe(6);
    expect(f.store.getState().readerNavigation).toBe(navigation);
    f.runtime.dispose();
  });

  it('cancels an ordinary occurrence result already in flight before suspension', async () => {
    const f = harness();
    await readyReader(f);
    f.store.getState().mergeStarterTerms('holmes');
    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', 4));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:term',
    });
    f.store.getState().stepOccurrence(1);
    const pending = f.occurrenceSteps().at(-1)!;
    f.store.getState().enterRsvp(true);
    expect(pending.cancelled).toBe(true);
    expect(f.store.getState().occurrenceNavigation).toBeNull();

    pending.resolve(stepResultFor(pending, {
      doc: 'a', token: 10, spanTokens: 1, members: [0],
    }));
    await flush();
    expect(f.store.getState().interaction.kind).toBe('rsvp');
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    expect(f.store.getState().readerPlace).toMatchObject({
      doc: 'a', cursor: { kind: 'around', token: 4 },
    });
    f.runtime.dispose();
  });

  it('settles a pending Find before suspension and restores its exact query', async () => {
    const f = harness();
    await readyReader(f);
    expect(f.store.getState().submitFind('moriarty')).toBe(true);
    const pendingFind = f.occurrenceSteps().at(-1)!;
    latestReaderSource(f).resolve(fakeReaderPage(2, 8, 12, 'a', 4));
    await flush();
    f.store.getState().setReaderVisibleRange({
      snapshot: 's1', doc: 'a', tokens: { start: 3, end: 7 }, geometry: '800x600:find',
    });
    const findTrendCount = f.trends().filter((entry) => entry.term === 'moriarty').length;
    const pendingTrend = f.trends().filter((entry) => entry.term === 'moriarty').at(-1)!;
    expect(f.store.getState().readerPage?.state.status).toBe('ready');
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { state: { status: 'pending' } },
    });
    f.store.getState().enterRsvp(true);
    expect(pendingFind.cancelled).toBe(true);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      suspended: {
        kind: 'find',
        find: { query: { raw: 'moriarty' }, state: { status: 'idle' } },
      },
    });
    expect(f.store.getState().readerPage?.tracks).toMatchObject([
      { label: 'moriarty' },
    ]);
    pendingTrend.resolve({ op: 'trend', trend: fakeTrend(7) });
    await flush();
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'rsvp',
      suspended: { kind: 'find', find: { trend: { status: 'ready' } } },
    });

    pendingFind.resolve(stepResultFor(pendingFind, {
      doc: 'a', token: 10, spanTokens: 1, members: [0],
    }));
    await flush();
    expect(f.store.getState().scrub).toEqual({ doc: 'a', token: 4 });
    f.store.getState().exitRsvp(4);
    expect(f.store.getState().interaction).toMatchObject({
      kind: 'find', find: { query: { raw: 'moriarty' }, state: { status: 'idle' } },
    });
    expect(f.trends().filter((entry) => entry.term === 'moriarty').length)
      .toBe(findTrendCount);
    f.runtime.dispose();
  });
});

it('requests a backward Speed source with context before the target', async () => {
  const f = harness();
  f.port.publishSnapshot('g1', 's1', ['a']);
  f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 40, from: 'footer', anchor: 'position' });
  f.readers().at(-1)!.resolve(fakeReaderPage(30, 60, 100, 'a', 40));
  await flush();
  f.store.getState().setReaderVisibleRange({ snapshot: 's1', doc: 'a', tokens: { start: 35, end: 50 }, geometry: '800x600:fit' });
  f.store.getState().enterRsvp(false);
  f.store.getState().rsvpSeek(20);
  expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'around', token: 20 });
  f.runtime.dispose();
});


it('retains context before a forward Speed continuation cursor', async () => {
  const f = harness();
  f.port.publishSnapshot('g1', 's1', ['a']);
  f.store.getState().openReader({ snapshot: 's1', doc: 'a', token: 40, from: 'kwic', anchor: 'position' });
  f.readers().at(-1)!.resolve(fakeReaderPage(30, 60, 100, 'a', 40));
  await flush();
  f.store.getState().setReaderVisibleRange({ snapshot: 's1', doc: 'a', tokens: { start: 35, end: 50 }, geometry: 'test' });
  f.store.getState().enterRsvp(false);
  f.store.getState().rsvpSeek(55, 'continuation');
  expect(f.store.getState().readerPlace?.cursor).toEqual({ kind: 'around', token: 55 });
  f.runtime.dispose();
});
