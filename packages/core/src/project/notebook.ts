/**
 * Query-notebook admission shared by the durable workspace and app editor.
 * Core is the only semantic/shape authority; UI modules may add editing
 * helpers but must not duplicate this parser.
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

export interface NotebookGroupV1 {
  readonly id: string;
  readonly name: string;
  readonly members: readonly GroupMember[];
  readonly countOverlaps: boolean;
}

export interface QueryNotebookV1 {
  readonly schema: 'texttrends/query-notebook/1';
  readonly groups: readonly NotebookGroupV1[];
}

export const NOTEBOOK_LIMITS_V1 = {
  maxGroups: 64,
  maxNameUnits: TERM_GROUP_LIMITS_V1.maxSurfaceUnits,
} as const;

export const FOLDED_MATCH: MatchMode = {
  case: 'folded',
  diacritics: 'folded',
};

export const EMPTY_NOTEBOOK: QueryNotebookV1 = {
  schema: 'texttrends/query-notebook/1',
  groups: [],
};

export function coreGroupOf(group: NotebookGroupV1): TermGroupSpec {
  return {
    id: group.id,
    members: group.members,
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
  if (
    group.name.trim().length === 0 ||
    group.name !== group.name.normalize('NFC')
  ) {
    throw new RangeError('a group needs a nonblank NFC-normalized name');
  }
  if (group.name.length > NOTEBOOK_LIMITS_V1.maxNameUnits) {
    throw new RangeError(
      `a group name is at most ${NOTEBOOK_LIMITS_V1.maxNameUnits} characters`,
    );
  }
  validateGroup(coreGroupOf(group));
  const seen = new Set<string>();
  for (const member of group.members) {
    const key = memberSemanticKey(member);
    if (seen.has(key)) {
      throw new RangeError('two members of this group match identically');
    }
    seen.add(key);
  }
}

const MEMBER_MODES = new Set<unknown>(['sensitive', 'folded']);

function isGroupMemberShape(member: unknown): boolean {
  if (
    !exactRecord(member, ['id', 'kind', 'surface', 'match']) &&
    !exactRecord(member, [
      'id',
      'kind',
      'surfaces',
      'match',
      'crossSentence',
    ]) &&
    !exactRecord(member, ['id', 'kind', 'stem', 'match'])
  ) {
    return false;
  }
  const record = member as {
    id?: unknown;
    kind?: unknown;
    match?: unknown;
    surface?: unknown;
    surfaces?: unknown;
    stem?: unknown;
    crossSentence?: unknown;
  };
  if (typeof record.id !== 'string') return false;
  if (!exactRecord(record.match, ['case', 'diacritics'])) return false;
  const match = record.match as {
    case?: unknown;
    diacritics?: unknown;
  };
  if (!MEMBER_MODES.has(match.case) || !MEMBER_MODES.has(match.diacritics)) {
    return false;
  }
  switch (record.kind) {
    case 'token':
      return typeof record.surface === 'string';
    case 'phrase': {
      if (typeof record.crossSentence !== 'boolean') return false;
      const surfaces = record.surfaces;
      if (
        !Array.isArray(surfaces) ||
        surfaces.length > TERM_GROUP_LIMITS_V1.maxPhraseSurfaces ||
        !exactArray(surfaces, surfaces.length)
      ) {
        return false;
      }
      for (const surface of surfaces) {
        if (typeof surface !== 'string') return false;
      }
      return true;
    }
    case 'prefix':
    case 'suffix':
      return typeof record.stem === 'string';
    default:
      return false;
  }
}

export function parseQueryNotebook(value: unknown): QueryNotebookV1 {
  if (!exactRecord(value, ['schema', 'groups'])) {
    throw new RangeError('a notebook must be an exact {schema, groups} record');
  }
  if (value.schema !== 'texttrends/query-notebook/1') {
    throw new RangeError('unknown notebook schema');
  }
  const groups = value.groups;
  if (
    !Array.isArray(groups) ||
    groups.length > NOTEBOOK_LIMITS_V1.maxGroups
  ) {
    throw new RangeError(
      `a notebook holds at most ${NOTEBOOK_LIMITS_V1.maxGroups} groups`,
    );
  }
  if (!exactArray(groups, groups.length)) {
    throw new RangeError('notebook groups must be a dense plain array');
  }
  const ids = new Set<string>();
  for (let index = 0; index < groups.length; index++) {
    const group: unknown = groups[index];
    if (!exactRecord(group, ['id', 'name', 'members', 'countOverlaps'])) {
      throw new RangeError(
        `group ${index} must be an exact {id, name, members, countOverlaps} record`,
      );
    }
    if (
      typeof group.id !== 'string' ||
      typeof group.name !== 'string' ||
      typeof group.countOverlaps !== 'boolean'
    ) {
      throw new RangeError(`group ${index} has a malformed id/name/countOverlaps`);
    }
    if (ids.has(group.id)) {
      throw new RangeError(`duplicate group id '${group.id.slice(0, 32)}'`);
    }
    ids.add(group.id);
    const members = group.members;
    if (
      !Array.isArray(members) ||
      members.length > TERM_GROUP_LIMITS_V1.maxMembers
    ) {
      throw new RangeError(
        `group ${index} must have at most ${TERM_GROUP_LIMITS_V1.maxMembers} members`,
      );
    }
    if (!exactArray(members, members.length)) {
      throw new RangeError(`group ${index} members must be a dense plain array`);
    }
    for (let member = 0; member < members.length; member++) {
      if (!isGroupMemberShape(members[member])) {
        throw new RangeError(`group ${index} member ${member} is malformed`);
      }
    }
    validateNotebookGroup(group as unknown as NotebookGroupV1);
  }
  return value as unknown as QueryNotebookV1;
}
