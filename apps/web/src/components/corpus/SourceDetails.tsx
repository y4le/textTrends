import { bookSourceHeadingId } from '../../lib/corpus-view.ts';
import { useApp } from '../../lib/store-instance.ts';

const number = new Intl.NumberFormat('en-US');

/** Format-neutral provenance for one text in its expanded detail. */
export function SourceDetails({ doc }: { readonly doc: string }) {
  const project = useApp((state) => state.projectSession?.project ?? null);
  const extractionDiagnostics = useApp(
    (state) => state.projectSession?.extractionDiagnostics ?? null,
  );
  const source = project?.data.docs.find((candidate) => candidate.doc === doc);

  if (!source) return null;
  const diagnostics = extractionDiagnostics?.[doc] ?? null;
  const headingId = bookSourceHeadingId(doc);

  return (
    <section className="book-source-details" aria-labelledby={headingId}>
      <h4 id={headingId}>Source details</h4>
      <p>
        {source.sourceName} · {source.source.format.toUpperCase()} · {number.format(source.source.byteLength)} bytes
      </p>
      {diagnostics && (
        <p role="note">
          {diagnostics.detectedEncoding !== undefined && <>
            encoding:{' '}
            {diagnostics.detectedEncoding === 'windows-1252'
              ? <span className="book-source-encoding-warning">Windows-1252 (inferred — no BOM/UTF-8)</span>
              : <span>{diagnostics.detectedEncoding}</span>}
            {' · '}
          </>}
          this extraction: {diagnostics.decoderReplacementCount} replaced, {diagnostics.suspiciousControlCount} control chars
        </p>
      )}
    </section>
  );
}
