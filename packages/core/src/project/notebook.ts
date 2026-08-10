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
    !exactRecord(member, ['id', 'kind', 'elements', 'match', 'crossSentence']) &&
    !exactRecord(member, ['id', 'kind', 'stem', 'match'])
  ) {
    return false;
  }
  const record = member as {
    id?: unknown;
    kind?: unknown;
    match?: unknown;
    surface?: unknown;
    elements?: unknown;
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
      const elements = record.elements;
      if (
        !Array.isArray(elements) ||
        elements.length > TERM_GROUP_LIMITS_V1.maxPhraseElements ||
        !exactArray(elements, elements.length)
      ) {
        return false;
      }
      for (const element of elements) {
        if (
          !exactRecord(element, ['kind', 'surface'])
          && !exactRecord(element, ['kind', 'stem'])
        ) return false;
        if (element.kind === 'token') {
          if (typeof element.surface !== 'string') return false;
        } else if (element.kind === 'prefix' || element.kind === 'suffix') {
          if (typeof element.stem !== 'string') return false;
        } else {
          return false;
        }
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

/** Lift the only legacy v1 shape invalidated by phrase elements. The schema
 * stays /1 during this transition, so a phrase-bearing saved workspace must
 * reopen instead of being misclassified as corrupt. */
function liftLegacyPhraseMember(member: unknown): GroupMember | null {
  if (!exactRecord(member, ['id', 'kind', 'surfaces', 'match', 'crossSentence'])) return null;
  if (
    member.kind !== 'phrase'
    || typeof member.id !== 'string'
    || typeof member.crossSentence !== 'boolean'
    || !exactRecord(member.match, ['case', 'diacritics'])
    || !MEMBER_MODES.has(member.match.case)
    || !MEMBER_MODES.has(member.match.diacritics)
    || !Array.isArray(member.surfaces)
    || member.surfaces.length > TERM_GROUP_LIMITS_V1.maxPhraseElements
    || !exactArray(member.surfaces, member.surfaces.length)
    || member.surfaces.some((surface) => typeof surface !== 'string')
  ) return null;
  return {
    id: member.id,
    kind: 'phrase',
    elements: member.surfaces.map((surface) => ({ kind: 'token', surface })),
    match: member.match as unknown as MatchMode,
    crossSentence: member.crossSentence,
  };
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
  const normalizedGroups: NotebookGroupV1[] = [];
  let liftedLegacy = false;
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
    const normalizedMembers: GroupMember[] = [];
    for (let member = 0; member < members.length; member++) {
      const candidate = members[member];
      if (isGroupMemberShape(candidate)) {
        normalizedMembers.push(candidate as GroupMember);
        continue;
      }
      const legacy = liftLegacyPhraseMember(candidate);
      if (legacy === null) {
        throw new RangeError(`group ${index} member ${member} is malformed`);
      }
      normalizedMembers.push(legacy);
      liftedLegacy = true;
    }
    const normalized = normalizedMembers.every((member, memberIndex) => member === members[memberIndex])
      ? group as unknown as NotebookGroupV1
      : { ...(group as unknown as NotebookGroupV1), members: normalizedMembers };
    validateNotebookGroup(normalized);
    normalizedGroups.push(normalized);
  }
  return liftedLegacy
    ? { schema: 'texttrends/query-notebook/1', groups: normalizedGroups }
    : value as unknown as QueryNotebookV1;
}
