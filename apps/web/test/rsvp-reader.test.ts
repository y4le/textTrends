import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RsvpReader } from '../src/components/RsvpReader.tsx';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import { RSVP_PACING_DEFAULTS } from '../src/lib/rsvp.ts';

const page: ReaderPageResultV1 = {
  method: 'reader-page/1',
  doc: 'a',
  tokens: { start: 10, end: 12 },
  docCharsUtf16: { start: 100, end: 113 },
  text: 'Speed, reader',
  tokenStartsUtf16: [0, 7],
  tokenEndsUtf16: [5, 13],
  sentenceBounds: [0, 2],
  paragraphBounds: [0, 2],
  anchor: null,
  previous: { kind: 'before', token: 10 },
  next: { kind: 'from', token: 12 },
  atStart: false,
  atEnd: false,
  docTokenCount: 40,
  cappedBy: 'tokens',
  marks: [],
  marksTruncated: false,
};

describe('RSVP Reader presentation', () => {
  it('pins separate focal spans and exposes stable controls without live-announcing words', () => {
    const html = renderToStaticMarkup(createElement(RsvpReader, {
      title: 'Book A',
      mode: {
        snapshot: 's1', doc: 'a', docTokenCount: 40, startToken: 10,
        ...RSVP_PACING_DEFAULTS, playing: true,
      },
      source: { status: 'ready', page },
      onSetPlaying: vi.fn(),
      onSetWpm: vi.fn(),
      onPublish: vi.fn(),
      onSeek: vi.fn(),
      onExit: vi.fn(),
      onRetry: vi.fn(),
      onOpenShortcuts: vi.fn(),
    }));

    expect(html).toContain('class="reader-rsvp-before">S</span>');
    expect(html).toContain('class="reader-rsvp-anchor">p</span>');
    expect(html).toContain('class="reader-rsvp-after">eed,</span>');
    expect(html).toContain('class="reader-rsvp-word" aria-hidden="true"');
    expect(html).toContain('return to Reader');
    expect(html).toContain('aria-label="Set pace in words per minute"');
    expect(html).toContain('min="100" max="900" step="25"');
    const status = html.match(/<p class="visually-hidden" role="status"[^>]*>(.*?)<\/p>/)?.[1];
    expect(status).toContain('Speed reading playing at a set pace of 300');
    expect(status).not.toContain('token');
  });
});
