import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READER_MODE,
  readerComposition,
  readerMode,
  type ReaderMode,
} from '../src/lib/reader-presentation.ts';
import type { WidthClass } from '../src/lib/presentation.ts';

describe('reader presentation authority', () => {
  it('is a total mode parser with a reading-first default', () => {
    expect(readerMode('peek')).toBe('peek');
    expect(readerMode('study')).toBe('study');
    expect(readerMode('full')).toBe('full');
    for (const hostile of [undefined, null, '', 'wide', 1, {}, []]) {
      expect(readerMode(hostile)).toBe(DEFAULT_READER_MODE);
    }
  });

  it('restores every governed region when Reader is closed', () => {
    for (const width of ['compact', 'regular', 'wide'] as const) {
      const view = readerComposition(width, false, 'peek');
      expect(view).toMatchObject({
        open: false,
        requested: 'peek',
        mode: 'peek',
        slot: null,
        showScope: true,
        showLens: true,
        showQuery: true,
        showPlace: true,
        showEvidence: true,
        showMethod: true,
        modeControls: false,
        dockPages: false,
      });
    }
  });

  it.each([
    ['compact', 'peek', 'full', 'viewport', false, false, false, false, false, false, false, true],
    ['compact', 'study', 'full', 'viewport', false, false, false, false, false, false, false, true],
    ['compact', 'full', 'full', 'viewport', false, false, false, false, false, false, false, true],
    ['regular', 'peek', 'study', 'place', true, true, true, false, true, true, true, false],
    ['regular', 'study', 'study', 'place', true, true, true, false, true, true, true, false],
    ['regular', 'full', 'full', 'workbench', true, true, true, false, false, true, true, false],
    ['wide', 'peek', 'peek', 'evidence', true, true, true, true, false, true, true, false],
    ['wide', 'study', 'study', 'place', true, true, true, false, true, true, true, false],
    ['wide', 'full', 'full', 'workbench', true, true, true, false, false, true, true, false],
  ] satisfies readonly [
    WidthClass,
    ReaderMode,
    ReaderMode,
    'evidence' | 'place' | 'workbench' | 'viewport',
    boolean,
    boolean,
    boolean,
    boolean,
    boolean,
    boolean,
    boolean,
    boolean,
  ][])(
    '%s width maps requested %s to %s',
    (
      width,
      requested,
      mode,
      slot,
      showScope,
      showLens,
      showQuery,
      showPlace,
      showEvidence,
      showMethod,
      modeControls,
      dockPages,
    ) => {
      expect(readerComposition(width, true, requested)).toEqual({
        open: true,
        requested,
        mode,
        slot,
        showScope,
        showLens,
        showQuery,
        showPlace,
        showEvidence,
        showMethod,
        modeControls,
        dockPages,
      });
    },
  );
});
