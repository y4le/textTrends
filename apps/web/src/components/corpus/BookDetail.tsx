import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  bookDetailRegionId,
  type BookDetailVM,
} from '../../lib/corpus-view.ts';
import { OnlyBookButton } from './OnlyBookButton.tsx';
import { SourceDetails } from './SourceDetails.tsx';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? '—' : decimal.format(input);

interface Measurement {
  readonly key: string;
  readonly label: string;
  readonly exact: string;
  readonly explanation: string;
}

function MeasurementInfo({
  id,
  label,
  explanation,
}: {
  readonly id: string;
  readonly label: string;
  readonly explanation: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const open = hovered || focused || pinned;

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setHovered(false);
      setFocused(false);
      setPinned(false);
    };
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const triggerBox = button.current?.getBoundingClientRect();
      const tooltipBox = tooltip.current?.getBoundingClientRect();
      if (!triggerBox || !tooltipBox) return;
      const padding = 8;
      const gap = 4;
      const centered = triggerBox.left + (triggerBox.width - tooltipBox.width) / 2;
      const left = Math.min(
        Math.max(padding, centered),
        Math.max(padding, window.innerWidth - tooltipBox.width - padding),
      );
      const below = triggerBox.bottom + gap;
      const above = triggerBox.top - tooltipBox.height - gap;
      const top = below + tooltipBox.height <= window.innerHeight - padding || above < padding
        ? below
        : above;
      setPosition({ left, top: Math.max(padding, top), ready: true });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <>
      <span
        ref={root}
        className="measurement-info"
        data-open={open || undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') setHovered(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'touch') setHovered(false);
        }}
      >
        <button
          ref={button}
          type="button"
          className="measurement-info-button"
          aria-label={`About ${label}`}
          aria-describedby={id}
          aria-controls={id}
          onClick={() => setPinned((current) => !current)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setPinned(false);
          }}
        >
          <span aria-hidden="true">ⓘ</span>
        </button>
      </span>
      {createPortal(
        <span
          ref={tooltip}
          id={id}
          role="tooltip"
          className="measurement-info-tooltip"
          data-open={open || undefined}
          style={{
            display: open ? 'block' : 'none',
            left: position.left,
            top: position.top,
            visibility: open && position.ready ? 'visible' : 'hidden',
          }}
        >
          {explanation}
        </span>,
        document.body,
      )}
    </>
  );
}

export function BookDetail({
  view,
  onClose,
  onScopeMessage,
}: {
  readonly view: BookDetailVM;
  readonly onClose: () => void;
  readonly onScopeMessage: (message: string | null) => void;
}) {
  const stats = view.stats;
  const measurementIdBase = `${bookDetailRegionId(view.doc)}-measurement`;
  const measurements: readonly Measurement[] = [
    {
      key: 'tokens',
      label: 'selected / full tokens',
      exact: `${number.format(stats.selectedTokens)} / ${number.format(stats.fullTokens)}`,
      explanation: 'Tokens in the current measurement scope, followed by all tokens in the text. The values match when the full text is measured.',
    },
    {
      key: 'token-classes',
      label: 'lexical / numeral tokens',
      exact: `${number.format(stats.lexicalTokens)} / ${number.format(stats.numeralTokens)}`,
      explanation: 'Word-like tokens classified as lexical forms, followed by word-like tokens classified as numerals.',
    },
    {
      key: 'types',
      label: 'types',
      exact: number.format(stats.types),
      explanation: 'The number of distinct indexed token forms in the measurement scope.',
    },
    {
      key: 'hapax',
      label: 'hapax',
      exact: number.format(stats.hapax),
      explanation: 'The number of token types that occur exactly once in the measurement scope.',
    },
    {
      key: 'units',
      label: 'sentences / paragraphs',
      exact: `${number.format(stats.sentences)} / ${number.format(stats.paragraphs)}`,
      explanation: 'Detected sentence units, followed by detected paragraph units, whose starts fall within the measurement scope.',
    },
    {
      key: 'sentence-length',
      label: 'sentence mean / median / p90',
      exact: `${value(stats.sentenceMean)} / ${value(stats.sentenceMedian)} / ${value(stats.sentenceP90)}`,
      explanation: 'Sentence length in tokens: the arithmetic average, the middle value, and the 90th percentile. At p90, 90% of sentences are this length or shorter.',
    },
    {
      key: 'paragraph-length',
      label: 'paragraph mean',
      exact: value(stats.paragraphMean),
      explanation: 'The arithmetic average number of tokens per detected paragraph.',
    },
    {
      key: 'ttr',
      label: 'TTR',
      exact: value(stats.ttr),
      explanation: 'Type-token ratio: distinct token types divided by all tokens in scope. It is descriptive and strongly affected by text length.',
    },
    {
      key: 'mattr',
      label: 'MATTR',
      exact: `${value(stats.mattr)}${stats.mattrIsPlainTtr ? ' (plain TTR in a short run)' : ''}`,
      explanation: `Moving-average type-token ratio: the mean TTR across sliding windows of ${number.format(view.mattrWindow)} tokens. A shorter run uses plain TTR.`,
    },
    {
      key: 'utf16-span',
      label: 'UTF-16 span',
      exact: number.format(stats.charsUtf16),
      explanation: 'The length of the measured source-text span in UTF-16 code units. This is an addressing unit, not a byte or necessarily a visible character.',
    },
  ];
  return (
    <section
      id={bookDetailRegionId(view.doc)}
      className="book-detail"
      role="region"
      aria-label={`Text detail: ${view.title}`}
    >
      <section aria-label="Measurements">
        <dl className="book-detail-stats">
          {measurements.map((measurement) => (
            <div key={measurement.key}>
              <dt className="book-detail-measurement-label">
                <span>{measurement.label}</span>
                <MeasurementInfo
                  id={`${measurementIdBase}-${measurement.key}-help`}
                  label={measurement.label}
                  explanation={measurement.explanation}
                />
              </dt>
              <dd className="selectable-stat">{measurement.exact}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="book-detail-footer">
        <SourceDetails doc={view.doc} />
        <div className="book-detail-actions">
          <OnlyBookButton doc={view.doc} onMessage={onScopeMessage} />
          <button
            type="button"
            aria-label={`Close text detail for ${view.title}`}
            onClick={onClose}
          >
            close
          </button>
        </div>
      </footer>

    </section>
  );
}
