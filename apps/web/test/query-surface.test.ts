import { describe, expect, it } from 'vitest';
import {
  placeUsesQueryEncoding,
  queryEditorTarget,
  querySurfaceView,
} from '../src/lib/query-surface.ts';
import type { NotebookGroupV1 } from '../src/lib/notebook.ts';

const group: NotebookGroupV1 = {
  id: 'group-1',
  name: 'wolf',
  members: [{
    kind: 'token',
    id: 'member-1',
    surface: 'wolf',
    match: { case: 'folded', diacritics: 'folded' },
  }],
  countOverlaps: false,
};

describe('query surface', () => {
  it('limits the compact encoding key to Trends and Concordance', () => {
    expect(placeUsesQueryEncoding('trends')).toBe(true);
    expect(placeUsesQueryEncoding('concordance')).toBe(true);
    expect(placeUsesQueryEncoding('catalog')).toBe(false);
    expect(placeUsesQueryEncoding('vocabulary')).toBe(false);
    expect(placeUsesQueryEncoding('compare')).toBe(false);
  });

  it('parses only governed query-editor targets', () => {
    expect(queryEditorTarget({ surface: 'query-editor', mode: 'manage' }))
      .toEqual({ surface: 'query-editor', mode: 'manage' });
    expect(queryEditorTarget({ surface: 'query-editor', mode: 'quick-add' }))
      .toEqual({ surface: 'query-editor', mode: 'quick-add' });
    expect(queryEditorTarget({
      surface: 'query-editor',
      mode: 'group',
      groupId: 'group-1',
    })).toEqual({
      surface: 'query-editor',
      mode: 'group',
      groupId: 'group-1',
    });
    expect(queryEditorTarget({ surface: 'query-editor', mode: 'group' })).toBeNull();
    expect(queryEditorTarget({ surface: 'evidence', mode: 'group', groupId: 'x' }))
      .toBeNull();
  });

  it('delegates exact count semantics to the notebook view model', () => {
    const view = querySurfaceView({
      place: 'trends',
      groups: [group],
      activeGroupIds: new Set([group.id]),
      soloGroupId: null,
      styleSlots: new Map([[group.id, 2]]),
      trends: new Map(),
      hasSnapshot: false,
      partialCorpus: false,
    });
    expect(view.usesQueryEncoding).toBe(true);
    expect(view.rows).toEqual([{
      id: group.id,
      name: 'wolf',
      active: true,
      solo: false,
      slot: 2,
      projected: true,
      count: { kind: 'not-run' },
    }]);
  });
});
