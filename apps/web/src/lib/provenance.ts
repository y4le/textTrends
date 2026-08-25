import type {
  CompanyResultV1,
  DestinationsResultV1,
  FrequencyListResultV1,
  InventoryResultV1,
  KeynessResultV1,
  NumericTrend,
  WorkspaceTrendMeasureV1,
} from '@texttrends/core';
import type {
  FrequencyViewV2,
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
  readonly overview: {
    readonly company: CompanyResultV1 | null;
    readonly destinations: DestinationsResultV1 | null;
  };
  readonly trendMeasure: WorkspaceTrendMeasureV1;
  readonly frequency: {
    readonly view: FrequencyViewV2;
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
      ...(input.linkedSelection === null ? [] : [
        parameter('range comparison', 'selected trend sums vs baseline remainder'),
        parameter('range direction', 'rate-contrast/1 over observed rates'),
        parameter('range direction weight', 'solid when both pooled expected counts are at least 5'),
      ]),
    ],
    limitations: [
      'Bins with no selected-token denominator are gaps, not zero observations.',
      ...(input.trendMeasure.kind === 'rate' && input.trendMeasure.smoothing !== 0
        ? ['Where a document edge or adjacent gap supplies too few contributing bins, the plotted point retains its exact unsmoothed value.']
        : []),
      'Rates describe the selected corpus; they are not uncertainty estimates.',
      ...(input.linkedSelection === null ? [] : [
        'A multi-token match crossing a range boundary is assigned outside because ranged matches must be fully contained.',
      ]),
    ],
  };
}

function companyMethod(result: CompanyResultV1): ProvenanceMethod {
  return {
    method: result.method,
    parameters: [
      parameter('scope', 'all ready documents; linked ranges do not apply'),
      parameter('tracks', result.tracks.map((track) => track.seriesId).join(', ')),
      parameter('distance', 'nearest span-to-span interval gap within each document'),
      parameter('gap bucket edges', result.gapEdges.join(', ')),
      parameter('displayed nearby threshold', 'gap below 25 indexed tokens'),
      parameter('directionality', 'each track uses its own occurrences as denominator'),
    ],
    limitations: [
      'Company reports exact directional proximity evidence, not association, significance, or causation.',
      'Occurrences in a document with no peer are reported separately from the distance histogram.',
      'Bucket zero includes touching spans; proper overlaps are also reported separately.',
    ],
  };
}

function destinationsMethod(result: DestinationsResultV1): ProvenanceMethod {
  const focus = result.focus === null
    ? 'none'
    : [result.focus.a, result.focus.b]
        .map((ordinal) => result.tracks[ordinal]?.seriesId ?? `track ${ordinal + 1}`)
        .join(' + ');
  return {
    method: result.method,
    parameters: [
      parameter('scope', 'all ready documents; linked ranges do not apply'),
      parameter('window', `up to ${result.windowTokens.toLocaleString()} indexed tokens`),
      parameter('tracks', result.tracks.map((track) => track.seriesId).join(', ')),
      parameter('strict pair focus', focus),
      parameter('resident destinations', String(result.destinations.length)),
      parameter('reader anchor', 'exact winning occurrence'),
    ],
    limitations: [
      'The score is a deterministic reading heuristic, not document structure or passage importance.',
      'The ordered list is selected greedily with bounded per-document candidates; it is not a set-level optimum.',
      'Displayed excerpts are shorter than the ranked window and retain a bounded number of highlights.',
    ],
  };
}

function frequencyMethod(input: ProvenanceInput): ProvenanceMethod {
  const { view, result } = input.frequency;
  const commonWords = result?.stoplist;
  return {
    method: result?.method ?? 'freq-list/2',
    parameters: [
      parameter('minimum count', String(view.minCount)),
      parameter('minimum document frequency', String(view.minDocFreq)),
      parameter('token classes', view.classes.join(', ')),
      parameter('text filter mode', view.filter?.mode ?? 'none'),
      parameter('text filter query', view.filter?.query ?? 'none'),
      parameter(
        'common-word filter',
        view.stoplistTopN === 0
          ? 'off'
          : commonWords
            ? `top ${commonWords.topN} of ${commonWords.id} v${commonWords.version} (through “${commonWords.boundaryKey}”); ${commonWords.removedRows} rows removed`
            : `top ${view.stoplistTopN} reference words`,
      ),
      parameter('sort', `${view.sort.by} ${view.sort.dir === 1 ? 'ascending' : 'descending'}`),
      parameter(
        'resident page',
        result === null || result.rows.length === 0
          ? 'no rows'
          : `${view.page.offset + 1}–${view.page.offset + result.rows.length}`,
      ),
      parameter(
        'denominator',
        'rate per 10,000 selected class tokens in letter/number terms',
      ),
    ],
    limitations: [
      'DP treats selected documents as its parts.',
      'Vocabulary excludes keys without Unicode letters or numbers from rows and its rate and dispersion denominator.',
      'The common-word filter removes ranked rows only; counts, rates, and denominators are unchanged.',
      'The ranked result window is bounded to 5,000 rows.',
    ],
  };
}

function keynessMethod(input: ProvenanceInput): ProvenanceMethod {
  const { view, sideA, sideB, resultA, resultB } = input.keyness;
  const divergence = resultA?.divergence ?? resultB?.divergence ?? null;
  const commonWords = resultA?.stoplist ?? resultB?.stoplist;
  const removedRows = [
    ...(resultA?.stoplist === undefined
      ? []
      : [`A ${resultA.stoplist.removedRows}`]),
    ...(resultB?.stoplist === undefined
      ? []
      : [`B ${resultB.stoplist.removedRows}`]),
  ];
  return {
    method: resultA?.method ?? resultB?.method ?? 'keyness-g2-2x2/1',
    parameters: [
      parameter('effect', resultA?.effect ?? resultB?.effect ?? 'log-ratio-halves/1'),
      parameter('side A', list(documentTitles(input, sideA))),
      parameter('side B', list(documentTitles(input, sideB))),
      parameter('minimum combined count', String(view.minCountTotal)),
      parameter('minimum combined document range', String(view.minDocFreqTotal)),
      parameter('token classes', view.classes.join(', ')),
      parameter(
        'common-word filter',
        view.stoplistTopN === 0
          ? 'off'
          : commonWords
            ? `top ${commonWords.topN} of ${commonWords.id} v${commonWords.version} (through “${commonWords.boundaryKey}”); removed rows by projection: ${removedRows.join(', ')}`
            : `top ${view.stoplistTopN} reference words`,
      ),
      parameter('shared sort field', view.sort.by),
      parameter('A direction', view.sort.dirA === 1 ? 'ascending' : 'descending'),
      parameter('B direction', view.sort.dirB === 1 ? 'ascending' : 'descending'),
      parameter(
        'ranking interval whiskers',
        view.showConfidenceIntervals ? 'shown' : 'hidden',
      ),
      parameter('fetch chunk size', String(view.pageLimit)),
      parameter('interval', '95% Wald on log ratio, same 0.5 four-cell correction'),
      ...(divergence
        ? [
            parameter('divergence', divergence.method),
            parameter('divergence types', String(divergence.types)),
          ]
        : []),
      parameter('dispersion', 'dispersion-dp/1 over each side’s documents'),
    ],
    limitations: [
      'Log ratio uses a 0.5 four-cell correction.',
      'Confidence intervals are per-term and carry no multiple-comparison correction.',
      'Dispersion is null for a side holding fewer than two documents with tokens.',
      'Divergence covers the selected token classes only, before the count filter.',
      'The common-word filter removes ranked rows only; statistics and divergence are unchanged.',
      'Terms with exactly zero log ratio are in neither ranked projection.',
      'Display bars use a shared scale over the currently loaded ranks.',
      ...(view.showConfidenceIntervals
        ? ['Interval whiskers clamp at the axis edge when a bound exceeds that scale.']
        : ['Ranking interval whiskers are hidden; exact intervals remain in term detail.']),
      'The Wald interval assumes independent token draws; running-text burstiness can make it too narrow.',
      'A linked Trends range does not redefine either comparison side.',
    ],
  };
}

export function provenanceFor(input: ProvenanceInput, place: Place): ProvenanceV1 {
  let methods: readonly ProvenanceMethod[] = [];
  let resident = false;

  if (place === 'trends' && input.trends.length > 0) {
    methods = [
      trendMethod(input),
      ...(input.linkedSelection === null && input.overview.company !== null
        ? [companyMethod(input.overview.company)]
        : []),
      ...(input.linkedSelection === null && input.overview.destinations !== null
        ? [destinationsMethod(input.overview.destinations)]
        : []),
    ];
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
          docId,
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
        'document_id',
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
