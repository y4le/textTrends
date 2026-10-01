/** Owns Reader page queries, navigation, fitted-page history, and seek gestures.
 * Constructed inside the single store initializer without reading state. Other
 * runtime owners call explicit lifecycle methods; every query shares its scope.
 */
import type { StoreApi } from 'zustand';
import type { TermGroupSpec } from '@texttrends/core';
import type { AppState, ReaderNavigationTarget, ScrubTarget, SeriesIntent } from './app-state.ts';
import type { CapturedTrack } from './track-legend.ts';
import type { OperationScope } from './operation-lease.ts';
import { QueryLane, type QueryIssuer } from './query-lane.ts';
import type { createNavigationController } from './navigation-controller.ts';
import { readerCursorToken, readerPlaceFor, sameReaderCursor, sameReaderPlace,
  type ReaderOpenIntent, type ReaderAnchorKind, type ReaderPlace } from './reader-intent.ts';
import { adjacentReadableDocumentAtRelativePosition, adjacentReadableDocument,
  readyReaderDocumentOrder } from './reader-order.ts';
import { atlasAvailable, DEFAULT_READER_SCALE, DEFAULT_ATLAS_NORMALIZATION, type AtlasNormalization } from './reader-view.ts';
import { preservedReadingCursor, publishedReadingToken } from './reader-cursor.ts';
import { pushLayer as pushLayerStack, replaceTopLayer, type Layer } from './layers.ts';
import type { PositionHistoryOrigin } from './position-history.ts';

const READER_SOURCE_MAX_TOKENS = 4_096;

type ReaderActions = Pick<AppState,
  'openReader' | 'stepReaderDocument' | 'selectAtlasPosition' | 'setReaderScale'
  | 'setAtlasNormalization' | 'setReaderVisibleRange' | 'setReadingCursor'
  | 'refitReaderAt' | 'seekReader' | 'navigateReader' | 'retryReader' | 'closeReader' | 'runReader'
>;

interface ReaderDependencies {
  atlasNormalization: AtlasNormalization | undefined;
  get: StoreApi<AppState>['getState'];
  set: StoreApi<AppState>['setState'];
  scope: OperationScope;
  issue: QueryIssuer;
  navigation: Pick<ReturnType<typeof createNavigationController>,
    'rememberLayer' | 'writeNavigation' | 'freshLayer' | 'requestBack'>;
  snapshotKey(): string | null;
  effectiveTrackSpecs(series: readonly SeriesIntent[]): {
    wire: { seriesId: string; group: TermGroupSpec }[];
    identities: readonly (readonly [string, string])[];
    captured: readonly CapturedTrack[];
  } | null;
  identitiesCurrent(pairs: readonly (readonly [string, string])[]): boolean;
  recordPositionJump(from: ScrubTarget | null, to: ScrubTarget, origin: PositionHistoryOrigin): void;
  /** Supersede occurrence navigation and optionally schedule history, then
   * return shared cursor state to publish atomically with the Reader fields.
   * This deliberately does not schedule the footer passage.
   */
  readingPositionPatch(target: ScrubTarget, origin?: PositionHistoryOrigin):
    Partial<Pick<AppState, 'scrub' | 'occurrenceNavigation' | 'matchesReveal'>>;
}

/** Query residency follows the complete effective matching set. Order,
 * labels, and styles are presentation-only; membership and matching identity
 * are not. */
function sameReaderTrackSet(
  captured: readonly CapturedTrack[],
  effective: readonly CapturedTrack[],
): boolean {
  if (captured.length !== effective.length) return false;
  const capturedById = new Map(captured.map((track) => [track.seriesId, track.identity]));
  const effectiveById = new Map(effective.map((track) => [track.seriesId, track.identity]));
  if (capturedById.size !== captured.length || effectiveById.size !== effective.length) return false;
  for (const [seriesId, identity] of capturedById) {
    if (effectiveById.get(seriesId) !== identity) return false;
  }
  return true;
}

function adjacentReaderDocument(
  state: Pick<AppState, 'corpusTokenCounts' | 'projectSession' | 'snapshot'>,
  doc: string,
  direction: 1 | -1,
): ReaderNavigationTarget | null {
  const readyDocs = state.snapshot?.readyDocs;
  if (!readyDocs) return null;
  return adjacentReadableDocument(
    readyReaderDocumentOrder(
      state.projectSession?.project.data.order,
      readyDocs,
    ),
    doc,
    direction,
    (candidate) => state.corpusTokenCounts.get(candidate),
  );
}

export function createReaderController(deps: ReaderDependencies) {
  const { get, set, scope, issue: issueOn, snapshotKey, effectiveTrackSpecs,
    identitiesCurrent, recordPositionJump, readingPositionPatch } = deps;
  const { rememberLayer, writeNavigation, freshLayer, requestBack } = deps.navigation;
  const readerLane = new QueryLane(scope);
  let readerWalk: {
    readonly snapshot: string;
    readonly doc: string;
    readonly geometry: string;
    boundaries: number[];
    index: number;
  } | null = null;
  let readerSeekSession: {
    readonly doc: string;
    readonly origin: ScrubTarget | null;
    readonly tokenCount: number;
  } | null = null;

  const replaceReaderTarget = (
    target: ReaderNavigationTarget,
    anchor: ReaderAnchorKind = 'position',
    from?: ReaderOpenIntent['from'],
  ): void => {
    const place = get().readerPlace;
    const cursor = target.cursor;
    const origin = from ?? place?.from;
    const sameTarget = place !== null
      && target.doc === place.doc
      && anchor === place.anchor
      && origin === place.from
      && sameReaderCursor(cursor, place.cursor);
    if (
      place === null
      || !get().snapshot?.readyDocs.includes(target.doc)
      || !Number.isSafeInteger(cursor.token)
      || cursor.token < 0
      || (cursor.kind === 'before' && cursor.token < 1)
    ) return;
    if (sameTarget) return;
    const readerIndex = get().layers.findLastIndex((layer) => layer.kind === 'reader');
    const readerLayer = get().layers[readerIndex];
    if (readerIndex < 0 || readerLayer?.kind !== 'reader') return;
    const sameDocument = target.doc === place.doc;
    const nextPlace: ReaderPlace = {
      ...place,
      doc: target.doc,
      cursor: { ...cursor },
      anchor,
      from: origin ?? place.from,
    };
    const nextLayer: Layer = {
      ...readerLayer,
      target: Object.freeze(nextPlace),
    };
    const layers = get().layers.map((layer, index) =>
      index === readerIndex ? nextLayer : layer);
    rememberLayer(nextLayer, layers);
    writeNavigation(
      'replace',
      get().place,
      layers,
      {
        preserveReaderNavigation: sameDocument,
        // Reader targets are retained in the local layer registry. The bounded
        // browser entry stores only layer ids, which did not change.
        writeHistory: false,
      },
    );
    if (!sameDocument) readerWalk = null;
    get().runReader();
  };

  const actions: ReaderActions = {
    openReader(intent, returnFocusTo = `place-${get().place}-heading`) {
      if (get().interaction.kind === 'rsvp') return;
      const snapshot = get().snapshot;
      const place = readerPlaceFor(
        intent,
        snapshot?.snapshot ?? null,
        snapshot?.readyDocs ?? [],
      );
      if (place) {
        // Entrances from analytical evidence always begin in readable prose.
        // Subsequent movement inside Reader uses replaceReaderTarget and
        // deliberately leaves this transient scale untouched.
        set({ readerScale: 'read' });
        const origin: PositionHistoryOrigin = intent.from === 'kwic'
          ? 'matches'
          : intent.from === 'footer'
            ? 'seek'
            : intent.from === 'inputs'
              ? 'reader'
              : intent.from;
        const target = { doc: intent.doc, token: intent.token };
        const previous = get().scrub;
        recordPositionJump(previous, target, origin);
        if (previous?.doc !== target.doc || previous.token !== target.token) {
          set(readingPositionPatch(target));
        }
        const next = freshLayer(
          'reader',
          Object.freeze(place),
          returnFocusTo,
        );
        const replacing = get().layers.at(-1)?.kind === 'reader';
        const layers = replacing
          ? replaceTopLayer(get().layers, next)
          : pushLayerStack(get().layers, next);
        rememberLayer(next, layers);
        writeNavigation(replacing ? 'replace' : 'push', get().place, layers);
        get().runReader();
      }
    },

    stepReaderDocument(direction) {
      const state = get();
      const snapshot = state.snapshot;
      const place = state.readerPlace;
      if (
        state.interaction.kind === 'rsvp'
        || snapshot === null
        || place === null
        || (direction !== -1 && direction !== 1)
      ) return null;
      const order = readyReaderDocumentOrder(
        state.projectSession?.project.data.order ?? [],
        snapshot.readyDocs,
      );
      const token = state.scrub?.doc === place.doc
        ? state.scrub.token
        : readerCursorToken(place.cursor);
      const target = adjacentReadableDocumentAtRelativePosition(
        order,
        place.doc,
        direction,
        token,
        (doc) => state.corpusTokenCounts.get(doc),
      );
      if (target === null) return null;
      get().setScrub(target, { kind: 'jump', origin: 'reader' });
      replaceReaderTarget({
        doc: target.doc,
        cursor: { kind: 'around', token: target.token },
      }, 'position');
      return target;
    },

    selectAtlasPosition(target, anchor, descend = false) {
      const state = get();
      const snapshot = state.snapshot;
      const tokenCount = state.corpusTokenCounts.get(target.doc);
      if (
        state.interaction.kind === 'rsvp'
        || state.readerScale !== 'atlas'
        || state.readerPlace === null
        || snapshot === null
        || state.readerPlace.snapshot !== snapshot.snapshot
        || !snapshot.readyDocs.includes(target.doc)
        || !Number.isSafeInteger(target.token)
        || target.token < 0
        || tokenCount === undefined
        || target.token >= tokenCount
        || (anchor !== 'occurrence' && anchor !== 'position')
      ) return;
      if (state.scrub?.doc !== target.doc || state.scrub.token !== target.token) {
        get().setScrub(
          target,
          descend
            ? { kind: 'jump', origin: 'reader' }
            : { kind: 'drift', origin: 'reader' },
        );
      }
      replaceReaderTarget({
        doc: target.doc,
        cursor: { kind: 'around', token: target.token },
      }, anchor);
      if (descend) get().setReaderScale('read');
    },

    setReaderScale(scale) {
      const state = get();
      if (
        state.interaction.kind === 'rsvp'
        || state.readerPlace === null
        || scale === state.readerScale
        || (scale === 'atlas' && !atlasAvailable(state.snapshot?.readyDocs ?? []))
      ) return;
      if (scale === 'atlas') {
        // The Atlas consumes resident dispersion. Cancel an unfinished prose
        // request, but retain a settled page for a query-free return to Read.
        readerLane.supersede();
        set({
          readerScale: scale,
          readerPage: state.readerPage?.state.status === 'ready' ? state.readerPage : null,
          readerVisibleRange:
            state.readerPage?.state.status === 'ready' ? state.readerVisibleRange : null,
          readerCursorToken:
            state.readerPage?.state.status === 'ready' ? state.readerCursorToken : null,
          readerNavigation:
            state.readerPage?.state.status === 'ready' ? state.readerNavigation : null,
        });
        return;
      }
      set({ readerScale: scale });
      const current = get();
      const effectiveTracks = effectiveTrackSpecs(current.series);
      const pageIsResident = current.readerPage !== null
        && sameReaderPlace(current.readerPage.place, current.readerPlace)
        && current.readerPage.state.status === 'ready'
        && effectiveTracks !== null
        && sameReaderTrackSet(current.readerPage.tracks, effectiveTracks.captured);
      if (!pageIsResident) current.runReader();
    },

    setAtlasNormalization(normalization) {
      set((state) => state.atlasNormalization === normalization
        ? state
        : { atlasNormalization: normalization });
    },

    setReaderVisibleRange(range) {
      const state = get();
      if (state.interaction.kind === 'rsvp' || state.readerScale !== 'read') return;
      const place = state.readerPlace;
      const source = state.readerPage
        && place
        && sameReaderPlace(state.readerPage.place, place)
        && state.readerPage.state.status === 'ready'
        ? state.readerPage.state.page
        : null;
      if (
        source === null
        || range.snapshot !== state.readerPage?.snapshot
        || range.doc !== source.doc
        || range.doc !== place?.doc
        || !Number.isSafeInteger(range.tokens.start)
        || !Number.isSafeInteger(range.tokens.end)
        || range.tokens.start < source.tokens.start
        || range.tokens.end > source.tokens.end
        || range.tokens.start >= range.tokens.end
        || range.geometry.length === 0
      ) return;

      if (
        readerWalk === null
        || readerWalk.snapshot !== range.snapshot
        || readerWalk.doc !== range.doc
        || readerWalk.geometry !== range.geometry
      ) {
        readerWalk = {
          snapshot: range.snapshot,
          doc: range.doc,
          geometry: range.geometry,
          boundaries: [range.tokens.start, range.tokens.end],
          index: 0,
        };
      } else {
        const walk = readerWalk;
        const existing = walk.boundaries.findIndex((boundary, index) =>
          boundary === range.tokens.start
          && walk.boundaries[index + 1] === range.tokens.end);
        if (existing >= 0) {
          walk.index = existing;
        } else if (walk.boundaries.at(-1) === range.tokens.start) {
          walk.boundaries.push(range.tokens.end);
          walk.index = walk.boundaries.length - 2;
        } else if (walk.boundaries[0] === range.tokens.end) {
          walk.boundaries.unshift(range.tokens.start);
          walk.index = 0;
        } else {
          walk.boundaries = [range.tokens.start, range.tokens.end];
          walk.index = 0;
        }
      }
      const MAX_READER_BOUNDARIES = 257;
      if (readerWalk.boundaries.length > MAX_READER_BOUNDARIES) {
        if (readerWalk.index > MAX_READER_BOUNDARIES / 2) {
          readerWalk.boundaries.shift();
          readerWalk.index--;
        } else {
          readerWalk.boundaries.pop();
        }
      }
      const previousStart = readerWalk.index > 0
        ? readerWalk.boundaries[readerWalk.index - 1]
        : null;
      const preservedCursor = preservedReadingCursor(
        state.readerCursorToken,
        range.tokens,
      );
      const selectionToken = publishedReadingToken(
        preservedCursor,
        place.cursor,
        range.tokens,
      );
      const positionPatch = readingPositionPatch(
        { doc: source.doc, token: selectionToken }, 'reader',
      );
      set({
        readerVisibleRange: range,
        readerCursorToken: preservedCursor,
        readerNavigation: {
          previous: previousStart !== null && previousStart !== undefined
            ? { doc: source.doc, cursor: { kind: 'from', token: previousStart } }
            : range.tokens.start === 0
              ? adjacentReaderDocument(state, source.doc, -1)
              : { doc: source.doc, cursor: { kind: 'before', token: range.tokens.start } },
          next: range.tokens.end === source.docTokenCount
            ? adjacentReaderDocument(state, source.doc, 1)
            : { doc: source.doc, cursor: { kind: 'from', token: range.tokens.end } },
        },
        ...positionPatch,
      });
    },

    setReadingCursor(token) {
      const state = get();
      const place = state.readerPlace;
      const page = state.readerPage;
      const visible = state.readerVisibleRange;
      if (
        state.interaction.kind === 'rsvp'
        || state.readerScale !== 'read'
        || place === null
        || page === null
        || page.state.status !== 'ready'
        || visible === null
        || page.snapshot !== visible.snapshot
        || page.snapshot !== place.snapshot
        || page.state.page.doc !== place.doc
        || visible.doc !== place.doc
        || !Number.isSafeInteger(token)
        || token < visible.tokens.start
        || token >= visible.tokens.end
      ) return;
      const positionPatch = readingPositionPatch({ doc: place.doc, token }, 'reader');
      set({
        readerCursorToken: token,
        ...positionPatch,
      });
    },

    refitReaderAt(token) {
      const state = get();
      if (state.interaction.kind === 'rsvp' || state.readerScale !== 'read') return;
      const visible = state.readerVisibleRange;
      const source = state.readerPage?.state.status === 'ready'
        ? state.readerPage.state.page
        : null;
      if (
        visible === null
        || source === null
        || visible.snapshot !== state.readerPage?.snapshot
        || visible.doc !== source.doc
        || token !== visible.tokens.start
        || token < source.tokens.start
        || token >= source.tokens.end
      ) return;
      replaceReaderTarget({ doc: source.doc, cursor: { kind: 'from', token } });
    },

    seekReader(token, phase = 'commit') {
      const state = get();
      const place = state.readerPlace;
      const session = readerSeekSession;
      // A rejected commit must still end the prior gesture. Otherwise a
      // later seek could record history from an abandoned, stale origin.
      if (phase === 'commit') readerSeekSession = null;
      const readyPage = state.readerPage
        && place
        && sameReaderPlace(state.readerPage.place, place)
        && state.readerPage.state.status === 'ready'
        ? state.readerPage.state.page
        : null;
      const tokenCount = session !== null && session.doc === place?.doc
        ? session.tokenCount
        : readyPage?.docTokenCount
        ?? (place === null ? undefined : state.corpusTokenCounts.get(place.doc));
      if (
        state.interaction.kind === 'rsvp'
        || state.readerScale !== 'read'
        || place === null
        || tokenCount === undefined
        || !Number.isSafeInteger(token)
        || token < 0
        || token >= tokenCount
      ) return;
      const target = { doc: place.doc, token };
      let activeSession = session !== null && session.doc === place.doc
        ? session
        : null;
      if (phase === 'start' || (phase === 'preview' && activeSession === null)) {
        activeSession = {
          doc: place.doc,
          origin: state.scrub,
          tokenCount,
        };
        readerSeekSession = activeSession;
      }
      if (phase === 'commit') {
        const origin = activeSession?.origin ?? state.scrub;
        if (origin?.doc !== target.doc || origin.token !== target.token) {
          recordPositionJump(origin, target, 'seek');
        }
      }
      const changed = state.scrub?.doc !== place.doc || state.scrub.token !== token;
      const positionPatch = readingPositionPatch(target);
      const visible = state.readerVisibleRange;
      if (
        visible !== null
        && visible.snapshot === place.snapshot
        && visible.doc === place.doc
        && token >= visible.tokens.start
        && token < visible.tokens.end
      ) {
        set({
          readerCursorToken: token,
          ...positionPatch,
        });
        return;
      }
      if (changed) {
        set(positionPatch);
      }
      replaceReaderTarget(
        { doc: place.doc, cursor: { kind: 'from', token } },
        'position',
      );
    },

    navigateReader(target) {
      if (get().interaction.kind === 'rsvp' || get().readerScale !== 'read') return;
      const { readerPlace: place, readerNavigation: navigation, readerPage } = get();
      const destination: ReaderNavigationTarget | null = place === null
        ? null
        : 'doc' in target
          ? target
          : { doc: place.doc, cursor: target };
      const readyPage = readerPage
        && place
        && sameReaderPlace(readerPage.place, place)
        && readerPage.state.status === 'ready'
        ? readerPage.state.page
        : null;
      const boundaryCursor = destination !== null
        && destination.doc === place?.doc
        && ((destination.cursor.kind === 'from' && destination.cursor.token === 0)
        || (
          destination.cursor.kind === 'before'
          && readyPage !== null
          && destination.cursor.token === readyPage.docTokenCount
        ));
      const matchesNavigation = (candidate: ReaderNavigationTarget | null): boolean =>
        destination !== null
        && candidate !== null
        && destination.doc === candidate.doc
        && sameReaderCursor(destination.cursor, candidate.cursor);
      if (
        !place
        || destination === null
        || !navigation
        || (
          !boundaryCursor
          && !matchesNavigation(navigation.previous)
          && !matchesNavigation(navigation.next)
        )
      ) return;
      replaceReaderTarget(destination);
    },

    retryReader() {
      if (get().readerPlace) get().runReader();
    },

    closeReader() {
      readerSeekSession = null;
      requestBack();
    },

    runReader() {
      readerLane.supersede();
      const { snapshot, readerPlace: place, readerScale, series } = get();
      if (
        !snapshot
        || !place
        || place.snapshot !== snapshot.snapshot
        || !snapshot.readyDocs.includes(place.doc)
      ) {
        set({
          readerPage: null,
          readerVisibleRange: null,
          readerCursorToken: null,
          readerNavigation: null,
        });
        return;
      }
      if (readerScale === 'atlas') return;
      const tracks = effectiveTrackSpecs(series);
      if (tracks === null) {
        set({
          readerPage: null,
          readerVisibleRange: null,
          readerCursorToken: null,
          readerNavigation: null,
        });
        return;
      }
      const issuedKey = snapshotKey();
      const issuedPlace = place;
      const lease = readerLane.ops.begin(
        () => snapshotKey() === issuedKey,
        () => sameReaderPlace(get().readerPlace, issuedPlace),
        () => identitiesCurrent(tracks.identities),
      );
      set({
        readerPage: {
          snapshot: snapshot.snapshot,
          place: issuedPlace,
          tracks: tracks.captured,
          state: { status: 'pending' },
        },
        readerVisibleRange: null,
        readerCursorToken: null,
      });
      issueOn(
        readerLane,
        snapshot.snapshot,
        {
          op: 'reader-page',
          tracks: tracks.wire,
          request: {
            method: 'reader-page/1',
            doc: issuedPlace.doc,
            cursor: issuedPlace.cursor,
            maxTokens: READER_SOURCE_MAX_TOKENS,
          },
        },
        lease,
        (data) => {
          if (data.page.doc !== issuedPlace.doc) {
            set({
              readerPage: {
                snapshot: snapshot.snapshot,
                place: issuedPlace,
                tracks: tracks.captured,
                state: { status: 'error', message: 'reader returned the wrong document' },
              },
            });
            return;
          }
          set({
            readerPage: {
              snapshot: snapshot.snapshot,
              place: issuedPlace,
              tracks: tracks.captured,
              state: { status: 'ready', page: data.page },
            },
          });
        },
        (message) => set({
          readerPage: {
            snapshot: snapshot.snapshot,
            place: issuedPlace,
            tracks: tracks.captured,
            state: { status: 'error', message },
          },
        }),
      );
    },
  };
  return {
    initial: {
      readerPlace: null,
      readerScale: DEFAULT_READER_SCALE,
      atlasNormalization: deps.atlasNormalization ?? DEFAULT_ATLAS_NORMALIZATION,
      readerPage: null,
      readerVisibleRange: null,
      readerCursorToken: null,
      readerNavigation: null,
    } satisfies Pick<AppState, 'readerPlace' | 'readerScale' | 'atlasNormalization'
      | 'readerPage' | 'readerVisibleRange' | 'readerCursorToken' | 'readerNavigation'>,
    actions,
    replaceTarget: replaceReaderTarget,
    supersede: () => readerLane.supersede(),
    resetSeek: () => { readerSeekSession = null; },
    dispose() {
      readerLane.supersede();
      readerWalk = null;
      readerSeekSession = null;
    },
  };
}
