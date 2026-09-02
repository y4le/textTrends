import { findScope } from '../../lib/interaction.ts';
import { readerCommands, type ReaderCommand } from '../../lib/reader-commands.ts';
import { readerCursorWord } from '../../lib/reader-cursor.ts';
import {
  adjacentReadableDocumentAtRelativePosition,
  readyReaderDocumentOrder,
} from '../../lib/reader-order.ts';
import { readerPosition, type ReaderPosition } from '../../lib/reader-position.ts';
import { readerProgress, type ReaderProgress } from '../../lib/reader-progress.ts';
import { sameReaderPlace } from '../../lib/reader-intent.ts';
import { useApp } from '../../lib/store-instance.ts';
import type { ReaderPageResultV1 } from '../../shared/analysis-contract.ts';

export interface ReaderChromeModel {
  readonly position: ReaderPosition | null;
  readonly progress: ReaderProgress | null;
  readonly commands: readonly ReaderCommand[];
  readonly readyPage: ReaderPageResultV1 | null;
}

export function useReaderChromeModel(): ReaderChromeModel {
  const place = useApp((state) => state.readerPlace);
  const scale = useApp((state) => state.readerScale);
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const tokenCounts = useApp((state) => state.corpusTokenCounts);
  const explicitCursor = useApp((state) => state.readerCursorToken);
  const pageState = useApp((state) => state.readerPage);
  const visible = useApp((state) => state.readerVisibleRange);
  const navigation = useApp((state) => state.readerNavigation);
  const interaction = useApp((state) => state.interaction);
  const series = useApp((state) => state.series);
  const occurrenceNavigation = useApp((state) => state.occurrenceNavigation);
  const readyPage = place !== null
    && pageState !== null
    && sameReaderPlace(pageState.place, place)
    && pageState.state.status === 'ready'
    ? pageState.state.page
    : null;
  const order = readyReaderDocumentOrder(project?.data.order, snapshot?.readyDocs ?? []);
  const titleOf = (doc: string) =>
    project?.data.docs.find((entry) => entry.doc === doc)?.meta.title ?? doc;
  const position = snapshot === null
    ? null
    : readerPosition({
        place,
        page: readyPage,
        visible,
        explicitCursor,
        order,
        titleOf,
        fallbackTokenCount: place === null ? undefined : tokenCounts.get(place.doc),
      });
  const countOf = (doc: string) => doc === place?.doc && position?.tokenCount
    ? position.tokenCount
    : tokenCounts.get(doc);
  const previousText = place === null || position === null
    ? null
    : adjacentReadableDocumentAtRelativePosition(
        order, place.doc, -1, position.token, countOf,
      );
  const nextText = place === null || position === null
    ? null
    : adjacentReadableDocumentAtRelativePosition(
        order, place.doc, 1, position.token, countOf,
      );
  const scopedFind = findScope(interaction);
  const findMode = scopedFind !== null;
  const hasPresentedTerms = findMode ? scopedFind.find !== null : series.length > 0;
  const occurrencePending = findMode
    ? scopedFind.find?.state.status === 'pending'
    : occurrenceNavigation?.state.status === 'pending';
  const speedWord = readyPage === null
    ? null
    : readerCursorWord(readyPage, explicitCursor);
  const commands = readerCommands({
    position,
    navigation,
    scale,
    atlasAvailable: order.length > 1,
    speedAvailable: readyPage !== null,
    speedWord,
    hasPresentedTerms,
    occurrencePending,
    findMode,
    previousText,
    nextText,
    titleOf,
  });
  return {
    position,
    progress: position === null
      ? null
      : readerProgress(position.token, position.tokenCount, position.title),
    commands,
    readyPage,
  };
}
