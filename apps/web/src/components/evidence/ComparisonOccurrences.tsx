import { compareSideLabel } from '../../lib/compare-view.ts';
import { kwicRowKey } from '../../lib/store.ts';
import { useApp } from '../../lib/store-instance.ts';

const number = new Intl.NumberFormat('en-US');
const oneLine = (value: string): string => value.replace(/\s+/g, ' ');

export function ComparisonOccurrences() {
  const snapshot = useApp((state) => state.snapshot);
  const evidence = useApp((state) => state.keynessEvidence);
  const view = useApp((state) => state.keynessView);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const close = useApp((state) => state.closeKeynessEvidence);
  const inspect = useApp((state) => state.showEvidenceAt);
  const openReader = useApp((state) => state.openReader);

  if (
    evidence === null
    || snapshot === null
    || evidence.snapshot !== snapshot.snapshot
  ) {
    return null;
  }

  const titleByDoc = new Map(
    (project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title]),
  );
  const titleOf = (doc: string) => titleByDoc.get(doc) ?? doc;
  const side = evidence.side.toUpperCase();
  const label = `Occurrences of “${evidence.key}” restricted to side ${side}: ${compareSideLabel(
    evidence.side,
    view,
    titleOf,
  )}`;

  return (
    <section className="comparison-occurrences" aria-label={label}>
      <header className="comparison-occurrences-heading">
        <div>
          <strong>{evidence.key}</strong>
          <p>side {side} only · {compareSideLabel(evidence.side, view, titleOf)}</p>
        </div>
        <button
          className="comparison-occurrences-dismiss"
          type="button"
          onClick={close}
        >
          dismiss
        </button>
      </header>
      {evidence.state.status === 'pending' && (
        <p className="comparison-occurrences-status">
          finding side-restricted occurrences…
        </p>
      )}
      {evidence.state.status === 'error' && (
        <p className="comparison-occurrences-status" data-error>
          {evidence.state.message}
        </p>
      )}
      {evidence.state.status === 'ready' && (
        <>
          <p className="comparison-occurrences-status">
            {evidence.state.rows.length} of {number.format(evidence.state.total)}{' '}
            {evidence.state.total === 1 ? 'occurrence' : 'occurrences'}
          </p>
          <div
            className="comparison-occurrences-port"
            role="region"
            aria-label={`Scrollable ${label}`}
            tabIndex={0}
          >
            <table aria-label="Comparison occurrence evidence">
              <thead>
                <tr>
                  <th scope="col">book</th>
                  <th scope="col">left</th>
                  <th scope="col">node</th>
                  <th scope="col">right</th>
                  <th scope="col">actions</th>
                </tr>
              </thead>
              <tbody>
                {evidence.state.rows.map((row) => {
                  const readId =
                    `comparison-occurrence-read-${encodeURIComponent(kwicRowKey(row))}`;
                  return (
                    <tr key={kwicRowKey(row)}>
                      <td title={titleOf(row.doc)}>{titleOf(row.doc)}</td>
                      <td className="comparison-occurrences-left">{oneLine(row.left)}</td>
                      <td className="comparison-occurrences-node">{oneLine(row.nodeText)}</td>
                      <td>{oneLine(row.right)}</td>
                      <td>
                        <div className="comparison-occurrence-actions">
                          <button
                            type="button"
                            onClick={() => inspect(row.doc, row.pos)}
                          >
                            inspect
                          </button>
                          <button
                            id={readId}
                            type="button"
                            onClick={() => openReader(
                              {
                                snapshot: evidence.snapshot,
                                doc: row.doc,
                                token: row.pos,
                                from: 'kwic',
                              },
                              readId,
                            )}
                          >
                            Read
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
