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
import { compileAlias, compileAliasOrThrow } from './alias.ts';

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

function isMatchMode(value: unknown): value is MatchMode {
  return exactRecord(value, ['case', 'diacritics'])
    && (value.case === 'sensitive' || value.case === 'folded')
    && (value.diacritics === 'sensitive' || value.diacritics === 'folded');
}

function parseLegacyMember(value: unknown): GroupMember {
  if (!exactRecord(value, ['id', 'kind', 'surface', 'match'])
    && !exactRecord(value, ['id', 'kind', 'stem', 'match'])
    && !exactRecord(value, ['id', 'kind', 'elements', 'match', 'crossSentence'])
    && !exactRecord(value, ['id', 'kind', 'surfaces', 'match', 'crossSentence'])) {
    throw new RangeError('a legacy group member is malformed');
  }
  if (typeof value.id !== 'string' || !isMatchMode(value.match)) {
    throw new RangeError('a legacy group member is malformed');
  }
  if (value.kind === 'token' && typeof value.surface === 'string') {
    return { id: value.id, kind: 'token', surface: value.surface, match: value.match };
  }
  if ((value.kind === 'prefix' || value.kind === 'suffix') && typeof value.stem === 'string') {
    return { id: value.id, kind: value.kind, stem: value.stem, match: value.match };
  }
  if (value.kind === 'phrase' && typeof value.crossSentence === 'boolean') {
    if (Array.isArray(value.elements)
      && value.elements.length <= TERM_GROUP_LIMITS_V1.maxPhraseElements
      && exactArray(value.elements, value.elements.length)) {
      const elements = value.elements.map((element) => {
        if (exactRecord(element, ['kind', 'surface']) && element.kind === 'token' && typeof element.surface === 'string') {
          return { kind: 'token' as const, surface: element.surface };
        }
        if (exactRecord(element, ['kind', 'stem'])
          && (element.kind === 'prefix' || element.kind === 'suffix')
          && typeof element.stem === 'string') {
          return { kind: element.kind as 'prefix' | 'suffix', stem: element.stem };
        }
        throw new RangeError('a legacy phrase element is malformed');
      });
      return { id: value.id, kind: 'phrase', elements, match: value.match, crossSentence: value.crossSentence };
    }
    if (Array.isArray(value.surfaces) && exactArray(value.surfaces, value.surfaces.length)
      && value.surfaces.length <= TERM_GROUP_LIMITS_V1.maxPhraseElements
      && value.surfaces.every((surface) => typeof surface === 'string')) {
      return {
        id: value.id,
        kind: 'phrase',
        elements: value.surfaces.map((surface) => ({ kind: 'token', surface })),
        match: value.match,
        crossSentence: value.crossSentence,
      };
    }
  }
  throw new RangeError('a legacy group member is malformed');
}

function aliasOfLegacyMember(member: GroupMember): string {
  switch (member.kind) {
    case 'token': return member.surface;
    case 'prefix': return `${member.stem}*`;
    case 'suffix': return `*${member.stem}`;
    case 'phrase': return member.elements.map((element) => {
      switch (element.kind) {
        case 'token': return element.surface;
        case 'prefix': return `${element.stem}*`;
        case 'suffix': return `*${element.stem}`;
      }
    }).join(' ');
  }
}

function parseAuthoredGroup(value: unknown, allowCustomColor: boolean): NotebookGroupV1 {
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
  if (
    !allowCustomColor
    && exactRecord(value.style, ['color', 'line'])
    && !SERIES_COLOR_IDS.includes(value.style.color as SeriesColorId)
  ) {
    throw new RangeError('query-notebook/2 terms must use a legacy series color');
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

function upgradeV1Group(value: unknown, index: number): NotebookGroupV1 | null {
  if (!exactRecord(value, ['id', 'name', 'members', 'countOverlaps'])
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.countOverlaps !== 'boolean'
    || !Array.isArray(value.members)
    || value.members.length > TERM_GROUP_LIMITS_V1.maxMembers
    || !exactArray(value.members, value.members.length)) {
    throw new RangeError(`legacy group ${index} is malformed`);
  }
  const members = value.members.map(parseLegacyMember);
  validateGroup({ id: value.id, members, countOverlaps: value.countOverlaps });
  /** v1 allowed four match-mode combinations per member; v2 deliberately
   * exposes one group-wide exact toggle. Migration chooses exact when ANY
   * legacy member requested case or accent sensitivity. This is conservative
   * against newly introduced false-positive matches, though a formerly folded
   * member in a mixed group becomes narrower. crossSentence is likewise no
   * longer authored and compiles to false, and a literal terminal `*` now has
   * the v2 wildcard meaning. These product-level collapses are pinned in the
   * migration tests below this module's public contract. */
  const exactMatch = members.some((member) =>
    member.match.case === 'sensitive' || member.match.diacritics === 'sensitive');
  const match = exactMatch ? EXACT_MATCH : FOLDED_MATCH;
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const candidate = aliasOfLegacyMember(member).normalize('NFC');
    const compiled = compileAlias(candidate, match, `a${aliases.length}`);
    if (!compiled.ok) continue;
    const key = memberSemanticKey(compiled.member);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(compiled.alias);
  }
  // Some v1 surfaces were valid records but cannot denote a word-token query
  // in the natural alias language (punctuation-only and blank terms). Omit
  // only that unusable group; parseWorkspace also reconciles its selections,
  // so the rest of the saved corpus, views, and notebook always reopen.
  if (aliases.length === 0) return null;
  const normalizedName = value.name.normalize('NFC');
  const displayName = normalizedName.trim() !== ''
    && normalizedName.length <= NOTEBOOK_LIMITS_V1.maxNameUnits
    && normalizedName !== aliases[0]
    ? normalizedName
    : undefined;
  const group: NotebookGroupV1 = {
    id: value.id,
    aliases,
    ...(displayName === undefined ? {} : { displayName }),
    exactMatch,
    countOverlaps: value.countOverlaps,
    style: defaultSeriesStyle(index),
  };
  validateNotebookGroup(group);
  return group;
}

export function parseQueryNotebook(value: unknown): QueryNotebookV1 {
  if (!exactRecord(value, ['schema', 'groups']) || !Array.isArray(value.groups)
    || value.groups.length > NOTEBOOK_LIMITS_V1.maxGroups
    || !exactArray(value.groups, value.groups.length)) {
    throw new RangeError(`a notebook holds a dense list of at most ${NOTEBOOK_LIMITS_V1.maxGroups} terms`);
  }
  const groups = value.schema === 'texttrends/query-notebook/3'
    ? value.groups.map((group) => parseAuthoredGroup(group, true))
    : value.schema === 'texttrends/query-notebook/2'
      ? value.groups.map((group) => parseAuthoredGroup(group, false))
      : value.schema === 'texttrends/query-notebook/1'
        ? value.groups.map(upgradeV1Group).filter((group): group is NotebookGroupV1 => group !== null)
        : (() => { throw new RangeError('unknown notebook schema'); })();
  const ids = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) throw new RangeError(`duplicate group id '${group.id.slice(0, 32)}'`);
    ids.add(group.id);
  }
  return value.schema === 'texttrends/query-notebook/3'
    ? value as unknown as QueryNotebookV1
    : { schema: 'texttrends/query-notebook/3', groups };
}
