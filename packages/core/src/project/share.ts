import { exactArray, exactRecord, isNonNegSafeInt } from '../contract/guards.ts';
import { MAX_KWIC_TRACKS } from '../ops/kwic.ts';
import {
  NOTEBOOK_LIMITS_V1,
  parseQueryNotebook,
  type QueryNotebookV1,
} from './notebook.ts';
import {
  parseCharAnchor,
  parseInventoryResearchView,
  parseKeynessResearchView,
  parseTrendResearchView,
  type CharAnchorV1,
  type InventoryViewV1,
  type KeynessViewV1,
  type TrendResearchViewV2,
} from './research-state.ts';

export const SHARE_MAX_DOCUMENTS = 64;
export const SHARE_MAX_ANCHORS = 64;
export const SHARE_MAX_TITLE_UNITS = 256;

export interface ShareDocumentV1 {
  readonly d: string;
  readonly h: string;
  readonly t?: string;
}

export interface ShareLinkV1 {
  readonly s: 1;
  readonly n: QueryNotebookV1;
  readonly a: readonly number[];
  readonly k: readonly number[];
  readonly v: {
    readonly t?: TrendResearchViewV2;
    readonly i?: InventoryViewV1;
    readonly y?: KeynessViewV1;
  };
  readonly x: readonly ShareDocumentV1[];
  readonly r?: readonly CharAnchorV1[];
}

function dense(value: unknown, max: number, what: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new RangeError(`${what} exceeds its ${max}-item cap`);
  }
  if (!exactArray(value, value.length)) {
    throw new RangeError(`${what} must be a dense plain array`);
  }
  return value;
}

function indices(
  value: unknown,
  max: number,
  notebookSize: number,
  what: string,
): readonly number[] {
  const rows = dense(value, max, what);
  const seen = new Set<number>();
  return rows.map((item) => {
    if (!isNonNegSafeInt(item) || item >= notebookSize || seen.has(item)) {
      throw new RangeError(`${what} must contain unique notebook indices`);
    }
    seen.add(item);
    return item;
  });
}

function documents(value: unknown): readonly ShareDocumentV1[] {
  const rows = dense(value, SHARE_MAX_DOCUMENTS, 'share documents');
  const ids = new Set<string>();
  return rows.map((item, index) => {
    const titled = exactRecord(item, ['d', 'h', 't']);
    if (!titled && !exactRecord(item, ['d', 'h'])) {
      throw new RangeError(`share document ${index} must be exact`);
    }
    if (
      typeof item.d !== 'string' ||
      item.d.length < 1 ||
      item.d.length > 256 ||
      ids.has(item.d) ||
      typeof item.h !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.h)
    ) {
      throw new RangeError(`share document ${index} has invalid identity`);
    }
    if (
      titled &&
      (
        typeof item.t !== 'string' ||
        item.t.length > SHARE_MAX_TITLE_UNITS ||
        item.t !== item.t.normalize('NFC')
      )
    ) {
      throw new RangeError(`share document ${index} has an invalid title hint`);
    }
    ids.add(item.d);
    return item as unknown as ShareDocumentV1;
  });
}

function views(value: unknown): ShareLinkV1['v'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('share views must be a plain record');
  }
  const keys = Object.keys(value);
  if (
    !exactRecord(value, keys) ||
    keys.some((key) => key !== 't' && key !== 'i' && key !== 'y') ||
    keys.length > 3
  ) {
    throw new RangeError('share views must contain only t/i/y');
  }
  const record = value as Record<string, unknown>;
  return {
    ...(Object.hasOwn(record, 't') ? { t: parseTrendResearchView(record.t) } : {}),
    ...(Object.hasOwn(record, 'i') ? { i: parseInventoryResearchView(record.i) } : {}),
    ...(Object.hasOwn(record, 'y') ? { y: parseKeynessResearchView(record.y) } : {}),
  };
}

export function parseShareLink(value: unknown): ShareLinkV1 {
  const hasAnchors = exactRecord(value, ['s', 'n', 'a', 'k', 'v', 'x', 'r']);
  if (!hasAnchors && !exactRecord(value, ['s', 'n', 'a', 'k', 'v', 'x'])) {
    throw new RangeError('share link must be an exact v1 record');
  }
  if (value.s !== 1) throw new RangeError('unknown share-link schema');
  const notebook = parseQueryNotebook(value.n);
  const docs = documents(value.x);
  const docIds = new Set(docs.map((doc) => doc.d));
  let anchors: readonly CharAnchorV1[] | undefined;
  if (hasAnchors) {
    anchors = dense(value.r, SHARE_MAX_ANCHORS, 'share anchors').map(
      (item, index) => {
        const anchor = parseCharAnchor(item, `share anchor ${index}`);
        if (!docIds.has(anchor.doc)) {
          throw new RangeError(`share anchor ${index} names an unknown sender document`);
        }
        return anchor;
      },
    );
  }
  return {
    s: 1,
    n: notebook,
    a: indices(value.a, MAX_KWIC_TRACKS, notebook.groups.length, 'share active groups'),
    k: indices(value.k, NOTEBOOK_LIMITS_V1.maxGroups, notebook.groups.length, 'share KWIC groups'),
    v: views(value.v),
    x: docs,
    ...(anchors === undefined ? {} : { r: anchors }),
  };
}
