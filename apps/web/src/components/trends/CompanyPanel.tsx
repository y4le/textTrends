import { seriesColor } from '../../lib/series-style.ts';
import type { CompanyState } from '../../lib/store.ts';
import {
  COMPANY_NEARBY_GAP_EXCLUSIVE,
  formatCompanyCoverage,
  type CompanyCoverageVM,
  type CompanyPairVM,
} from '../../lib/trend-overview.ts';
import { SeriesLineSample } from '../chrome.tsx';

function coverageText(value: CompanyCoverageVM): string {
  const coverage = formatCompanyCoverage(value.coverage);
  return value.coverage === null ? coverage : `${coverage} nearby`;
}

function Coverage({ value }: { readonly value: CompanyCoverageVM }) {
  const width = `${Math.max(0, Math.min(1, value.coverage ?? 0)) * 100}%`;
  const withoutPeer = value.withoutPeerInDocument;
  const label = value.coverage === null
    ? `${value.series.label}: no occurrences`
    : `${value.series.label}: ${value.nearby} of ${value.total} occurrences have a nearest peer fewer than ${COMPANY_NEARBY_GAP_EXCLUSIVE} tokens away; ${withoutPeer} ${withoutPeer === 1 ? 'occurrence has' : 'occurrences have'} no peer in the same text`;
  return (
    <span className="company-coverage" role="img" aria-label={label} title={label}>
      <span className="company-coverage-label">{coverageText(value)}</span>
      <span className="company-coverage-track" aria-hidden="true">
        <span
          className="company-coverage-fill"
          style={{ inlineSize: width, background: seriesColor(value.series.style) }}
        />
      </span>
    </span>
  );
}

export function CompanyPanel({
  company,
  pairs,
  suspended,
  setFocus,
}: {
  readonly company: CompanyState | null;
  readonly pairs: readonly CompanyPairVM[];
  readonly suspended: boolean;
  readonly setFocus: (value: readonly [string, string] | null) => void;
}) {
  return (
    <section
      className="trend-overview-panel company-panel"
      data-trend-overview-section="company"
      aria-labelledby="trend-company-heading"
    >
      <header>
        <h3 id="trend-company-heading">company</h3>
        <p>nearest span gaps · both directions · whole corpus</p>
      </header>
      {company === null && suspended ? (
        <p className="trend-overview-status">whole-corpus analysis paused for the range comparison</p>
      ) : company === null || company.state.status === 'pending' ? (
        <p className="trend-overview-status" role="status">measuring which terms keep company…</p>
      ) : company.state.status === 'error' ? (
        <p className="trend-overview-status" role="alert">Company unavailable: {company.state.message}</p>
      ) : (
        <ol className="company-list">
          {pairs.map((pair) => {
            const label = `${pair.left.series.label} and ${pair.right.series.label}`;
            const action = pair.selected
              ? `Clear ${label} focus in Reading Destinations`
              : `Focus Reading Destinations on ${label}`;
            return (
              <li key={pair.key}>
                <button
                  type="button"
                  className="company-pair"
                  data-focused={pair.selected || undefined}
                  aria-pressed={pair.selected}
                  aria-label={`Reading Destinations focus: ${label}`}
                  title={action}
                  onClick={() => setFocus(pair.selected ? null : pair.seriesIds)}
                >
                  <span className="company-pair-names">
                    <span>
                      <SeriesLineSample style={pair.left.series.style} emphasized={pair.selected} />
                      {pair.left.series.label}
                    </span>
                    <span aria-hidden="true">+</span>
                    <span>
                      <SeriesLineSample style={pair.right.series.style} emphasized={pair.selected} />
                      {pair.right.series.label}
                    </span>
                  </span>
                  <span className="company-pair-coverage">
                    <Coverage value={pair.left} />
                    <Coverage value={pair.right} />
                  </span>
                  <span className="company-pair-note">
                    share {pair.docsWithBoth.toLocaleString()} {pair.docsWithBoth === 1 ? 'text' : 'texts'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="trend-overview-method-note">
        “Nearby” means an interval gap under {COMPANY_NEARBY_GAP_EXCLUSIVE} indexed tokens. The two bars stay separate so a common term cannot imply mutual closeness by itself.
      </p>
    </section>
  );
}
