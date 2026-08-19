import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_LOTR_ID, BUILTIN_SHERLOCK_ID } from '../src/lib/project.ts';
import { consumeDemoBootRequest, parseDemoBootRequest } from '../src/lib/demo-query.ts';

describe('demo boot query', () => {
  it('allowlists named presets and follows first-value semantics', () => {
    expect(parseDemoBootRequest('?demo=sherlock')).toEqual({
      slug: 'sherlock',
      id: BUILTIN_SHERLOCK_ID,
    });
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
