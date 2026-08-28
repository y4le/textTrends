import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_AUSTEN_ID,
  BUILTIN_BIBLE_ID,
  BUILTIN_CLASSIC_NOVELS_ID,
  BUILTIN_DARWIN_ORIGIN_ID,
  BUILTIN_INAUGURALS_ID,
  BUILTIN_LOTR_ID,
  BUILTIN_POLITICAL_ARGUMENTS_ID,
  BUILTIN_QURAN_ID,
  BUILTIN_SHAKESPEARE_ID,
  BUILTIN_SHERLOCK_ID,
} from '../src/lib/project.ts';
import { consumeDemoBootRequest, parseDemoBootRequest } from '../src/lib/demo-query.ts';

describe('demo boot query', () => {
  it('allowlists named presets and follows first-value semantics', () => {
    expect(parseDemoBootRequest('?demo=sherlock')).toEqual({
      slug: 'sherlock',
      id: BUILTIN_SHERLOCK_ID,
    });
    expect(parseDemoBootRequest('?demo=austen')).toEqual({
      slug: 'austen',
      id: BUILTIN_AUSTEN_ID,
    });
    expect(parseDemoBootRequest('?demo=bible')?.id).toBe(BUILTIN_BIBLE_ID);
    expect(parseDemoBootRequest('?demo=quran')?.id).toBe(BUILTIN_QURAN_ID);
    expect(parseDemoBootRequest('?demo=koran')?.id).toBe(BUILTIN_QURAN_ID);
    expect(parseDemoBootRequest('?demo=arguments')?.id).toBe(BUILTIN_POLITICAL_ARGUMENTS_ID);
    expect(parseDemoBootRequest('?demo=political')?.id).toBe(BUILTIN_POLITICAL_ARGUMENTS_ID);
    expect(parseDemoBootRequest('?demo=shakespeare')?.id).toBe(BUILTIN_SHAKESPEARE_ID);
    expect(parseDemoBootRequest('?demo=inaugurals')?.id).toBe(BUILTIN_INAUGURALS_ID);
    expect(parseDemoBootRequest('?demo=darwin')?.id).toBe(BUILTIN_DARWIN_ORIGIN_ID);
    expect(parseDemoBootRequest('?demo=classics')?.id).toBe(BUILTIN_CLASSIC_NOVELS_ID);
    expect(parseDemoBootRequest('?demo=LOTR&demo=sherlock')).toEqual({
      slug: 'LOTR',
      id: BUILTIN_LOTR_ID,
    });
    expect(parseDemoBootRequest('?demo=../../private')).toEqual({
      slug: '../../private',
      id: null,
    });
    expect(parseDemoBootRequest('?p=inputs')).toBeNull();
  });

  it('consumes all owned parameters while preserving foreign bytes, hash, and history state', () => {
    const replaceState = vi.fn();
    const target = {
      location: {
        href: 'https://yalethom.as/textTrends/?x=a%2Fb&demo=lotr&p=inputs&demo=sherlock#reader',
        search: '?x=a%2Fb&demo=lotr&p=inputs&demo=sherlock',
      },
      history: { state: { retained: true }, replaceState },
    } as unknown as Pick<Window, 'history' | 'location'>;

    expect(consumeDemoBootRequest(target)).toEqual({ slug: 'lotr', id: BUILTIN_LOTR_ID });
    expect(replaceState).toHaveBeenCalledWith(
      { retained: true },
      '',
      'https://yalethom.as/textTrends/?x=a%2Fb&p=inputs#reader',
    );
  });
});
