import { describe, expect, it } from 'vitest';
import {
  readerCommand,
  readerCommands,
  type ReaderCommandFacts,
} from '../src/lib/reader-commands.ts';

const facts: ReaderCommandFacts = {
  position: {
    doc: 'study',
    title: 'A Study in Scarlet',
    ordinal: 1,
    textCount: 2,
    token: 20,
    tokenCount: 100,
    percent: 20,
    pageRange: { start: 20, end: 30 },
    source: 'page',
  },
  navigation: {
    previous: { doc: 'study', cursor: { kind: 'before', token: 20 } },
    next: { doc: 'study', cursor: { kind: 'from', token: 30 } },
  },
  scale: 'read',
  atlasAvailable: true,
  speedAvailable: true,
  speedWord: 'Watson',
  hasPresentedTerms: true,
  occurrencePending: false,
  findMode: false,
  previousText: null,
  nextText: { doc: 'sign', token: 20 },
  titleOf: (doc) => doc === 'sign' ? 'The Sign of Four' : 'A Study in Scarlet',
};

describe('reader commands', () => {
  it('keeps the frequent bar commands present without reflowing at boundaries', () => {
    const commands = readerCommands({
      ...facts,
      navigation: { previous: null, next: null },
    });
    expect(readerCommand(commands, 'exit')).toMatchObject({ present: true, enabled: true });
    expect(readerCommand(commands, 'page-previous')).toMatchObject({
      present: true,
      enabled: false,
      reason: 'At start of corpus',
    });
    expect(readerCommand(commands, 'page-next')).toMatchObject({
      present: true,
      enabled: false,
      reason: 'At end of corpus',
    });
  });

  it('omits unavailable groups while preserving within-group disabled states', () => {
    const commands = readerCommands({
      ...facts,
      position: { ...facts.position!, textCount: 1 },
      atlasAvailable: false,
      hasPresentedTerms: false,
    });
    expect(readerCommand(commands, 'reference-previous')).toMatchObject({
      present: false,
      enabled: false,
    });
    expect(readerCommand(commands, 'text-previous').present).toBe(false);
    expect(readerCommand(commands, 'scale').present).toBe(false);
  });

  it('names text and Speed destinations instead of exposing internal ids', () => {
    const commands = readerCommands(facts);
    expect(readerCommand(commands, 'text-next').accessibleName)
      .toBe('Next text: The Sign of Four');
    expect(readerCommand(commands, 'speed').accessibleName)
      .toBe('Open Speed reader paused from “Watson”');
  });

  it('adapts reference commands to Find without duplicating interaction state', () => {
    const commands = readerCommands({ ...facts, findMode: true, occurrencePending: true });
    expect(readerCommand(commands, 'reference-next')).toMatchObject({
      label: 'next find match',
      accessibleName: 'Next exact Find match',
      present: true,
      enabled: false,
    });
    expect(readerCommand(commands, 'find')).toMatchObject({ enabled: false });
  });

  it('derives endpoint and view availability from position facts', () => {
    let commands = readerCommands({
      ...facts,
      position: { ...facts.position!, token: 0 },
    });
    expect(readerCommand(commands, 'text-start').enabled).toBe(false);
    expect(readerCommand(commands, 'text-end').enabled).toBe(true);
    commands = readerCommands({
      ...facts,
      position: { ...facts.position!, token: 99 },
      speedAvailable: false,
    });
    expect(readerCommand(commands, 'text-end').enabled).toBe(false);
    expect(readerCommand(commands, 'speed')).toMatchObject({ present: true, enabled: false });
  });
});
