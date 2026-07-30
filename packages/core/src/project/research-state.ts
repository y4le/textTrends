/**
 * Durable research-state schema. This is authored class-1 data with its own
 * CAS revision; it is intentionally separate from the corpus manifest and
 * from disposable artifact caches.
 */

import type { TextHash } from '../contract/brands.ts';
import {
  exactArray,
  exactRecord,
  isNonNegSafeInt,
} from '../contract/guards.ts';
import { FREQUENCY_PAGE_MAX } from '../ops/frequency.ts';
import { MAX_KWIC_TRACKS } from '../ops/kwic.ts';
import {
  NOTEBOOK_LIMITS_V1,
  parseQueryNotebook,
  type QueryNotebookV1,
} from './notebook.ts';

export const RESEARCH_MAX_SELECTIONS = 32;
export const RESEARCH_MAX_PINS = 8;
export const RESEARCH_MAX_ID_UNITS = 128;
export const RESEARCH_MAX_NAME_UNITS = 256;
export const RESEARCH_MAX_NOTE_UNITS = 2_000;
export const RESEARCH_MAX_DOC_UNITS = 256;
export const RESEARCH_MAX_CAPTURED_TRACKS = MAX_KWIC_TRACKS;

export interface CharAnchorV1 {
  readonly doc: string;
  readonly text: TextHash;
  readonly chars: {
    readonly start: number;
    readonly end: number;
  };
}

export interface SavedSelectionV1 {
  readonly id: string;
  readonly name: string;
  readonly anchor: CharAnchorV1;
}

export interface SavedPinTrackV1 {
  readonly seriesId: string;
  readonly groupId: string;
  readonly identity: string;
  readonly label: string;
}

export interface SavedPinV1 {
  readonly id: string;
  readonly note: string;
  readonly anchor: CharAnchorV1;
  readonly captured: readonly SavedPinTrackV1[];
}

export interface TrendResearchViewV1 {
  readonly schema: 'texttrends/trend-view/1';
  readonly mode: 'series' | 'by-book';
  readonly sectionMarks: boolean;
  readonly focusedDoc: string | null;
}

export interface InventoryViewV1 {
  readonly schema: 'texttrends/inventory-view/1';
  readonly minCount: number;
  readonly minDocFreq: number;
  readonly classes: readonly ('lexical' | 'numeral')[];
  readonly prefixNfc?: string;
  readonly sort: {
    readonly by: 'count' | 'docFreq' | 'dp' | 'dpNorm' | 'key';
    readonly dir: 1 | -1;
  };
  readonly pageSize: number;
}

export interface KeynessViewV1 {
  readonly schema: 'texttrends/keyness-view/1';
  /** Side membership by TextHash, never app-local document IDs. */
  readonly a: readonly TextHash[];
  readonly b: readonly TextHash[];
  readonly mode: 'documents' | 'document-rest';
  readonly filter: {
    readonly minCountTotal: number;
    readonly minDocFreqTotal: number;
    readonly classes: readonly ('lexical' | 'numeral')[];
  };
  readonly sort: {
    readonly by: 'logRatio' | 'g2' | 'countA' | 'countB';
    readonly dirA: 1 | -1;
    readonly dirB: 1 | -1;
  };
  readonly pageSize: number;
}

export interface ResearchStateV1 {
  readonly schema: 'texttrends/research-state/1';
  readonly project: string;
  readonly revision: number;
  readonly notebook: QueryNotebookV1;
  readonly active: readonly string[];
  readonly kwicEnabled: readonly string[];
  readonly selections: readonly SavedSelectionV1[];
  readonly pins: readonly SavedPinV1[];
  readonly views: {
    readonly trend: TrendResearchViewV1;
    readonly inventory: InventoryViewV1;
    readonly keyness: KeynessViewV1;
  };
}

function exactDenseArray(
  value: unknown,
  max: number,
  what: string,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new RangeError(`${what} exceeds its ${max}-item cap`);
  }
  if (!exactArray(value, value.length)) {
    throw new RangeError(`${what} must be a dense plain array`);
  }
  return value;
}

function boundedString(
  value: unknown,
  max: number,
  what: string,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > max
  ) {
    throw new RangeError(`${what} must be ${allowEmpty ? 'at most' : '1..'} ${max} UTF-16 units`);
  }
}

function uniqueStrings(
  value: unknown,
  max: number,
  what: string,
): readonly string[] {
  const rows = exactDenseArray(value, max, what);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    const item = rows[index];
    boundedString(item, RESEARCH_MAX_ID_UNITS, `${what}[${index}]`);
    if (seen.has(item)) throw new RangeError(`${what} contains duplicate '${item}'`);
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function parseCharAnchor(
  value: unknown,
  what = 'character anchor',
): CharAnchorV1 {
  if (!exactRecord(value, ['doc', 'text', 'chars'])) {
    throw new RangeError(`${what} must be an exact character anchor`);
  }
  boundedString(value.doc, RESEARCH_MAX_DOC_UNITS, `${what}.doc`);
  if (typeof value.text !== 'string' || !/^[0-9a-f]{64}$/.test(value.text)) {
    throw new RangeError(`${what}.text must be a TextHash`);
  }
  if (
    !exactRecord(value.chars, ['start', 'end']) ||
    !isNonNegSafeInt(value.chars.start) ||
    !isNonNegSafeInt(value.chars.end) ||
    value.chars.start > value.chars.end
  ) {
    throw new RangeError(`${what}.chars must be a nondecreasing UTF-16 range`);
  }
  return value as unknown as CharAnchorV1;
}

function parseSelections(value: unknown): readonly SavedSelectionV1[] {
  const rows = exactDenseArray(
    value,
    RESEARCH_MAX_SELECTIONS,
    'saved selections',
  );
  const ids = new Set<string>();
  return rows.map((item, index) => {
    if (!exactRecord(item, ['id', 'name', 'anchor'])) {
      throw new RangeError(`saved selection ${index} must be exact`);
    }
    boundedString(item.id, RESEARCH_MAX_ID_UNITS, `selection ${index}.id`);
    boundedString(item.name, RESEARCH_MAX_NAME_UNITS, `selection ${index}.name`);
    if (item.name !== item.name.normalize('NFC')) {
      throw new RangeError(`selection ${index}.name must be NFC`);
    }
    if (ids.has(item.id)) throw new RangeError(`duplicate selection id '${item.id}'`);
    ids.add(item.id);
    return {
      id: item.id,
      name: item.name,
      anchor: parseCharAnchor(item.anchor, `selection ${index}.anchor`),
    };
  });
}

function parseCaptured(value: unknown, pinIndex: number): readonly SavedPinTrackV1[] {
  const rows = exactDenseArray(
    value,
    RESEARCH_MAX_CAPTURED_TRACKS,
    `pin ${pinIndex}.captured`,
  );
  const series = new Set<string>();
  return rows.map((item, index) => {
    if (!exactRecord(item, ['seriesId', 'groupId', 'identity', 'label'])) {
      throw new RangeError(`pin ${pinIndex} captured track ${index} must be exact`);
    }
    boundedString(item.seriesId, RESEARCH_MAX_ID_UNITS, 'captured series id');
    boundedString(item.groupId, RESEARCH_MAX_ID_UNITS, 'captured group id');
    boundedString(item.identity, RESEARCH_MAX_NAME_UNITS, 'captured identity');
    boundedString(item.label, RESEARCH_MAX_NAME_UNITS, 'captured label');
    if (series.has(item.seriesId)) {
      throw new RangeError(`pin ${pinIndex} repeats captured series '${item.seriesId}'`);
    }
    series.add(item.seriesId);
    return item as unknown as SavedPinTrackV1;
  });
}

function parsePins(value: unknown): readonly SavedPinV1[] {
  const rows = exactDenseArray(value, RESEARCH_MAX_PINS, 'saved pins');
  const ids = new Set<string>();
  return rows.map((item, index) => {
    if (!exactRecord(item, ['id', 'note', 'anchor', 'captured'])) {
      throw new RangeError(`saved pin ${index} must be exact`);
    }
    boundedString(item.id, RESEARCH_MAX_ID_UNITS, `pin ${index}.id`);
    boundedString(item.note, RESEARCH_MAX_NOTE_UNITS, `pin ${index}.note`, true);
    if (item.note !== item.note.normalize('NFC')) {
      throw new RangeError(`pin ${index}.note must be NFC`);
    }
    if (ids.has(item.id)) throw new RangeError(`duplicate pin id '${item.id}'`);
    ids.add(item.id);
    return {
      id: item.id,
      note: item.note,
      anchor: parseCharAnchor(item.anchor, `pin ${index}.anchor`),
      captured: parseCaptured(item.captured, index),
    };
  });
}

function parseClasses(value: unknown, what: string): readonly ('lexical' | 'numeral')[] {
  const rows = exactDenseArray(value, 2, what);
  if (
    rows.length === 0 ||
    rows.some((item) => item !== 'lexical' && item !== 'numeral') ||
    new Set(rows).size !== rows.length
  ) {
    throw new RangeError(`${what} must be a nonempty unique token-class list`);
  }
  return rows as readonly ('lexical' | 'numeral')[];
}

export function parseTrendResearchView(value: unknown): TrendResearchViewV1 {
  if (!exactRecord(value, ['schema', 'mode', 'sectionMarks', 'focusedDoc'])) {
    throw new RangeError('trend view must be exact');
  }
  if (
    value.schema !== 'texttrends/trend-view/1' ||
    (value.mode !== 'series' && value.mode !== 'by-book') ||
    typeof value.sectionMarks !== 'boolean'
  ) {
    throw new RangeError('invalid trend view');
  }
  if (value.focusedDoc !== null) {
    boundedString(value.focusedDoc, RESEARCH_MAX_DOC_UNITS, 'focused document');
  }
  return value as unknown as TrendResearchViewV1;
}

export function parseInventoryResearchView(value: unknown): InventoryViewV1 {
  const hasPrefix = exactRecord(value, [
    'schema',
    'minCount',
    'minDocFreq',
    'classes',
    'prefixNfc',
    'sort',
    'pageSize',
  ]);
  if (
    !hasPrefix &&
    !exactRecord(value, [
      'schema',
      'minCount',
      'minDocFreq',
      'classes',
      'sort',
      'pageSize',
    ])
  ) {
    throw new RangeError('inventory view must be exact');
  }
  if (
    value.schema !== 'texttrends/inventory-view/1' ||
    !isNonNegSafeInt(value.minCount) ||
    value.minCount < 1 ||
    !isNonNegSafeInt(value.minDocFreq) ||
    value.minDocFreq < 1 ||
    !exactRecord(value.sort, ['by', 'dir']) ||
    !['count', 'docFreq', 'dp', 'dpNorm', 'key'].includes(value.sort.by as string) ||
    (value.sort.dir !== 1 && value.sort.dir !== -1) ||
    !isNonNegSafeInt(value.pageSize) ||
    value.pageSize < 1 ||
    value.pageSize > FREQUENCY_PAGE_MAX
  ) {
    throw new RangeError('invalid inventory view');
  }
  parseClasses(value.classes, 'inventory classes');
  if (hasPrefix) {
    boundedString(value.prefixNfc, 64, 'inventory prefix');
    if (value.prefixNfc !== value.prefixNfc.normalize('NFC')) {
      throw new RangeError('inventory prefix must be NFC');
    }
  }
  return value as unknown as InventoryViewV1;
}

export function parseKeynessResearchView(value: unknown): KeynessViewV1 {
  if (
    !exactRecord(value, [
      'schema',
      'a',
      'b',
      'mode',
      'filter',
      'sort',
      'pageSize',
    ])
  ) {
    throw new RangeError('keyness view must be exact');
  }
  const a = uniqueStrings(value.a, 64, 'keyness side A');
  const b = uniqueStrings(value.b, 64, 'keyness side B');
  if (
    a.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
    b.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
    a.some((hash) => b.includes(hash))
  ) {
    throw new RangeError('keyness sides must contain disjoint TextHashes');
  }
  if (
    value.schema !== 'texttrends/keyness-view/1' ||
    (value.mode !== 'documents' && value.mode !== 'document-rest') ||
    !exactRecord(value.filter, [
      'minCountTotal',
      'minDocFreqTotal',
      'classes',
    ]) ||
    !isNonNegSafeInt(value.filter.minCountTotal) ||
    value.filter.minCountTotal < 1 ||
    !isNonNegSafeInt(value.filter.minDocFreqTotal) ||
    value.filter.minDocFreqTotal < 1 ||
    !exactRecord(value.sort, ['by', 'dirA', 'dirB']) ||
    !['logRatio', 'g2', 'countA', 'countB'].includes(value.sort.by as string) ||
    (value.sort.dirA !== 1 && value.sort.dirA !== -1) ||
    (value.sort.dirB !== 1 && value.sort.dirB !== -1) ||
    !isNonNegSafeInt(value.pageSize) ||
    value.pageSize < 1 ||
    value.pageSize > FREQUENCY_PAGE_MAX
  ) {
    throw new RangeError('invalid keyness view');
  }
  parseClasses(value.filter.classes, 'keyness classes');
  return value as unknown as KeynessViewV1;
}

function parseViews(value: unknown): ResearchStateV1['views'] {
  if (!exactRecord(value, ['trend', 'inventory', 'keyness'])) {
    throw new RangeError('research views must be exact');
  }
  return {
    trend: parseTrendResearchView(value.trend),
    inventory: parseInventoryResearchView(value.inventory),
    keyness: parseKeynessResearchView(value.keyness),
  };
}

export function parseResearchState(value: unknown): ResearchStateV1 {
  if (
    !exactRecord(value, [
      'schema',
      'project',
      'revision',
      'notebook',
      'active',
      'kwicEnabled',
      'selections',
      'pins',
      'views',
    ])
  ) {
    throw new RangeError('research state must be an exact v1 record');
  }
  if (value.schema !== 'texttrends/research-state/1') {
    throw new RangeError('unknown research-state schema');
  }
  boundedString(value.project, RESEARCH_MAX_ID_UNITS, 'research project');
  if (!isNonNegSafeInt(value.revision) || value.revision < 1) {
    throw new RangeError('research revision must be a positive safe integer');
  }
  const notebook = parseQueryNotebook(value.notebook);
  const active = uniqueStrings(value.active, MAX_KWIC_TRACKS, 'active groups');
  const kwicEnabled = uniqueStrings(
    value.kwicEnabled,
    NOTEBOOK_LIMITS_V1.maxGroups,
    'KWIC-enabled groups',
  );
  return {
    schema: 'texttrends/research-state/1',
    project: value.project,
    revision: value.revision,
    notebook,
    active,
    kwicEnabled,
    selections: parseSelections(value.selections),
    pins: parsePins(value.pins),
    views: parseViews(value.views),
  };
}

/** V1 identity seam; future upgrades may recognize only older schemas. */
export function upgradeStoredResearchState(raw: unknown): unknown {
  return raw;
}

/** Drop presentation references to notebook groups that no longer exist. */
export function reconcileResearchState(state: ResearchStateV1): ResearchStateV1 {
  const admitted = new Set(state.notebook.groups.map((group) => group.id));
  return {
    ...state,
    active: state.active.filter((id) => admitted.has(id)),
    kwicEnabled: state.kwicEnabled.filter((id) => admitted.has(id)),
  };
}
