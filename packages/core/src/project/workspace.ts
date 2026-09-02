/**
 * The browser workspace is the one durable description of the current
 * corpus and analysis preferences. Source bytes live in the local library;
 * worker texts and indexes are disposable artifacts.
 */

import { exactArray, exactRecord, isNonNegSafeInt } from '../contract/guards.ts';
import { INGEST_CAPS_V0 } from '../contract/ingest-caps.ts';
import { isSourceFormat } from '../extract/formats.ts';
import {
  FREQUENCY_FILTER_MAX_UNITS,
  FREQUENCY_PAGE_MAX,
  type FrequencySortFieldV1,
  type FrequencyTextFilterV1,
  type FrequencyTokenClassV1,
} from '../ops/frequency.ts';
import { MAX_KWIC_TRACKS } from '../ops/kwic.ts';
import { type KeynessSortFieldV1 } from '../ops/keyness.ts';
import { STOPLIST_MAX_TOP_N } from '../ops/stoplist-contract.ts';
import {
  TREND_FIXED_TOKENS_MAX,
  TREND_FIXED_TOKENS_MIN,
  TREND_PER_DOC_MAX,
  TREND_PER_DOC_MIN,
  type TrendBinsSpecV1,
} from '../ops/trend.ts';
import { NOTEBOOK_LIMITS_V1, parseQueryNotebook, type QueryNotebookV1 } from './notebook.ts';

export const WORKSPACE_SCHEMA = 'texttrends/workspace/1' as const;
export const WORKSPACE_MAX_ID_UNITS = 256;
const WORKSPACE_MAX_META_UNITS = 512;
const SOURCE_HASH = /^[0-9a-f]{64}$/u;

/** Legacy values accepted while reading workspace/1. New state is normalized. */
export const TREND_RATE_DENOMINATORS = [1_000, 10_000, 100_000] as const;
export const TREND_RATE_DENOMINATOR = 10_000 as const;
export const TREND_SMOOTHING_WINDOWS = [3, 5, 7, 9] as const;

export type TrendRateDenominator = (typeof TREND_RATE_DENOMINATORS)[number];
export type TrendSmoothingWindow = (typeof TREND_SMOOTHING_WINDOWS)[number];

export type WorkspaceTrendMeasureV1 =
  | {
      readonly kind: 'rate';
      readonly denominator: typeof TREND_RATE_DENOMINATOR;
      readonly smoothing: 0 | TrendSmoothingWindow;
      readonly showRaw: boolean;
    }
  | { readonly kind: 'count' };

export interface WorkspaceDocumentMetaV1 {
  readonly title: string;
  readonly author?: string;
  readonly year?: number;
  readonly language: string;
  readonly tags: readonly string[];
}

export interface WorkspaceWarmTextV1 {
  /** A cache hint only. The worker must verify the artifact before using it. */
  readonly textHash: string;
  readonly textLengthUtf16: number;
}

export interface WorkspaceLibraryDocumentV1 {
  /** Stable identity within this workspace; deliberately independent of name. */
  readonly doc: string;
  /** `${format}:${sha256(source bytes)}` in the local library. */
  readonly library: string;
  readonly meta: WorkspaceDocumentMetaV1;
  readonly warm?: WorkspaceWarmTextV1;
}

export interface WorkspaceCorpusV1 {
  readonly kind: 'library';
  readonly order: readonly string[];
  readonly docs: readonly WorkspaceLibraryDocumentV1[];
}

export interface WorkspaceTrendViewV1 {
  readonly mode: 'series' | 'by-book' | 'by-book-scaled';
  readonly bins: TrendBinsSpecV1;
  readonly measure: WorkspaceTrendMeasureV1;
}

export interface WorkspaceFrequencyViewV1 {
  readonly minCount: number;
  readonly minDocFreq: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly stoplistTopN: number;
  readonly filter?: FrequencyTextFilterV1;
  /** Legacy prefix settings are admitted so workspace/1 files remain readable. */
  readonly prefixNfc?: string;
  readonly regex?: string;
  readonly sort: { readonly by: FrequencySortFieldV1; readonly dir: 1 | -1 };
  /** Page offsets are transient; only the user's chosen page size is durable. */
  readonly pageSize: number;
}

export interface WorkspaceCompareViewV1 {
  readonly mode: 'documents' | 'document-rest' | 'selection-rest';
  readonly documentA: string | null;
  readonly documentB: string | null;
  readonly restOn: 'a' | 'b';
  readonly minCountTotal: number;
  readonly minDocFreqTotal: number;
  readonly classes: readonly FrequencyTokenClassV1[];
  readonly stoplistTopN: number;
  readonly sort: {
    readonly by: KeynessSortFieldV1;
    readonly dirA: 1 | -1;
    readonly dirB: 1 | -1;
  };
  /** Legacy omission preserves the former always-shown presentation. */
  readonly showConfidenceIntervals: boolean;
  readonly pageSize: number;
}

export interface WorkspaceV1 {
  readonly schema: typeof WORKSPACE_SCHEMA;
  readonly corpus: WorkspaceCorpusV1;
  readonly notebook: QueryNotebookV1;
  readonly active: readonly string[];
  /** @deprecated Compatibility field for workspace/1 readers. New clients
   * mirror `active`; Matches uses the shared active projection. */
  readonly kwicEnabled: readonly string[];
  readonly views: {
    readonly trend: WorkspaceTrendViewV1;
    readonly frequency: WorkspaceFrequencyViewV1;
    readonly compare: WorkspaceCompareViewV1;
  };
}

function denseArray(value: unknown, max: number, what: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max || !exactArray(value, value.length)) {
    throw new RangeError(`${what} must be a dense plain array with at most ${max} items`);
  }
  return value;
}

function boundedString(value: unknown, max: number, what: string, allowEmpty = false): string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > max
  ) {
    throw new RangeError(`${what} must be ${allowEmpty ? 'at most' : '1..'}${max} UTF-16 units`);
  }
  return value;
}

function uniqueStrings(value: unknown, max: number, what: string): readonly string[] {
  const rows = denseArray(value, max, what);
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const item = boundedString(row, WORKSPACE_MAX_ID_UNITS, `${what}[${index}]`);
    if (seen.has(item)) throw new RangeError(`${what} contains duplicate '${item}'`);
    seen.add(item);
    return item;
  });
}

function parseClasses(value: unknown, what: string): readonly FrequencyTokenClassV1[] {
  const classes = denseArray(value, 2, what);
  if (
    classes.length === 0
    || classes.some((item) => item !== 'lexical' && item !== 'numeral')
    || new Set(classes).size !== classes.length
  ) {
    throw new RangeError(`${what} must be a nonempty unique token-class list`);
  }
  return classes as readonly FrequencyTokenClassV1[];
}

function parseMeta(value: unknown): WorkspaceDocumentMetaV1 {
  if (value === null || typeof value !== 'object') throw new RangeError('document metadata must be exact');
  const keys = ['title', 'language', 'tags'];
  if (Object.prototype.hasOwnProperty.call(value, 'author')) keys.push('author');
  if (Object.prototype.hasOwnProperty.call(value, 'year')) keys.push('year');
  if (!exactRecord(value, keys)) throw new RangeError('document metadata must be exact');
  const title = boundedString(value.title, WORKSPACE_MAX_META_UNITS, 'document title');
  const language = boundedString(value.language, 128, 'document language');
  const tags = denseArray(value.tags, 64, 'document tags').map((tag, index) =>
    boundedString(tag, 128, `document tag ${index}`),
  );
  if (new Set(tags).size !== tags.length) throw new RangeError('document tags must be unique');
  const author = value.author === undefined
    ? undefined
    : boundedString(value.author, WORKSPACE_MAX_META_UNITS, 'document author');
  if (value.year !== undefined && (!Number.isSafeInteger(value.year) || typeof value.year !== 'number')) {
    throw new RangeError('document year must be a safe integer');
  }
  return {
    title,
    ...(author === undefined ? {} : { author }),
    ...(value.year === undefined ? {} : { year: value.year }),
    language,
    tags,
  };
}

function parseLibraryIdentity(value: unknown): string {
  const identity = boundedString(value, 72, 'library identity');
  const separator = identity.indexOf(':');
  if (
    separator < 1
    || !isSourceFormat(identity.slice(0, separator))
    || !SOURCE_HASH.test(identity.slice(separator + 1))
  ) {
    throw new RangeError('library identity must be format:source-hash');
  }
  return identity;
}

function parseWarm(value: unknown): WorkspaceWarmTextV1 {
  if (
    !exactRecord(value, ['textHash', 'textLengthUtf16'])
    || typeof value.textHash !== 'string'
    || !SOURCE_HASH.test(value.textHash)
    || !isNonNegSafeInt(value.textLengthUtf16)
    || value.textLengthUtf16 > INGEST_CAPS_V0.maxTextUtf16PerDoc
  ) {
    throw new RangeError('warm text hint is invalid');
  }
  return value as unknown as WorkspaceWarmTextV1;
}

function parseLibraryDocument(value: unknown): WorkspaceLibraryDocumentV1 {
  const hasWarm = exactRecord(value, ['doc', 'library', 'meta', 'warm']);
  if (!hasWarm && !exactRecord(value, ['doc', 'library', 'meta'])) {
    throw new RangeError('library document must be exact');
  }
  return {
    doc: boundedString(value.doc, WORKSPACE_MAX_ID_UNITS, 'document id'),
    library: parseLibraryIdentity(value.library),
    meta: parseMeta(value.meta),
    ...(hasWarm ? { warm: parseWarm(value.warm) } : {}),
  };
}

function parseCorpus(value: unknown): WorkspaceCorpusV1 {
  if (!exactRecord(value, ['kind', 'order', 'docs']) || value.kind !== 'library') {
    throw new RangeError('workspace corpus must be library-backed');
  }
  const order = uniqueStrings(value.order, INGEST_CAPS_V0.maxDocsPerProject, 'document order');
  const docs = denseArray(value.docs, INGEST_CAPS_V0.maxDocsPerProject, 'workspace documents')
    .map(parseLibraryDocument);
  const docIds = docs.map((doc) => doc.doc);
  if (
    new Set(docIds).size !== docIds.length
    || order.length !== docs.length
    || order.some((doc) => !docIds.includes(doc))
  ) {
    throw new RangeError('workspace document order and documents must name the same unique set');
  }
  return { kind: 'library', order, docs };
}

export function parseWorkspaceTrendView(value: unknown): WorkspaceTrendViewV1 {
  const current = exactRecord(value, ['mode', 'bins', 'measure']);
  const legacy = exactRecord(value, ['mode', 'focusedDoc', 'bins', 'measure']);
  if (!current && !legacy) {
    throw new RangeError('trend view must be exact');
  }
  if (
    value.mode !== 'series'
    && value.mode !== 'by-book'
    && value.mode !== 'by-book-scaled'
  ) throw new RangeError('trend mode is invalid');
  if (legacy && value.focusedDoc !== null) {
    boundedString(value.focusedDoc, WORKSPACE_MAX_ID_UNITS, 'focused document');
  }
  if (
    !exactRecord(value.bins, ['mode', 'count'])
    || !isNonNegSafeInt(value.bins.count)
    || (
      value.bins.mode === 'per-doc'
        ? value.bins.count < TREND_PER_DOC_MIN || value.bins.count > TREND_PER_DOC_MAX
        : value.bins.mode === 'fixed-tokens'
          ? value.bins.count < TREND_FIXED_TOKENS_MIN || value.bins.count > TREND_FIXED_TOKENS_MAX
          : true
    )
  ) {
    throw new RangeError('trend bins are invalid');
  }
  let measure: WorkspaceTrendMeasureV1;
  if (exactRecord(value.measure, ['kind']) && value.measure.kind === 'count') {
    measure = { kind: 'count' };
  } else if (
    exactRecord(value.measure, ['kind', 'denominator', 'smoothing', 'showRaw'])
    && value.measure.kind === 'rate'
    && TREND_RATE_DENOMINATORS.includes(value.measure.denominator as never)
    && (value.measure.smoothing === 0 || TREND_SMOOTHING_WINDOWS.includes(value.measure.smoothing as never))
    && typeof value.measure.showRaw === 'boolean'
  ) {
    measure = {
      kind: 'rate',
      denominator: TREND_RATE_DENOMINATOR,
      smoothing: value.measure.smoothing as 0 | TrendSmoothingWindow,
      showRaw: value.measure.showRaw,
    };
  } else {
    throw new RangeError('trend measure is invalid');
  }
  return { mode: value.mode, bins: value.bins as unknown as TrendBinsSpecV1, measure };
}

function parseFrequencyView(value: unknown): WorkspaceFrequencyViewV1 {
  const hasStoplist = value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'stoplistTopN');
  const stoplistKey = hasStoplist ? ['stoplistTopN'] as const : [];
  const hasPrefix = exactRecord(
    value,
    ['minCount', 'minDocFreq', 'classes', 'prefixNfc', ...stoplistKey, 'sort', 'pageSize'],
  );
  const hasRegex = exactRecord(
    value,
    ['minCount', 'minDocFreq', 'classes', 'regex', ...stoplistKey, 'sort', 'pageSize'],
  );
  const hasFilter = exactRecord(
    value,
    ['minCount', 'minDocFreq', 'classes', 'filter', ...stoplistKey, 'sort', 'pageSize'],
  );
  if (
    !hasPrefix
    && !hasRegex
    && !hasFilter
    && !exactRecord(
      value,
      ['minCount', 'minDocFreq', 'classes', ...stoplistKey, 'sort', 'pageSize'],
    )
  ) {
    throw new RangeError('frequency view must be exact');
  }
  if (
    !isNonNegSafeInt(value.minCount) || value.minCount < 1
    || !isNonNegSafeInt(value.minDocFreq) || value.minDocFreq < 1
    || (hasStoplist && (
      !isNonNegSafeInt(value.stoplistTopN)
      || value.stoplistTopN > STOPLIST_MAX_TOP_N
    ))
    || !exactRecord(value.sort, ['by', 'dir'])
    || !['count', 'docFreq', 'dp', 'dpNorm', 'ratePer10k', 'class', 'key']
      .includes(value.sort.by as string)
    || (value.sort.dir !== 1 && value.sort.dir !== -1)
    || !isNonNegSafeInt(value.pageSize) || value.pageSize < 1 || value.pageSize > FREQUENCY_PAGE_MAX
  ) {
    throw new RangeError('frequency view is invalid');
  }
  const prefixNfc = hasPrefix
    ? boundedString(value.prefixNfc, 64, 'frequency prefix', true)
    : undefined;
  if (prefixNfc !== undefined && prefixNfc !== prefixNfc.normalize('NFC')) {
    throw new RangeError('frequency prefix must be NFC');
  }
  const regex = hasRegex
    ? boundedString(value.regex, FREQUENCY_FILTER_MAX_UNITS, 'frequency regex')
    : undefined;
  if (regex !== undefined) {
    if (regex !== regex.normalize('NFC')) {
      throw new RangeError('frequency regex must be NFC');
    }
    try {
      new RegExp(regex, 'u');
    } catch {
      throw new RangeError('frequency regex must be valid');
    }
  }
  let filter: FrequencyTextFilterV1 | undefined;
  if (hasFilter) {
    if (
      !exactRecord(value.filter, ['mode', 'query'])
      || (value.filter.mode !== 'literal' && value.filter.mode !== 'regex')
    ) {
      throw new RangeError('frequency text filter must be exact');
    }
    const query = boundedString(
      value.filter.query,
      FREQUENCY_FILTER_MAX_UNITS,
      'frequency text filter',
    );
    if (query !== query.normalize('NFC')) {
      throw new RangeError('frequency text filter must be NFC');
    }
    // Literal text has no compilation step; metacharacters remain ordinary text.
    if (value.filter.mode === 'regex') {
      try {
        new RegExp(query, 'u');
      } catch {
        throw new RangeError('frequency regex must be valid');
      }
    }
    filter = { mode: value.filter.mode, query };
  }
  return {
    minCount: value.minCount,
    minDocFreq: value.minDocFreq,
    classes: parseClasses(value.classes, 'frequency classes'),
    stoplistTopN: hasStoplist ? value.stoplistTopN as number : 0,
    ...(filter === undefined ? {} : { filter }),
    ...(prefixNfc === undefined ? {} : { prefixNfc }),
    ...(regex === undefined ? {} : { regex }),
    sort: value.sort as unknown as WorkspaceFrequencyViewV1['sort'],
    pageSize: value.pageSize,
  };
}

function nullableDocument(value: unknown, what: string): string | null {
  return value === null ? null : boundedString(value, WORKSPACE_MAX_ID_UNITS, what);
}

function parseCompareView(value: unknown): WorkspaceCompareViewV1 {
  const hasStoplist = value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'stoplistTopN');
  const stoplistKey = hasStoplist ? ['stoplistTopN'] as const : [];
  const currentKeys = [
    'mode', 'documentA', 'documentB', 'restOn', 'minCountTotal',
    'minDocFreqTotal', 'classes', ...stoplistKey, 'sort',
    'showConfidenceIntervals', 'pageSize',
  ] as const;
  const legacyKeys = [
    'mode', 'documentA', 'documentB', 'restOn', 'minCountTotal',
    'minDocFreqTotal', 'classes', ...stoplistKey, 'sort', 'pageSize',
  ] as const;
  const current = exactRecord(value, currentKeys);
  if (!current && !exactRecord(value, legacyKeys)) {
    throw new RangeError('compare view must be exact');
  }
  const showConfidenceIntervals = current
    ? value.showConfidenceIntervals
    : true;
  if (
    (
      value.mode !== 'documents'
      && value.mode !== 'document-rest'
      && value.mode !== 'selection-rest'
    )
    || (value.restOn !== 'a' && value.restOn !== 'b')
    || !isNonNegSafeInt(value.minCountTotal) || value.minCountTotal < 1
    || !isNonNegSafeInt(value.minDocFreqTotal) || value.minDocFreqTotal < 1
    || (hasStoplist && (
      !isNonNegSafeInt(value.stoplistTopN)
      || value.stoplistTopN > STOPLIST_MAX_TOP_N
    ))
    || !exactRecord(value.sort, ['by', 'dirA', 'dirB'])
    || !['logRatio', 'logRatioLow', 'g2', 'countA', 'countB']
      .includes(value.sort.by as string)
    || (value.sort.dirA !== 1 && value.sort.dirA !== -1)
    || (value.sort.dirB !== 1 && value.sort.dirB !== -1)
    || typeof showConfidenceIntervals !== 'boolean'
    || !isNonNegSafeInt(value.pageSize) || value.pageSize < 1 || value.pageSize > FREQUENCY_PAGE_MAX
  ) {
    throw new RangeError('compare view is invalid');
  }
  return {
    mode: value.mode,
    documentA: nullableDocument(value.documentA, 'compare document A'),
    documentB: nullableDocument(value.documentB, 'compare document B'),
    restOn: value.restOn,
    minCountTotal: value.minCountTotal,
    minDocFreqTotal: value.minDocFreqTotal,
    classes: parseClasses(value.classes, 'compare classes'),
    stoplistTopN: hasStoplist ? value.stoplistTopN as number : 0,
    sort: value.sort as unknown as WorkspaceCompareViewV1['sort'],
    showConfidenceIntervals,
    pageSize: value.pageSize,
  };
}

export function parseWorkspace(value: unknown): WorkspaceV1 {
  if (!exactRecord(value, ['schema', 'corpus', 'notebook', 'active', 'kwicEnabled', 'views'])) {
    throw new RangeError('workspace must be an exact v1 record');
  }
  if (value.schema !== WORKSPACE_SCHEMA) throw new RangeError('unknown workspace schema');
  if (!exactRecord(value.views, ['trend', 'frequency', 'compare'])) {
    throw new RangeError('workspace views must be exact');
  }
  const notebook = parseQueryNotebook(value.notebook);
  const upgradingLegacyNotebook = exactRecord(value.notebook, ['schema', 'groups'])
    && value.notebook.schema === 'texttrends/query-notebook/1';
  const admittedGroups = new Set(notebook.groups.map((group) => group.id));
  let active = uniqueStrings(value.active, MAX_KWIC_TRACKS, 'active groups');
  let kwicEnabled = uniqueStrings(value.kwicEnabled, NOTEBOOK_LIMITS_V1.maxGroups, 'KWIC-enabled groups');
  if (upgradingLegacyNotebook) {
    active = active.filter((id) => admittedGroups.has(id));
    kwicEnabled = kwicEnabled.filter((id) => admittedGroups.has(id));
  }
  if (active.some((id) => !admittedGroups.has(id)) || kwicEnabled.some((id) => !admittedGroups.has(id))) {
    throw new RangeError('workspace group selections must refer to notebook groups');
  }
  return {
    schema: WORKSPACE_SCHEMA,
    corpus: parseCorpus(value.corpus),
    notebook,
    active,
    kwicEnabled,
    views: {
      trend: parseWorkspaceTrendView(value.views.trend),
      frequency: parseFrequencyView(value.views.frequency),
      compare: parseCompareView(value.views.compare),
    },
  };
}

/** Remove Compare document selections that are not available in the opened corpus. */
export function reconcileWorkspaceDocuments(
  workspace: WorkspaceV1,
  availableDocuments: ReadonlySet<string>,
): WorkspaceV1 {
  const documentA = workspace.views.compare.documentA;
  const documentB = workspace.views.compare.documentB;
  return {
    ...workspace,
    views: {
      ...workspace.views,
      compare: {
        ...workspace.views.compare,
        documentA: documentA !== null && availableDocuments.has(documentA) ? documentA : null,
        documentB: documentB !== null && availableDocuments.has(documentB) ? documentB : null,
      },
    },
  };
}
