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
  TREND_FIXED_TOKENS_MAX,
  TREND_FIXED_TOKENS_MIN,
  TREND_PER_DOC_MAX,
  TREND_PER_DOC_MIN,
  type TrendBinsSpecV1,
} from '../ops/trend.ts';
import {
  NOTEBOOK_LIMITS_V1,
  parseQueryNotebook,
  type QueryNotebookV1,
} from './notebook.ts';

export const RESEARCH_MAX_ID_UNITS = 128;
export const RESEARCH_MAX_DOC_UNITS = 256;

export const TREND_RATE_DENOMINATORS = [1_000, 10_000, 100_000] as const;
export const TREND_SMOOTHING_WINDOWS = [3, 5, 7, 9] as const;

export type TrendRateDenominator = (typeof TREND_RATE_DENOMINATORS)[number];
export type TrendSmoothingWindow = (typeof TREND_SMOOTHING_WINDOWS)[number];

export type TrendMeasureV2 =
  | {
      readonly kind: 'rate';
      readonly denominator: TrendRateDenominator;
      readonly smoothing: 0 | TrendSmoothingWindow;
      readonly showRaw: boolean;
    }
  | { readonly kind: 'count' };

export interface TrendResearchViewV2 {
  readonly schema: 'texttrends/trend-view/2';
  readonly mode: 'series' | 'by-book';
  readonly sectionMarks: boolean;
  readonly focusedDoc: string | null;
  readonly bins: TrendBinsSpecV1;
  readonly measure: TrendMeasureV2;
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
  readonly views: {
    readonly trend: TrendResearchViewV2;
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

function parseTrendBins(value: unknown): TrendBinsSpecV1 {
  if (
    !exactRecord(value, ['mode', 'count']) ||
    !isNonNegSafeInt(value.count) ||
    (
      value.mode === 'per-doc'
        ? value.count < TREND_PER_DOC_MIN || value.count > TREND_PER_DOC_MAX
        : value.mode === 'fixed-tokens'
          ? value.count < TREND_FIXED_TOKENS_MIN || value.count > TREND_FIXED_TOKENS_MAX
          : true
    )
  ) {
    throw new RangeError('invalid trend bins');
  }
  return value as unknown as TrendBinsSpecV1;
}

function parseTrendMeasure(value: unknown): TrendMeasureV2 {
  if (exactRecord(value, ['kind']) && value.kind === 'count') {
    return value as unknown as TrendMeasureV2;
  }
  if (
    !exactRecord(value, ['kind', 'denominator', 'smoothing', 'showRaw']) ||
    value.kind !== 'rate' ||
    !TREND_RATE_DENOMINATORS.includes(value.denominator as TrendRateDenominator) ||
    (
      value.smoothing !== 0 &&
      !TREND_SMOOTHING_WINDOWS.includes(value.smoothing as TrendSmoothingWindow)
    ) ||
    typeof value.showRaw !== 'boolean'
  ) {
    throw new RangeError('invalid trend measure');
  }
  return value as unknown as TrendMeasureV2;
}

export function parseTrendResearchView(value: unknown): TrendResearchViewV2 {
  if (exactRecord(value, ['schema', 'mode', 'sectionMarks', 'focusedDoc'])) {
    if (
      value.schema !== 'texttrends/trend-view/1' ||
      (value.mode !== 'series' && value.mode !== 'by-book') ||
      typeof value.sectionMarks !== 'boolean'
    ) {
      throw new RangeError('invalid legacy trend view');
    }
    if (value.focusedDoc !== null) {
      boundedString(value.focusedDoc, RESEARCH_MAX_DOC_UNITS, 'focused document');
    }
    return {
      schema: 'texttrends/trend-view/2',
      mode: value.mode,
      sectionMarks: value.sectionMarks,
      focusedDoc: value.focusedDoc,
      bins: { mode: 'per-doc', count: 40 },
      measure: {
        kind: 'rate',
        denominator: 10_000,
        smoothing: 0,
        showRaw: false,
      },
    };
  }
  if (!exactRecord(value, ['schema', 'mode', 'sectionMarks', 'focusedDoc', 'bins', 'measure'])) {
    throw new RangeError('trend view must be exact');
  }
  if (
    value.schema !== 'texttrends/trend-view/2' ||
    (value.mode !== 'series' && value.mode !== 'by-book') ||
    typeof value.sectionMarks !== 'boolean'
  ) {
    throw new RangeError('invalid trend view');
  }
  if (value.focusedDoc !== null) {
    boundedString(value.focusedDoc, RESEARCH_MAX_DOC_UNITS, 'focused document');
  }
  parseTrendBins(value.bins);
  parseTrendMeasure(value.measure);
  return value as unknown as TrendResearchViewV2;
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
    views: parseViews(value.views),
  };
}

/** Upgrade the original presentation-only trend view to the configurable
 *  trend-view/2 contract. The outer research-state schema stays /1 because
 *  its ownership, CAS, and privacy boundaries are unchanged. */
export function upgradeStoredResearchState(raw: unknown): unknown {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw)
  ) {
    const record = raw as Record<string, unknown>;
    let withoutLegacyCapture = record;
    if ('selections' in record || 'pins' in record) {
      const { selections: _selections, pins: _pins, ...remaining } = record;
      withoutLegacyCapture = remaining;
    }
    const views = withoutLegacyCapture.views;
    if (views !== null && typeof views === 'object' && !Array.isArray(views)) {
      const viewRecord = views as Record<string, unknown>;
      const trend = viewRecord.trend;
      if (
        trend !== null &&
        typeof trend === 'object' &&
        !Array.isArray(trend) &&
        (trend as Record<string, unknown>).schema === 'texttrends/trend-view/1'
      ) {
        const legacy = trend as Record<string, unknown>;
        return {
          ...withoutLegacyCapture,
          views: {
            ...viewRecord,
            trend: {
              schema: 'texttrends/trend-view/2',
              mode: legacy.mode,
              sectionMarks: legacy.sectionMarks,
              focusedDoc: legacy.focusedDoc,
              bins: { mode: 'per-doc', count: 40 },
              measure: {
                kind: 'rate',
                denominator: 10_000,
                smoothing: 0,
                showRaw: false,
              },
            },
          },
        };
      }
    }
    return withoutLegacyCapture;
  }
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
