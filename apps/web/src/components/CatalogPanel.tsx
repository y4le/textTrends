/**
 * Standard Ebooks catalog: a BAKED snapshot (standard-ebooks-catalog.json,
 * regenerated ad hoc via `pnpm update:se-catalog`) — browsing makes no
 * external/live-catalog requests; the snapshot is fetched as a hashed
 * same-origin static asset on first open, keeping ~20 kB of JSON out of the
 * entry bundle. Adding a book downloads its source from GitHub
 * (raw.githubusercontent.com, CORS-clean, by repository name) and repackages
 * it into a `.epub` in the browser, ingested through the same import path as
 * an uploaded file. Series render as ordered groups (showcasing series-based
 * analysis); the popular list follows, minus books already shown in a series.
 */

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { catalogSections, type CatalogSectionBook } from '../lib/catalog-view.ts';
import { loadStandardEbooksCatalog, type StandardEbooksCatalog } from '../lib/standard-ebooks-catalog.ts';
import { downloadEbookArchive } from '../lib/standard-ebooks.ts';

export function CatalogPanel() {
  const importFiles = useApp((s) => s.importFiles);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<StandardEbooksCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumping retries a failed asset fetch (the loader's memo clears on rejection).
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!open || catalog !== null || loadError !== null) return;
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
  }, [open, catalog, loadError, loadAttempt]);

  const sections = useMemo(() => (catalog === null ? [] : catalogSections(catalog, q)), [catalog, q]);

  const add = async (book: CatalogSectionBook) => {
    setAdding(book.name);
    setError(null);
    try {
      const { bytes } = await downloadEbookArchive(book.name);
      // A re-readable FileLike: ingest transfers/detaches the buffer it is
      // handed, and persist / retry / warm re-extraction read the source again,
      // so hand out a FRESH copy on every call rather than one shared buffer.
      importFiles([{ name: `${book.name}.epub`, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer }]);
    } catch (e) {
      setError(`Could not add “${book.title}”: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAdding(null);
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
        disabled={adding !== null}
        style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', cursor: adding ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
      >
        {adding === book.name ? 'adding…' : 'add'}
      </button>
    </li>
  );

  return (
    <section style={{ marginTop: 'var(--space-3)' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg)', background: 'none', border: '1px solid var(--rule)', padding: '2px 0.75ch', cursor: 'pointer' }}
      >
        {open ? '▾' : '▸'} Standard Ebooks catalog
      </button>

      {open && loadError !== null && (
        <p style={{ ...label, marginTop: 'var(--space-2)', color: 'var(--accent-text)' }}>
          Could not load the catalog: {loadError}{' '}
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

      {open && loadError === null && catalog === null && (
        <p style={{ ...label, marginTop: 'var(--space-2)' }}>loading catalog…</p>
      )}

      {open && catalog !== null && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter by title, author, or series"
            aria-label="Filter the Standard Ebooks catalog"
            style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', padding: '2px 0.75ch', width: '100%', boxSizing: 'border-box' }}
          />

          {error && <p style={{ ...label, color: 'var(--accent-text)' }}>{error}</p>}

          <div style={{ maxHeight: '18em', overflowY: 'auto', marginTop: 'var(--space-2)' }}>
            {sections.map((section) => (
              <div key={section.key}>
                <h4 style={{ ...label, margin: 'var(--space-2) 0 var(--space-1)' }}>
                  {section.title === null ? 'Popular' : `${section.title} (series)`}
                </h4>
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
    </section>
  );
}
