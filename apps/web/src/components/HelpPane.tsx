import { Fragment, useEffect, useRef, useState } from 'react';
import { PLACE_HEADING, type Place } from '../lib/places.ts';
import type { ShortcutHelpContext } from '../lib/shortcuts.ts';
import {
  isShortcutTypingTarget,
  shortcutAria,
  shortcutHelpSections,
  shortcutMatches,
} from '../lib/shortcuts.ts';
import { useApp } from '../lib/store-instance.ts';
import { UtilityPane } from './UtilityPane.tsx';

const KEY_ACCESSIBLE_NAME: Readonly<Record<string, string>> = Object.freeze({
  '←': 'Left arrow',
  '→': 'Right arrow',
  '↑': 'Up arrow',
  '↓': 'Down arrow',
});

interface HelpCopy {
  readonly summary: string;
  readonly hint: string;
  readonly method: string;
}

const WORKBENCH_HELP: Readonly<Record<Place, HelpCopy>> = Object.freeze({
  inputs: {
    summary: 'Build the corpus you want to study and set its reading order.',
    hint: 'Import a text, try a prepared sample, or open a text row to inspect and rescope it.',
    method: 'The active order governs corpus reading. Reordering or removing a text recomputes analyses without changing saved source files.',
  },
  trends: {
    summary: 'See where tracked terms occur, keep company, and lead into close reading.',
    hint: 'Select a text title to use that whole text, or drag from one title to another to include every text between them. Move through the graph to read exact positions; start and commit a range to compare that passage with the rest of the corpus. Double-click the graph to clear that range. On touch screens, double-tap the graph to clear that range.',
    method: 'Trend bins summarize indexed token positions. Trend settings govern binning, measure, and smoothing in this same workspace.',
  },
  matches: {
    summary: 'Read term occurrences as one continuous, corpus-order sequence.',
    hint: 'Move by row for nearby context, or open a match to read its authenticated source page.',
    method: 'Rows are occurrence-ranked while context is fetched from the indexed source. Sparse source gaps are compressed rather than presented as prose distance.',
  },
  vocabulary: {
    summary: 'See which words characterize the active scope.',
    hint: 'Filter the table live, inspect document spread, and select a term when you want to track it elsewhere.',
    method: 'Counts and dispersion use the active scope. Common-word and text filters remove rows without changing the surviving statistics.',
  },
  compare: {
    summary: 'Contrast a selected passage with what lies outside it, or compare two texts.',
    hint: 'Select a range in Trends, or choose two text sides here; then refine ranking, filters, and interval whiskers in Compare settings.',
    method: 'Whole-distribution divergence is separate from the ranked term rows. Range comparison uses the exact selected tokens as A and their corpus complement as B.',
  },
});

const READER_HELP: HelpCopy = Object.freeze({
  summary: 'Read exact source text at the shared corpus position.',
  hint: 'Use the page controls or page edges to move, jump between tracked references, or enter the speed reader.',
  method: 'Reader presents authenticated plain text from the active corpus. Page fitting preserves the current start position when the viewport or display settings change.',
});

const RSVP_HELP: HelpCopy = Object.freeze({
  summary: 'Advance through the Reader source at a controlled pace.',
  hint: 'Use Space to play or pause, adjust pace with the visible controls, and return to Reader whenever you want the full page.',
  method: 'The speed reader uses the same authenticated, bounded source as Reader. Punctuation and paragraph rests affect timing without inventing text structure.',
});

function helpCopy(context: ShortcutHelpContext, place: Place): HelpCopy {
  if (context === 'reader') return READER_HELP;
  if (context === 'rsvp') return RSVP_HELP;
  return WORKBENCH_HELP[place];
}

function viewName(context: ShortcutHelpContext, place: Place): string {
  if (context === 'reader') return 'Reader';
  if (context === 'rsvp') return 'Speed reader';
  return PLACE_HEADING[place];
}

function Credits({ onBack }: { readonly onBack: () => void }) {
  return (
    <div className="help-credits-sections">
      <button id="help-credits-back" type="button" className="help-credits-back" onClick={onBack}>
        <span aria-hidden="true">←</span> Help
      </button>
      <section aria-labelledby="help-credits-project">
        <h3 id="help-credits-project">Project</h3>
        <p>
          textTrends is designed and built by <a href="https://yalethom.as/">Yale Thomas</a>,
          with Claude and Codex.
        </p>
        <p><a href="https://github.com/y4le/textTrends">Source code on GitHub</a></p>
      </section>
      <section aria-labelledby="help-credits-texts">
        <h3 id="help-credits-texts">Text sources</h3>
        <p>
          User-imported text stays in this browser. The bundled Sherlock Holmes and Jane
          Austen samples were prepared from public-domain editions published by{' '}
          <a href="https://standardebooks.org/">Standard Ebooks</a>; its editorial work is{' '}
          <a href="https://standardebooks.org/contribute/volunteer/copyright">released as CC0</a>.
        </p>
        <p>
          Browsing the Standard Ebooks catalog makes no external request; it ships with the
          app. Choosing a title is the only request for outside content: its source files
          download from GitHub (raw.githubusercontent.com), then extraction and analysis
          happen in this browser.
        </p>
      </section>
      <section aria-labelledby="help-credits-runtime">
        <h3 id="help-credits-runtime">Under the hood</h3>
        <p>
          Built with <a href="https://react.dev/">React</a>,{' '}
          <a href="https://www.typescriptlang.org/">TypeScript</a>, and{' '}
          <a href="https://vite.dev/">Vite</a>. Indexing, analysis, persistence, and imported
          source reading run locally in the browser.
        </p>
      </section>
      <p className="help-credits-signoff">Read closely. Compute locally.</p>
    </div>
  );
}

export function HelpPane({
  context,
  place,
  onFind,
  onSettings,
  onDebug,
  onClose,
}: {
  readonly context: ShortcutHelpContext;
  readonly place: Place;
  readonly onFind: () => void;
  readonly onSettings: () => void;
  readonly onDebug: () => void;
  readonly onClose: () => void;
}) {
  const [surface, setSurface] = useState<'help' | 'credits'>('help');
  const restoreCreditsFocus = useRef(false);
  const activeTextCount = useApp(
    (state) => state.projectSession?.project.data.order.length ?? 0,
  );
  const footerAvailable = useApp((state) => state.snapshot !== null
    && state.snapshot.readyDocs.length > 0
    && state.snapshot.readyDocs.some((doc) =>
      (state.corpusTokenCounts.get(doc) ?? 0) > 0));
  const trendView = useApp((state) => state.trendView);
  const readerScale = useApp((state) => state.readerScale);
  const sections = shortcutHelpSections(context !== 'workbench'
    ? context === 'reader' ? { context, scale: readerScale } : { context }
    : { context, place, activeTextCount, footerAvailable, trendView });
  const copy = helpCopy(context, place);
  const currentView = viewName(context, place);

  useEffect(() => {
    if (surface !== 'help' || !restoreCreditsFocus.current) return undefined;
    restoreCreditsFocus.current = false;
    const frame = requestAnimationFrame(() => {
      document.getElementById('help-credits-open')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [surface]);

  const showHelp = () => {
    restoreCreditsFocus.current = true;
    setSurface('help');
  };

  return (
    <UtilityPane
      title={surface === 'help' ? 'Help' : 'Credits & sources'}
      subtitle={surface === 'help'
        ? `Guidance for ${currentView}, useful actions, and keyboard or touch controls.`
        : 'Project, text provenance, and the tools behind textTrends.'}
      focusKey={`${context}:${place}:${surface}`}
      initialFocus={surface === 'help' ? 'heading' : 'first-control'}
      {...(surface === 'credits' ? { initialFocusId: 'help-credits-back' } : {})}
      className={surface === 'help' ? 'help-pane' : 'help-pane help-credits-pane'}
      layerClassName="help-layer"
      compactClose
      closeOnBackdrop
      closeKeyshortcuts={shortcutAria(['reader-close', 'show-help'])}
      onClose={onClose}
      onKeyDown={(event) => {
        if (isShortcutTypingTarget(event.target)) return;
        if (shortcutMatches(event, 'show-help')) {
          event.preventDefault();
          onClose();
        } else if (shortcutMatches(event, 'show-debug')) {
          event.preventDefault();
          onDebug();
        }
      }}
      footer={surface === 'help'
        ? (
            <div className="help-footer-actions">
              <button id="help-credits-open" type="button" onClick={() => setSurface('credits')}>
                Credits &amp; sources <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                aria-keyshortcuts={shortcutAria(['show-debug'])}
                onClick={onDebug}
              >
                Debug <kbd aria-hidden="true">Shift + D</kbd>
              </button>
            </div>
          )
        : undefined}
    >
      {surface === 'credits'
        ? <Credits onBack={showHelp} />
        : (
            <div className="help-content">
              <div className="help-overview">
                <section aria-labelledby="help-this-view">
                  <h3 id="help-this-view">This view</h3>
                  <p><strong>{currentView}</strong> · {copy.summary}</p>
                  <p>{copy.hint}</p>
                </section>
                <section aria-labelledby="help-actions">
                  <h3 id="help-actions">Quick actions</h3>
                  <div className="help-actions">
                    <button type="button" onClick={onSettings}>Display settings</button>
                    {context === 'reader' && (
                      <button
                        type="button"
                        aria-keyshortcuts={shortcutAria(['find-open'])}
                        onClick={onFind}
                      >
                        Find in corpus <kbd aria-hidden="true">/</kbd>
                      </button>
                    )}
                  </div>
                </section>
                <section aria-labelledby="help-method">
                  <h3 id="help-method">Method &amp; privacy</h3>
                  <p>{copy.method}</p>
                  <p>Imported text is processed in this browser and is never uploaded.</p>
                </section>
              </div>
              <section className="help-shortcuts" aria-labelledby="help-shortcuts">
                <h3 id="help-shortcuts">Keyboard &amp; gestures</h3>
                <div className="shortcut-help-sections">
                  {sections.map((section) => (
                    <section
                      className="shortcut-help-section"
                      key={section.title}
                      aria-labelledby={`help-shortcut-${section.title.toLowerCase().replaceAll(' ', '-')}`}
                    >
                      <h4 id={`help-shortcut-${section.title.toLowerCase().replaceAll(' ', '-')}`}>
                        {section.title}
                      </h4>
                      <dl className="shortcut-help-list">
                        {section.entries.map((entry) => (
                          <div key={entry.id}>
                            <dt>
                              {entry.keys.map((key, index) => (
                                <Fragment key={`${key}:${index}`}>
                                  {index > 0 && (
                                    <span className="shortcut-help-key-separator" aria-hidden="true">/</span>
                                  )}
                                  <kbd
                                    {...(KEY_ACCESSIBLE_NAME[key]
                                      ? {
                                          'aria-label': KEY_ACCESSIBLE_NAME[key],
                                          title: KEY_ACCESSIBLE_NAME[key],
                                        }
                                      : {})}
                                  >
                                    {key}
                                  </kbd>
                                </Fragment>
                              ))}
                            </dt>
                            <dd>{entry.label}</dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ))}
                </div>
              </section>
            </div>
          )}
    </UtilityPane>
  );
}
