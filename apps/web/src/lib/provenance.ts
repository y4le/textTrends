import type {
  FrequencyListResultV1,
  InventoryResultV1,
  KeynessResultV1,
  NumericTrend,
  WorkspaceTrendMeasureV1,
} from '@texttrends/core';
import type {
  FrequencyViewV1,
  KeynessViewV1,
} from './store.ts';
import type { Place } from './places.ts';
import { selectionTokenCount, type TokenRangeSelectionV1 } from './selection.ts';

export const PROVENANCE_SCHEMA = 'texttrends/provenance/1' as const;

export interface ProvenanceMethod {
  readonly method: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly limitations: readonly string[];
}

export interface ProvenanceV1 {
  readonly schema: typeof PROVENANCE_SCHEMA;
  readonly place: Place;
  readonly content: {
    readonly snapshot: string | null;
    readonly selection: string;
    readonly readyDocuments: readonly string[];
    readonly missingDocuments: readonly string[];
  };
  readonly methods: readonly ProvenanceMethod[];
  readonly completeness: {
    readonly status: 'waiting' | 'complete' | 'partial';
    readonly statement: string;
  };
}

export interface ProvenanceTrend {
  readonly label: string;
  readonly result: NumericTrend;
}

export interface ProvenanceInput {
  /** Stable wire document id → reader-facing title. Unknown ids fall back to
   * themselves so partial/corrupt results remain diagnosable. */
  readonly documentTitles: ReadonlyMap<string, string>;
  readonly snapshot: {
    readonly snapshot: string;
    readonly readyDocs: readonly string[];
    readonly missingDocs: readonly string[];
  } | null;
  readonly linkedSelection: TokenRangeSelectionV1 | null;
  readonly inventory: InventoryResultV1 | null;
  readonly trends: readonly ProvenanceTrend[];
  readonly trendMeasure: WorkspaceTrendMeasureV1;
  readonly concordance: {
    readonly resident: boolean;
    readonly enabledTracks: number;
    readonly total: number | null;
  };
  readonly frequency: {
    readonly view: FrequencyViewV1;
    readonly result: FrequencyListResultV1 | null;
  };
  readonly keyness: {
    readonly view: KeynessViewV1;
    readonly sideA: readonly string[];
    readonly sideB: readonly string[];
    readonly resultA: KeynessResultV1 | null;
    readonly resultB: KeynessResultV1 | null;
  };
}

export interface ResultTable {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
}

const list = (values: readonly string[]): string => values.length === 0
  ? 'none'
  : values.join(', ');

function documentTitle(input: ProvenanceInput, doc: string): string {
  return input.documentTitles.get(doc) ?? doc;
}

function documentTitles(input: ProvenanceInput, docs: readonly string[]): string[] {
  return docs.map((doc) => documentTitle(input, doc));
}

function selectionText(input: ProvenanceInput): string {
  const selection = input.linkedSelection;
  if (selection === null) return 'all ready documents';
  if (selection.ranges.length === 1) {
    const range = selection.ranges[0]!;
    return `${documentTitle(input, range.doc)} tokens ${range.tokens.start + 1}–${range.tokens.end} (1-based inclusive)`;
  }
  const first = selection.ranges[0]!;
  const last = selection.ranges.at(-1)!;
  return `${documentTitle(input, first.doc)} token ${first.tokens.start + 1} through ${documentTitle(input, last.doc)} token ${last.tokens.end} (${selectionTokenCount(selection)} tokens across ${selection.ranges.length} documents)`;
}

function completeness(
  input: ProvenanceInput,
  resident: boolean,
): ProvenanceV1['completeness'] {
  if (!resident || input.snapshot === null) {
    return {
      status: 'waiting',
      statement: 'No matching resident result is available yet.',
    };
  }
  const missing = new Set([
    ...input.snapshot.missingDocs,
    ...(input.inventory?.missingDocs ?? []),
  ]);
  if (missing.size > 0) {
    return {
      status: 'partial',
      statement: `${missing.size} declared ${missing.size === 1 ? 'document is' : 'documents are'} unavailable: ${list(documentTitles(input, [...missing]))}.`,
    };
  }
  if (input.linkedSelection !== null) {
    return {
      status: 'complete',
      statement: input.linkedSelection.ranges.length === 1
        ? `The selected range in ${documentTitle(input, input.linkedSelection.ranges[0]!.doc)} is represented.`
        : `The selected range across ${input.linkedSelection.ranges.length} documents is represented.`,
    };
  }
  return {
    status: 'complete',
    statement: `All ${input.snapshot.readyDocs.length} ready ${input.snapshot.readyDocs.length === 1 ? 'document is' : 'documents are'} represented.`,
  };
}

const parameter = (name: string, value: string) => ({ name, value });

function inventoryMethod(result: InventoryResultV1): ProvenanceMethod {
  return {
    method: result.method,
    parameters: [
      parameter('MATTR window', String(result.mattrWindow)),
      parameter('growth points', String(result.growth?.tokens.length ?? 0)),
      parameter('selected documents', String(result.totals.selectedDocs)),
      parameter('selected tokens', String(result.totals.tokens)),
      parameter('token classes', 'lexical and numeral totals reported separately'),
    ],
    limitations: [
      'TTR is descriptive and length-dependent.',
      'MATTR becomes plain TTR for a contiguous run shorter than its window.',
    ],
  };
}

function trendMethod(input: ProvenanceInput): ProvenanceMethod {
  const first = input.trends[0]!.result;
  const bins = first.bins.mode === 'per-doc'
    ? `${first.bins.count} equal bins per document`
    : `${first.bins.count.toLocaleString()} tokens per bin`;
  const presentation = input.trendMeasure.kind === 'count'
    ? 'count per bin (unsmoothed)'
    : 'rate';
  const smoothing = input.trendMeasure.kind === 'count'
    ? 'disabled for counts'
    : input.trendMeasure.smoothing === 0
      ? 'none'
      : `${input.trendMeasure.smoothing}-bin centered token-weighted mean${input.trendMeasure.showRaw ? '; raw line shown behind' : ''}`;
  return {
    method: 'trend',
    parameters: [
      parameter('result · bin policy', bins),
      parameter('result · kernel rate', 'rate per 10,000 selected tokens'),
      parameter('result · coordinate', first.coordinate),
      parameter('presentation · measure', presentation),
      parameter('presentation · smoothing', smoothing),
      parameter('resident series', input.trends.map((trend) => trend.label).join(', ')),
    ],
    limitations: [
      'Bins with no selected-token denominator are gaps, not zero observations.',
      ...(input.trendMeasure.kind === 'rate' && input.trendMeasure.smoothing !== 0
        ? ['Where a document edge or adjacent gap supplies too few contributing bins, the plotted point retains its exact unsmoothed value.']
        : []),
      'Rates describe the selected corpus; they are not uncertainty estimates.',
    ],
  };
}

function concordanceMethod(input: ProvenanceInput): ProvenanceMethod {
  return {
    method: 'concordance-window/1',
    parameters: [
      parameter('enabled tracks', String(input.concordance.enabledTracks)),
      parameter('resident occurrences', input.concordance.total === null
        ? 'not available'
        : String(input.concordance.total)),
      parameter('ordering', 'continuous full-corpus reading order'),
      parameter('token classes', 'the active notebook groups’ authored match recipes'),
    ],
    limitations: [
      'The resident window is bounded; its total reports the complete match count.',
      'Context is a reading aid and does not replace the source text.',
    ],
  };
}

function frequencyMethod(input: ProvenanceInput): ProvenanceMethod {
  const { view, result } = input.frequency;
  return {
    method: result?.method ?? 'freq-list/1',
    parameters: [
      parameter('minimum count', String(view.minCount)),
      parameter('minimum document frequency', String(view.minDocFreq)),
      parameter('token classes', view.classes.join(', ')),
      parameter('prefix', view.prefixNfc ?? 'none'),
      parameter('sort', `${view.sort.by} ${view.sort.dir === 1 ? 'ascending' : 'descending'}`),
      parameter(
        'resident page',
        result === null || result.rows.length === 0
          ? 'no rows'
          : `${view.page.offset + 1}–${view.page.offset + result.rows.length}`,
      ),
      parameter('denominator', 'rate per 10,000 selected class tokens'),
    ],
    limitations: [
      'DP treats selected documents as its parts.',
      'The ranked result window is bounded to 5,000 rows.',
    ],
  };
}

function keynessMethod(input: ProvenanceInput): ProvenanceMethod {
  const { view, sideA, sideB, resultA, resultB } = input.keyness;
  return {
    method: resultA?.method ?? resultB?.method ?? 'keyness-g2-2x2/1',
    parameters: [
      parameter('effect', resultA?.effect ?? resultB?.effect ?? 'log-ratio-halves/1'),
      parameter('side A', list(documentTitles(input, sideA))),
      parameter('side B', list(documentTitles(input, sideB))),
      parameter('minimum combined count', String(view.minCountTotal)),
      parameter('minimum combined document range', String(view.minDocFreqTotal)),
      parameter('token classes', view.classes.join(', ')),
      parameter('shared sort field', view.sort.by),
      parameter('A direction', view.sort.dirA === 1 ? 'ascending' : 'descending'),
      parameter('B direction', view.sort.dirB === 1 ? 'ascending' : 'descending'),
      parameter('page size', String(view.pageLimit)),
    ],
    limitations: [
      'Log ratio uses a 0.5 four-cell correction.',
      'No confidence intervals are calculated; small sides can yield unstable ranks.',
      'Terms with exactly zero log ratio are in neither ranked projection.',
      'Display bars use a page-local scale over the ready current pages.',
      'A linked Trends range does not redefine either comparison side.',
    ],
  };
}

export function provenanceFor(input: ProvenanceInput, place: Place): ProvenanceV1 {
  let methods: readonly ProvenanceMethod[] = [];
  let resident = false;

  if (place === 'inputs' && input.inventory) {
    methods = [inventoryMethod(input.inventory)];
    resident = true;
  } else if (place === 'trends' && input.trends.length > 0) {
    methods = [trendMethod(input)];
    resident = true;
  } else if (place === 'concordance' && input.concordance.resident) {
    methods = [concordanceMethod(input)];
    resident = true;
  } else if (place === 'vocabulary' && input.frequency.result) {
    methods = [
      ...(input.inventory ? [inventoryMethod(input.inventory)] : []),
      frequencyMethod(input),
    ];
    resident = true;
  } else if (
    place === 'compare'
    && (input.keyness.resultA !== null || input.keyness.resultB !== null)
  ) {
    methods = [keynessMethod(input)];
    resident = true;
  }

  return {
    schema: PROVENANCE_SCHEMA,
    place,
    content: {
      snapshot: input.snapshot?.snapshot ?? null,
      selection: selectionText(input),
      readyDocuments: documentTitles(input, input.snapshot?.readyDocs ?? []),
      missingDocuments: documentTitles(input, input.snapshot?.missingDocs ?? []),
    },
    methods,
    completeness: completeness(input, resident),
  };
}

export function formatProvenanceText(provenance: ProvenanceV1): string {
  const lines = [
    `textTrends provenance (${provenance.schema})`,
    `Place: ${provenance.place}`,
    `Snapshot: ${provenance.content.snapshot ?? 'not ready'}`,
    `Selection: ${provenance.content.selection}`,
    `Ready documents: ${list(provenance.content.readyDocuments)}`,
    `Missing documents: ${list(provenance.content.missingDocuments)}`,
    `Completeness: ${provenance.completeness.status} — ${provenance.completeness.statement}`,
  ];
  for (const method of provenance.methods) {
    lines.push('', `Method: ${method.method}`);
    for (const item of method.parameters) lines.push(`${item.name}: ${item.value}`);
    for (const limitation of method.limitations) lines.push(`Limitation: ${limitation}`);
  }
  if (provenance.methods.length === 0) {
    lines.push('', 'Method: waiting for a matching resident result');
  }
  return `${lines.join('\n')}\n`;
}

function tsvCell(value: string | number | null): string {
  if (value === null) return '';
  return String(value).replaceAll('\t', ' ').replaceAll(/\r?\n/g, ' ');
}

export function formatResultTsv(
  table: ResultTable,
  provenance: ProvenanceV1,
): string {
  const provenanceLines = formatProvenanceText(provenance)
    .trimEnd()
    .split('\n')
    .map((line) => `# ${line}`);
  return [
    `# Result: ${table.title}`,
    ...provenanceLines,
    table.columns.map(tsvCell).join('\t'),
    ...table.rows.map((row) => row.map(tsvCell).join('\t')),
    '',
  ].join('\n');
}

export function resultTableFor(
  input: ProvenanceInput,
  place: Place,
): ResultTable | null {
  if (place === 'trends' && input.trends.length > 0) {
    const rows: (readonly (string | number | null)[])[] = [];
    for (const trend of input.trends) {
      for (let index = 0; index < trend.result.count.length; index += 1) {
        const docId = trend.result.order[trend.result.docOrdinal[index] as number] ?? '';
        rows.push([
          trend.label,
          documentTitle(input, docId),
          (trend.result.binIndex[index] as number) + 1,
          trend.result.binStartToken[index] as number,
          trend.result.binTokens[index] as number,
          trend.result.count[index] as number,
          Number.isFinite(trend.result.ratePer10k[index])
            ? trend.result.ratePer10k[index] as number
            : null,
        ]);
      }
    }
    return {
      title: 'Trends',
      columns: [
        'series',
        'document',
        'bin',
        'bin_start_token_0_based',
        'selected_tokens',
        'count',
        'rate_per_10k',
      ],
      rows,
    };
  }
  if (place === 'vocabulary' && input.frequency.result) {
    return {
      title: 'Vocabulary',
      columns: ['term', 'class', 'count', 'rate_per_10k', 'document_frequency', 'DP', 'DPnorm'],
      rows: input.frequency.result.rows.map((row) => [
        row.key,
        row.class,
        row.count,
        row.ratePer10k,
        row.docFreq,
        row.dp,
        row.dpNorm,
      ]),
    };
  }
  if (place === 'compare') {
    const resultA = input.keyness.resultA;
    const resultB = input.keyness.resultB;
    if (resultA || resultB) {
      return {
        title: 'Compare',
        columns: [
          'ranking_side',
          'rank',
          'term',
          'class',
          'count_A',
          'count_B',
          'rate_A_per_10k',
          'rate_B_per_10k',
          'log_ratio',
          'signed_G2',
          'range_A',
          'range_B',
        ],
        rows: [
          ...(resultA?.rows ?? []).map((row, index) => [
            'A',
            index + 1,
            row.key,
            row.class,
            row.countA,
            row.countB,
            row.rateAper10k,
            row.rateBper10k,
            row.logRatio,
            row.g2,
            row.rangeA,
            row.rangeB,
          ] as const),
          ...(resultB?.rows ?? []).map((row, index) => [
            'B',
            index + 1,
            row.key,
            row.class,
            row.countA,
            row.countB,
            row.rateAper10k,
            row.rateBper10k,
            row.logRatio,
            row.g2,
            row.rangeA,
            row.rangeB,
          ] as const),
        ],
      };
    }
  }
  return null;
}
