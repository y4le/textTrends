import { useMemo } from 'react';
import { TFIDF_SECTION_MIN_TOKENS } from '../../lib/store.ts';
import { useApp } from '../../lib/store-instance.ts';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? '—' : decimal.format(input);

export function SectionProfile() {
  const inventory = useApp((state) => state.inventory);
  const tfidf = useApp((state) => state.tfidf);
  const focusedDoc = useApp((state) => state.focusedDoc);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  if (inventory?.state.status !== 'ready') return null;
  const result = inventory.state.result;
  const sectionDoc = focusedDoc ?? result.documents[0]?.doc ?? null;
  const rows = sectionDoc === null || !result.sections
    ? []
    : result.sections.rows.filter((row) => row.doc === sectionDoc);
  const maxTokens = Math.max(1, ...rows.map((row) => row.selectedTokens));

  return (
    <section
      aria-label="Focused-book vocabulary"
      style={{ marginTop: 'var(--space-3)', borderTop: '1px solid var(--rule)', paddingTop: 'var(--space-2)' }}
    >
      <h3 style={{ fontSize: 'var(--text-sm)' }}>Focused-book section profile</h3>
      {result.sections?.truncated && (
        <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-xs)' }}>
          Section summaries reached the bounded result cap; later sections are omitted.
        </p>
      )}
      {rows.length === 0
        ? <p>No section summaries are available for this book and selection.</p>
        : (
          <>
            <div
              className="section-vocabulary-strip"
              role="img"
              aria-label={`${rows.length} section vocabulary strip for ${titleByDoc.get(sectionDoc!) ?? sectionDoc}`}
              style={{ display: 'flex', alignItems: 'end', gap: 2, height: 48, maxWidth: 560 }}
            >
              {rows.map((row) => (
                <span
                  key={row.id}
                  aria-hidden="true"
                  title={`${row.title ?? row.id}: ${number.format(row.selectedTokens)} selected tokens, ${number.format(row.types)} types`}
                  style={{
                    flex: 1,
                    minWidth: 2,
                    height: Math.max(2, row.selectedTokens / maxTokens * 48),
                    background: 'var(--accent-text)',
                    opacity: 0.7,
                  }}
                />
              ))}
            </div>
            <details>
              <summary>exact section values</summary>
              <div
                className="horizontal-data-port"
                role="region"
                aria-label="Exact focused-book section values"
                tabIndex={0}
              >
                <table aria-label="Focused-book section values">
                  <thead><tr><th scope="col">section</th><th scope="col">selected tokens</th><th scope="col">types</th><th scope="col">sentences</th><th scope="col">sentence mean</th></tr></thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <th scope="row">{row.title ?? `section ${row.id.slice(0, 8)}`}</th>
                        <td>{number.format(row.selectedTokens)}</td>
                        <td>{number.format(row.types)}</td>
                        <td>{number.format(row.sentences)}</td>
                        <td>{value(row.sentenceMean)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      <div style={{ marginTop: 'var(--space-3)' }}>
        <h3 style={{ fontSize: 'var(--text-sm)' }}>Focused-book chapter labels</h3>
        {tfidf?.state.status === 'pending' && <p>comparing chapters…</p>}
        {tfidf?.state.status === 'error' && <p style={{ color: 'var(--accent-text)' }}>{tfidf.state.message}</p>}
        {tfidf?.state.status === 'ready' && tfidf.state.result.eligibleSections < 2 && <p>Not enough chapters to compare.</p>}
        {tfidf?.state.status === 'ready' && tfidf.state.result.eligibleSections >= 2 && (
          <ol>
            {tfidf.state.result.sections.map((section) => (
              <li key={section.id}>
                <strong>{section.title ?? `section ${section.id.slice(0, 8)}`}</strong>
                {section.eligible
                  ? <> — {section.labels.length === 0 ? 'no distinctive labels' : section.labels.map((label) => label.key).join(', ')}</>
                  : <> — below the {TFIDF_SECTION_MIN_TOKENS} token threshold</>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
