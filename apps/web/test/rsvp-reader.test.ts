import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RsvpReader } from '../src/components/RsvpReader.tsx';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import { RSVP_PACING_DEFAULTS } from '@texttrends/rsvp';

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
      onSetPacing: vi.fn(),
      onPublish: vi.fn(),
      onSeek: vi.fn(),
      onExit: vi.fn(),
      onRetry: vi.fn(),
      onOpenSettings: vi.fn(),
    }));

    expect(html).toContain('class="reader-rsvp-before reader-rsvp-frame-word"');
    expect(html).toContain('class="reader-rsvp-anchor reader-rsvp-frame-word"');
    expect(html).toContain('class="reader-rsvp-after"><span class="reader-rsvp-frame-word"');
    expect(html).toContain('data-rsvp-frame-token="10">S</span>');
    expect(html).toContain('data-rsvp-frame-token="10">p</span>');
    expect(html).toContain('data-rsvp-frame-token="10">eed,</span>');
    expect(html).toContain('class="reader-rsvp-word" aria-hidden="true"');
    expect(html).not.toContain('role="note"');
    expect(html).toContain('aria-label="Return to Reader"');
    expect(html).toContain('aria-label="Previous frame"');
    expect(html).toContain('aria-label="Previous word" aria-keyshortcuts="h ArrowLeft"');
    expect(html).toContain('aria-label="Next word" aria-keyshortcuts="l ArrowRight"');
    expect(html).toContain('aria-label="Next frame"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Pace in words per minute"');
    expect(html).toContain('>Including rests</span>');
    expect(html).toContain('min="100" max="2000" step="25"');
    expect(html).toContain('aria-keyshortcuts="j ArrowDown"');
    expect(html).toContain('aria-keyshortcuts="k ArrowUp"');
    expect(html).toContain('aria-label="Open Speed settings"');
    expect(html).toContain('Words at once (maximum)');
    expect(html).toContain('type="radio" aria-label="1 word at once"');
    expect(html).toContain('name="reader-rsvp-words-at-once" checked="" value="1"');
    expect(html).toContain('<span>rhythm</span><select');
    expect(html).toContain('aria-label="Rhythm preset"');
    expect(html).not.toContain('aria-label="Sentence rest in milliseconds"');
    expect(html).not.toContain('aria-label="Frame character limit in characters"');
    expect(html).toContain('paragraph rest 700 ms (100 ms here)');
    const status = html.match(/<p class="visually-hidden" role="status"[^>]*>(.*?)<\/p>/)?.[1];
    expect(status).toContain('Speed reading playing at 300 words per minute including rests');
    expect(status).not.toContain('token');

    const pausedHtml = renderToStaticMarkup(createElement(RsvpReader, {
      title: 'Book A',
      mode: {
        snapshot: 's1', doc: 'a', docTokenCount: 40, startToken: 10,
        ...RSVP_PACING_DEFAULTS, playing: false,
      },
      source: { status: 'ready', page },
      onSetPlaying: vi.fn(),
      onSetPacing: vi.fn(),
      onPublish: vi.fn(),
      onSeek: vi.fn(),
      onExit: vi.fn(),
      onRetry: vi.fn(),
      onOpenSettings: vi.fn(),
    }));
    expect(pausedHtml).toContain('role="note" aria-label="Paused sentence context" tabindex="0"');
    expect(pausedHtml).toContain('<mark>Speed,</mark> reader');
    const contextTag = pausedHtml.match(/<div class="reader-rsvp-context"[^>]*>/u)?.[0];
    expect(contextTag).toBeDefined();
    expect(contextTag).not.toContain('aria-live');

    const renderAt = (wpm: number, wordsPerFrame = 1) => renderToStaticMarkup(
      createElement(RsvpReader, {
        title: 'Book A',
        mode: {
          snapshot: 's1', doc: 'a', docTokenCount: 40, startToken: 10,
          ...RSVP_PACING_DEFAULTS, wpm, wordsPerFrame, playing: false,
        },
        source: { status: 'ready', page },
        onSetPlaying: vi.fn(),
        onSetPacing: vi.fn(),
        onPublish: vi.fn(),
        onSeek: vi.fn(),
        onExit: vi.fn(),
        onRetry: vi.fn(),
        onOpenSettings: vi.fn(),
      }),
    );
    expect(renderAt(2_000)).toContain('aria-describedby="reader-rsvp-pace-help"');
    expect(renderAt(2_000, 2)).toContain('name="reader-rsvp-words-at-once"');
    expect(renderAt(300, 2)).not.toMatch(
      /<input[^>]*min="12" max="40" step="2"[^>]*aria-disabled="true"/u,
    );
  });
});
