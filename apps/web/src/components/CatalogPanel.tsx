/**
 * Standard Ebooks catalog SOURCE. Browse the catalog (GitHub API), then add a
 * book to the current project — its source is fetched from GitHub and
 * repackaged into a `.epub` in the browser, then ingested through the same
 * import path as an uploaded file (full chapter structure). CORS-clean: no
 * standardebooks.org download, no server proxy. A GitHub token is optional and
 * only raises the rate limit; it is never bundled, only entered at runtime.
 */

import { useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import {
  CatalogError,
  downloadEbookArchive,
  listCatalog,
  type CatalogBook,
  type RateLimit,
} from '../lib/standard-ebooks.ts';

const MAX_SHOWN = 60;

export function CatalogPanel() {
  const importFiles = useApp((s) => s.importFiles);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [books, setBooks] = useState<CatalogBook[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setProgress(0);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await listCatalog(
        token.trim() || null,
        (count, rl) => { setProgress(count); setRateLimit(rl); },
        ac.signal,
      );
      setBooks(result);
    } catch (e) {
      setError(e instanceof CatalogError && e.code === 'RATE_LIMITED'
        ? 'GitHub rate limit reached — add a token below or wait for the reset.'
        : e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const add = async (book: CatalogBook) => {
    setAdding(book.name);
    setError(null);
    try {
      const { bytes } = await downloadEbookArchive(book.name, token.trim() || null);
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

  const filtered = useMemo(() => {
    if (!books) return [];
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? books.filter((b) => b.title.toLowerCase().includes(needle) || b.author.toLowerCase().includes(needle))
      : books;
    return matched.slice(0, MAX_SHOWN);
  }, [books, q]);

  const label = { fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' } as const;

  return (
    <section style={{ marginTop: 'var(--space-3)' }}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); if (!open && books === null && !loading) void load(); }}
        aria-expanded={open}
        style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg)', background: 'none', border: '1px solid var(--rule)', padding: '2px 0.75ch', cursor: 'pointer' }}
      >
        {open ? '▾' : '▸'} Standard Ebooks catalog
      </button>

      {open && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="filter by title or author"
              aria-label="Filter the Standard Ebooks catalog"
              disabled={!books}
              style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', padding: '2px 0.75ch', flex: '1 1 16ch', minWidth: '12ch' }}
            />
            {books === null && !loading && (
              <button type="button" onClick={() => void load()} style={{ font: 'inherit', fontSize: 'var(--text-xs)', cursor: 'pointer' }}>load catalog</button>
            )}
          </div>

          {loading && <p style={label}>loading catalog… {progress > 0 ? `${progress} books` : ''}</p>}
          {rateLimit?.remaining != null && <p style={label}>GitHub requests remaining: {rateLimit.remaining}</p>}
          {error && <p style={{ ...label, color: 'var(--accent-text)' }}>{error}</p>}

          {books && (
            <ul aria-label="Standard Ebooks results" style={{ listStyle: 'none', padding: 0, margin: 'var(--space-2) 0 0', display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '18em', overflowY: 'auto' }}>
              {filtered.map((b) => (
                <li key={b.name} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 'var(--text-xs)' }}>
                    <span style={{ color: 'var(--fg)' }}>{b.title}</span>{b.author ? <span style={{ color: 'var(--fg-muted)' }}> — {b.author}</span> : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => void add(b)}
                    disabled={adding !== null}
                    style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', cursor: adding ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
                  >
                    {adding === b.name ? 'adding…' : 'add'}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && <li style={label}>no matches</li>}
            </ul>
          )}

          <details style={{ marginTop: 'var(--space-2)' }}>
            <summary style={{ ...label, cursor: 'pointer' }}>GitHub token (optional — raises the rate limit)</summary>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… (kept in memory only)"
              aria-label="GitHub token"
              style={{ font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', padding: '2px 0.75ch', marginTop: 'var(--space-1)', width: '100%', boxSizing: 'border-box' }}
            />
          </details>
        </div>
      )}
    </section>
  );
}
