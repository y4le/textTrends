/**
 * Durable authored Terms notebook. Users own aliases, one uniform matching
 * mode, and presentation style; worker-facing members are derived by the
 * versioned alias compiler and never persisted.
 */

import { exactArray, exactRecord } from '../contract/guards.ts';
import {
  TERM_GROUP_LIMITS_V1,
  termGroupIdentity,
  validateGroup,
  type GroupMember,
  type TermGroupSpec,
} from '../ops/occurrences.ts';
import type { MatchMode } from '../resolve/fold.ts';
import { compileAliasOrThrow } from './alias.ts';

export const SERIES_COLOR_IDS = ['blue', 'orange', 'green', 'violet', 'gold'] as const;
export const SERIES_LINE_IDS = ['solid', 'dash', 'dot', 'dash-dot', 'fine-dot'] as const;

export type SeriesColorId = (typeof SERIES_COLOR_IDS)[number];
export type SeriesCustomColor = `#${string}`;
export type SeriesColor = SeriesColorId | SeriesCustomColor;
export type SeriesLineId = (typeof SERIES_LINE_IDS)[number];

export interface SeriesStyleV1 {
  readonly color: SeriesColor;
  readonly line: SeriesLineId;
}

/** Kept under the established exported type name to limit app churn; the
 * nested schema tag is the authority and is now query-notebook/3. */
export interface NotebookGroupV1 {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly displayName?: string;
  readonly exactMatch: boolean;
  readonly countOverlaps: boolean;
  readonly style: SeriesStyleV1;
}

export interface QueryNotebookV1 {
  readonly schema: 'texttrends/query-notebook/3';
  readonly groups: readonly NotebookGroupV1[];
}

export const NOTEBOOK_LIMITS_V1 = {
  maxGroups: 64,
  maxAliases: TERM_GROUP_LIMITS_V1.maxMembers,
  /** Includes the optional wildcard marker around a maximum-length stem. */
  maxAliasUnits: TERM_GROUP_LIMITS_V1.maxSurfaceUnits + 1,
  maxNameUnits: TERM_GROUP_LIMITS_V1.maxSurfaceUnits,
} as const;

export const FOLDED_MATCH: MatchMode = {
  case: 'folded',
  diacritics: 'folded',
};

export const EXACT_MATCH: MatchMode = {
  case: 'sensitive',
  diacritics: 'sensitive',
};

export const EMPTY_NOTEBOOK: QueryNotebookV1 = {
  schema: 'texttrends/query-notebook/3',
  groups: [],
};

const CUSTOM_SERIES_COLOR = /^#[0-9a-f]{6}$/u;

export function isSeriesColor(value: unknown): value is SeriesColor {
  return typeof value === 'string'
    && (
      SERIES_COLOR_IDS.includes(value as SeriesColorId)
      || CUSTOM_SERIES_COLOR.test(value)
    );
}

export function defaultSeriesStyle(index: number): SeriesStyleV1 {
  const ordinal = Math.abs(index) % SERIES_COLOR_IDS.length;
  return { color: SERIES_COLOR_IDS[ordinal]!, line: SERIES_LINE_IDS[ordinal]! };
}

export function groupTitle(group: NotebookGroupV1): string {
  return group.displayName ?? group.aliases[0] ?? '';
}

export function coreGroupOf(group: NotebookGroupV1): TermGroupSpec {
  const match = group.exactMatch ? EXACT_MATCH : FOLDED_MATCH;
  return {
    id: group.id,
    members: group.aliases.map((alias, index) =>
      compileAliasOrThrow(alias, match, `a${index}`)),
    countOverlaps: group.countOverlaps,
  };
}

export function memberSemanticKey(member: GroupMember): string {
  return termGroupIdentity({
    id: 'member',
    members: [member],
    countOverlaps: false,
  });
}

export function groupIdentity(group: NotebookGroupV1): string {
  return termGroupIdentity(coreGroupOf(group));
}

export function validateNotebookGroup(group: NotebookGroupV1): void {
  if (typeof group.id !== 'string' || group.id.length === 0 || group.id.length > TERM_GROUP_LIMITS_V1.maxIdUnits) {
    throw new RangeError(`a group id must be 1–${TERM_GROUP_LIMITS_V1.maxIdUnits} characters`);
  }
  if (
    !Array.isArray(group.aliases)
    || group.aliases.length === 0
    || group.aliases.length > NOTEBOOK_LIMITS_V1.maxAliases
    || !exactArray(group.aliases, group.aliases.length)
  ) {
    throw new RangeError(`a term needs 1–${NOTEBOOK_LIMITS_V1.maxAliases} aliases`);
  }
  for (const alias of group.aliases) {
    if (
      typeof alias !== 'string'
      || alias.trim().length === 0
      || alias !== alias.normalize('NFC')
      || alias.length > NOTEBOOK_LIMITS_V1.maxAliasUnits
    ) {
      throw new RangeError(`an alias must be nonblank NFC text of at most ${NOTEBOOK_LIMITS_V1.maxAliasUnits} characters`);
    }
  }
  if (group.displayName !== undefined && (
    typeof group.displayName !== 'string'
    || group.displayName.trim().length === 0
    || group.displayName !== group.displayName.normalize('NFC')
    || group.displayName.length > NOTEBOOK_LIMITS_V1.maxNameUnits
  )) {
    throw new RangeError(`a display name is at most ${NOTEBOOK_LIMITS_V1.maxNameUnits} NFC characters`);
  }
  if (typeof group.exactMatch !== 'boolean' || typeof group.countOverlaps !== 'boolean') {
    throw new RangeError('exact-match and overlap settings must be boolean');
  }
  if (
    !isSeriesColor(group.style.color)
    || !SERIES_LINE_IDS.includes(group.style.line)
  ) {
    throw new RangeError('a term style must use a supported color and line type');
  }
  const core = coreGroupOf(group);
  validateGroup(core);
  const seen = new Set<string>();
  for (const member of core.members) {
    const key = memberSemanticKey(member);
    if (seen.has(key)) throw new RangeError('two aliases of this term match identically');
    seen.add(key);
  }
}

function parseAuthoredGroup(value: unknown): NotebookGroupV1 {
  if (value === null || typeof value !== 'object') throw new RangeError('a term must be an exact record');
  const hasDisplayName = Object.prototype.hasOwnProperty.call(value, 'displayName');
  const keys = ['id', 'aliases', 'exactMatch', 'countOverlaps', 'style'];
  if (hasDisplayName) keys.push('displayName');
  if (!exactRecord(value, keys) || !exactRecord(value.style, ['color', 'line'])) {
    throw new RangeError('a term must be an exact authored-alias record');
  }
  if (!Array.isArray(value.aliases) || !exactArray(value.aliases, value.aliases.length)) {
    throw new RangeError('term aliases must be a dense array');
  }
  const group = {
    id: value.id,
    aliases: value.aliases,
    ...(hasDisplayName ? { displayName: value.displayName } : {}),
    exactMatch: value.exactMatch,
    countOverlaps: value.countOverlaps,
    style: value.style,
  } as unknown as NotebookGroupV1;
  validateNotebookGroup(group);
  return group;
}

export function parseQueryNotebook(value: unknown): QueryNotebookV1 {
  if (!exactRecord(value, ['schema', 'groups']) || !Array.isArray(value.groups)
    || value.groups.length > NOTEBOOK_LIMITS_V1.maxGroups
    || !exactArray(value.groups, value.groups.length)) {
    throw new RangeError(`a notebook holds a dense list of at most ${NOTEBOOK_LIMITS_V1.maxGroups} terms`);
  }
  if (value.schema !== 'texttrends/query-notebook/3') {
    throw new RangeError('unknown notebook schema');
  }
  const groups = value.groups.map(parseAuthoredGroup);
  const ids = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) throw new RangeError(`duplicate group id '${group.id.slice(0, 32)}'`);
    ids.add(group.id);
  }
  return value as unknown as QueryNotebookV1;
}
