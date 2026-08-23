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
      onSetPacing: vi.fn(),
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
    expect(html).not.toContain('role="note"');
    expect(html).toContain('return to Reader');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>back<\/button>/u);
    expect(html).toContain('aria-label="Pace in words per minute"');
    expect(html).toContain('including rests');
    expect(html).toContain('min="100" max="1200" step="25"');
    expect(html).toContain('<summary data-rsvp-control="true">rhythm</summary>');
    expect(html).toContain('Words at once (maximum)');
    expect(html).toContain('type="radio" aria-label="1 word at once"');
    expect(html).toContain('name="reader-rsvp-words-at-once" checked="" value="1"');
    expect(html).not.toContain('<span>words at once</span><select');
    expect(html).toContain('aria-label="Sentence rest in milliseconds"');
    expect(html).toContain('aria-label="Paragraph rest in milliseconds"');
    expect(html).toContain('aria-label="Length emphasis in percent"');
    expect(html).toContain('Rest values are maxima taken from the current sentence');
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
      onOpenShortcuts: vi.fn(),
    }));
    expect(pausedHtml).toContain('role="note" aria-label="Paused sentence context" tabindex="0"');
    expect(pausedHtml).toContain('<mark>Speed,</mark> reader');
    const contextTag = pausedHtml.match(/<div class="reader-rsvp-context"[^>]*>/u)?.[0];
    expect(contextTag).toBeDefined();
    expect(contextTag).not.toContain('aria-live');
  });
});
