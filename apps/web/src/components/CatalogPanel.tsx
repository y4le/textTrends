/**
 * Standard Ebooks catalog: a BAKED snapshot (standard-ebooks-catalog.json,
 * regenerated ad hoc via `pnpm update:se-catalog`) — browsing makes no
 * external/live-catalog requests; the snapshot is fetched as a hashed
 * same-origin static asset when Inputs mounts, keeping ~20 kB of JSON out of
 * the entry bundle. Adding a book downloads its source from GitHub
 * (raw.githubusercontent.com, CORS-clean, by repository name) and repackages
 * it into a `.epub` in the browser, ingested through the same import path as
 * an uploaded file. Series render as ordered groups (showcasing series-based
 * analysis); the popular list follows, minus books already shown in a series.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { catalogSections, type CatalogSectionBook } from '../lib/catalog-view.ts';
import { libraryOperation } from '../lib/library-operation.ts';
import type { LocalFileInput } from '../lib/local-library.ts';
import { loadStandardEbooksCatalog, type StandardEbooksCatalog } from '../lib/standard-ebooks-catalog.ts';
import { downloadEbookArchive } from '../lib/standard-ebooks.ts';

export function CatalogPanel({
  onAcquire,
}: {
  readonly onAcquire: (
    files: readonly LocalFileInput[],
    signal: AbortSignal,
    lease: symbol,
  ) => Promise<boolean>;
}) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<StandardEbooksCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumping retries a failed asset fetch (the loader's memo clears on rejection).
  const [loadAttempt, setLoadAttempt] = useState(0);
  const addController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const libraryBusy = useSyncExternalStore(
    libraryOperation.subscribe,
    libraryOperation.isBusy,
    libraryOperation.isBusy,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      addController.current?.abort();
      addController.current = null;
    };
  }, []);

  useEffect(() => {
    if (catalog !== null || loadError !== null) return;
    let cancelled = false;
    loadStandardEbooksCatalog().then(
      (loaded) => {
        if (!cancelled) setCatalog(loaded);
      },
      (e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog, loadError, loadAttempt]);

  const sections = useMemo(() => (catalog === null ? [] : catalogSections(catalog, q)), [catalog, q]);

  const add = async (book: CatalogSectionBook) => {
    const lease = libraryOperation.claim();
    if (lease === null) {
      setError('Another input is being saved. Try this ebook again when it finishes.');
      return;
    }
    addController.current?.abort();
    const controller = new AbortController();
    addController.current = controller;
    setAdding(book.name);
    setError(null);
    try {
      const { bytes } = await downloadEbookArchive(book.name, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      // The local library and ingest pipeline both read this source. Hand each
      // read a fresh buffer because worker ingestion transfers its copy.
      const accepted = await onAcquire([{
        name: `${book.name}.epub`,
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.slice().buffer,
      }], controller.signal, lease);
      if (!accepted && !controller.signal.aborted) {
        throw new Error('the ebook could not be saved and activated');
      }
    } catch (e) {
      if (controller.signal.aborted || !mounted.current) return;
      setError(`Could not add “${book.title}”: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (mounted.current && addController.current === controller) {
        addController.current = null;
        setAdding(null);
      }
      libraryOperation.release(lease);
    }
  };

  const label = { fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' } as const;

  const row = (book: CatalogSectionBook) => (
    <li key={book.name} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 'var(--text-xs)' }}>
        {book.position !== undefined && <span style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{book.position}. </span>}
        <span style={{ color: 'var(--fg)' }}>{book.title}</span>
        {book.author ? <span style={{ color: 'var(--fg-muted)' }}> — {book.author}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => void add(book)}
        disabled={adding !== null || libraryBusy}
        style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', cursor: adding ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
      >
        {adding === book.name ? 'saving…' : 'add'}
      </button>
    </li>
  );

  return (
    <div className="standard-ebooks-catalog">
      {loadError !== null && (
        <p style={{ ...label, marginTop: 'var(--space-2)', color: 'var(--accent-text)' }}>
          Could not load the Standard Ebooks library: {loadError}{' '}
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setLoadAttempt((n) => n + 1);
            }}
            style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', cursor: 'pointer' }}
          >
            retry
          </button>
        </p>
      )}

      {loadError === null && catalog === null && (
        <p style={{ ...label, marginTop: 'var(--space-2)' }}>loading Standard Ebooks library…</p>
      )}

      {catalog !== null && (
        <div className="standard-ebooks-catalog-content">
          <input
            className="standard-ebooks-filter"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter by title, author, or series"
            aria-label="Filter the Standard Ebooks library"
          />

          {error && <p style={{ ...label, color: 'var(--accent-text)' }}>{error}</p>}

          <div className="standard-ebooks-results" role="region" aria-label="Standard Ebooks results" tabIndex={0}>
            {sections.map((section) => (
              <div key={section.key}>
                <h5 style={{ ...label, margin: 'var(--space-2) 0 var(--space-1)' }}>
                  {section.title === null ? 'Popular' : `${section.title} (series)`}
                </h5>
                <ul
                  aria-label={section.title === null ? 'Popular Standard Ebooks' : `${section.title} series`}
                  style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}
                >
                  {section.books.map(row)}
                </ul>
              </div>
            ))}
            {sections.length === 0 && <p style={label}>no matches</p>}
          </div>

          <p style={{ ...label, marginTop: 'var(--space-2)' }}>
            catalog snapshot from{' '}
            <a href="https://standardebooks.org" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
              standardebooks.org
            </a>
            , generated {catalog.generatedAt.slice(0, 10)}
          </p>
        </div>
      )}
    </div>
  );
}
