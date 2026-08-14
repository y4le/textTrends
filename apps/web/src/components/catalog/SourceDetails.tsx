import { useApp } from '../../lib/store-instance.ts';

const number = new Intl.NumberFormat('en-US');

/** Format-neutral source provenance for the focused ready text. */
export function SourceDetails({
  headingAs: Heading = 'h3',
}: {
  readonly headingAs?: 'h2' | 'h3' | 'h4';
}) {
  const project = useApp((state) => state.projectSession?.project ?? null);
  const snapshot = useApp((state) => state.snapshot);
  const focusedDoc = useApp((state) => state.focusedDoc);
  const extractionDiagnostics = useApp((state) => state.projectSession?.extractionDiagnostics ?? null);
  const setFocusedDoc = useApp((state) => state.setFocusedDoc);

  if (!project || !snapshot || !focusedDoc) return null;
  const ready = new Set(snapshot.readyDocs);
  const readyDocs = project.data.order.filter((doc) => ready.has(doc));
  const selected = project.data.docs.find((doc) => doc.doc === focusedDoc);
  if (!selected || readyDocs.length === 0) return null;

  const titleOf = (doc: string): string =>
    project.data.docs.find((candidate) => candidate.doc === doc)?.meta.title ?? doc;
  const diagnostics = extractionDiagnostics?.[focusedDoc] ?? null;

  return (
    <section
      aria-labelledby="source-details-heading"
      style={{
        marginTop: 'var(--space-3)',
        padding: 'var(--space-2)',
        border: '1px solid var(--rule)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Heading id="source-details-heading" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
          Source details
        </Heading>
        <label style={{ color: 'var(--fg-muted)' }}>
          text{' '}
          <select
            aria-label="Text to inspect"
            value={focusedDoc}
            onChange={(event) => setFocusedDoc(event.target.value)}
            style={{ font: 'inherit', background: 'transparent', color: 'var(--fg)', border: '1px solid var(--rule-strong)' }}
          >
            {readyDocs.map((doc) => <option key={doc} value={doc}>{titleOf(doc)}</option>)}
          </select>
        </label>
      </div>
      <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--fg-muted)' }}>
        {selected.sourceName} · {selected.source.format.toUpperCase()} · {number.format(selected.source.byteLength)} bytes
      </p>
      {diagnostics && (
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--fg-muted)' }} role="note">
          {diagnostics.detectedEncoding !== undefined && <>
            encoding:{' '}
            {diagnostics.detectedEncoding === 'windows-1252'
              ? <span style={{ color: 'var(--accent-text)' }}>Windows-1252 (inferred — no BOM/UTF-8)</span>
              : <span>{diagnostics.detectedEncoding}</span>}
            {' · '}
          </>}
          this extraction: {diagnostics.decoderReplacementCount} replaced, {diagnostics.suspiciousControlCount} control chars
        </p>
      )}
    </section>
  );
}
