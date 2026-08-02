import { useEffect, useState } from 'react';
import {
  TREND_FIXED_TOKENS_MAX,
  TREND_FIXED_TOKENS_MIN,
  TREND_MAX_ROWS,
  TREND_PER_DOC_MAX,
  TREND_PER_DOC_MIN,
  TREND_RATE_DENOMINATORS,
  TREND_SMOOTHING_WINDOWS,
  type TrendBinMode,
  type TrendRateDenominator,
  type TrendSmoothingWindow,
} from '@texttrends/core';
import {
  DEFAULT_TREND_BINS,
  DEFAULT_TREND_MEASURE,
} from '../lib/store.ts';
import { fullTokenCountsForDocs } from '../lib/doc-tokens.ts';
import { useApp } from '../lib/store-instance.ts';
import { estimatedTrendRows, trendBinLimits } from '../lib/trend-settings.ts';

interface Draft {
  readonly binMode: TrendBinMode;
  readonly binCount: string;
  readonly measure: 'rate' | 'count';
  readonly denominator: TrendRateDenominator;
  readonly smoothing: 0 | TrendSmoothingWindow;
  readonly showRaw: boolean;
}

export function TrendSettings() {
  const bins = useApp((state) => state.trendBins);
  const measure = useApp((state) => state.trendMeasure);
  const snapshot = useApp((state) => state.snapshot);
  const inventory = useApp((state) => state.inventory);
  const trends = useApp((state) => state.trends);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const settingsNotice = useApp((state) => state.trendSettingsNotice);
  const apply = useApp((state) => state.applyTrendSettings);
  const initial = (): Draft => ({
    binMode: bins.mode,
    binCount: String(bins.count),
    measure: measure.kind,
    denominator: measure.kind === 'rate' ? measure.denominator : 10_000,
    smoothing: measure.kind === 'rate' ? measure.smoothing : 0,
    showRaw: measure.kind === 'rate' ? measure.showRaw : false,
  });
  const [draft, setDraft] = useState<Draft>(initial);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    setDraft(initial());
    setStatus(null);
  }, [bins, measure]);
  const count = draft.binCount.trim() === '' ? Number.NaN : Number(draft.binCount);
  const tokenCounts = snapshot === null
    ? null
    : fullTokenCountsForDocs(snapshot.readyDocs, {
        corpusTokenCounts,
        inventory,
        trends,
      });
  const staticLimits = draft.binMode === 'per-doc'
    ? { minimum: TREND_PER_DOC_MIN, maximum: TREND_PER_DOC_MAX }
    : { minimum: TREND_FIXED_TOKENS_MIN, maximum: TREND_FIXED_TOKENS_MAX };
  const limits = tokenCounts === null ? staticLimits : trendBinLimits(tokenCounts, draft.binMode);
  const alternateMode: TrendBinMode = draft.binMode === 'per-doc'
    ? 'fixed-tokens'
    : 'per-doc';
  const alternateLimits = tokenCounts === null
    ? null
    : trendBinLimits(tokenCounts, alternateMode);
  const rowEstimate = tokenCounts === null
    || !Number.isSafeInteger(count)
    || count < staticLimits.minimum
    ? null
    : estimatedTrendRows(tokenCounts, { mode: draft.binMode, count });
  const validCount = limits !== null
    && Number.isSafeInteger(count)
    && count >= limits.minimum
    && count <= limits.maximum
    && tokenCounts !== null
    && rowEstimate !== null
    && rowEstimate <= TREND_MAX_ROWS;

  const submit = () => {
    if (tokenCounts === null) {
      setStatus('Preparing corpus token extents before settings can be applied.');
      return;
    }
    if (!validCount) {
      setStatus(limits === null
        ? `This corpus cannot fit ${draft.binMode === 'per-doc' ? 'per-book' : 'fixed-token'} bins within the ${TREND_MAX_ROWS.toLocaleString()}-row limit.`
        : `Enter a whole number from ${limits.minimum.toLocaleString()} to ${limits.maximum.toLocaleString()} for this corpus.`);
      return;
    }
    const outcome = apply({
      bins: { mode: draft.binMode, count },
      measure: draft.measure === 'count'
        ? { kind: 'count' }
        : {
            kind: 'rate',
            denominator: draft.denominator,
            smoothing: draft.smoothing,
            showRaw: draft.smoothing === 0 ? false : draft.showRaw,
          },
    });
    setStatus(outcome === 'rejected'
      ? 'These settings are not valid for the current corpus.'
      : outcome === 'unchanged'
        ? 'These settings are already current.'
        : null);
  };

  return (
    <form
      className="trend-settings"
      aria-labelledby="trend-settings-heading"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 id="trend-settings-heading">Trend settings</h3>
      <fieldset>
        <legend>Result geometry</legend>
        <label>
          Bins
          <select
            value={draft.binMode}
            onChange={(event) => {
              const binMode = event.target.value as TrendBinMode;
              const nextLimits = tokenCounts === null
                ? null
                : trendBinLimits(tokenCounts, binMode);
              const preferred = binMode === 'per-doc' ? 40 : 1000;
              setDraft((current) => ({
                ...current,
                binMode,
                binCount: String(nextLimits === null
                  ? preferred
                  : Math.max(nextLimits.minimum, Math.min(nextLimits.maximum, preferred))),
              }));
              setStatus(null);
            }}
          >
            <option value="per-doc">Equal bins per book</option>
            <option value="fixed-tokens">Fixed tokens per bin</option>
          </select>
        </label>
        <label>
          {draft.binMode === 'per-doc' ? 'Bins per book' : 'Tokens per bin'}
          <input
            type="number"
            inputMode="numeric"
            min={limits?.minimum ?? staticLimits.minimum}
            max={limits?.maximum ?? staticLimits.maximum}
            step={1}
            value={draft.binCount}
            aria-describedby="trend-bin-guidance"
            aria-invalid={(tokenCounts !== null && !validCount) || undefined}
            onChange={(event) => {
              setDraft((current) => ({ ...current, binCount: event.target.value }));
              setStatus(null);
            }}
          />
        </label>
        <p id="trend-bin-guidance">
          {tokenCounts === null
            ? 'Preparing corpus token extents before settings can be applied.'
            : limits === null
              ? alternateLimits === null
                ? `No bin mode can fit this corpus within the ${TREND_MAX_ROWS.toLocaleString()}-row result limit.`
                : `This mode cannot fit the corpus within the ${TREND_MAX_ROWS.toLocaleString()}-row result limit. Choose ${alternateMode === 'per-doc' ? 'Equal bins per book' : 'Fixed tokens per bin'}.`
            : `${limits.minimum.toLocaleString()}–${limits.maximum.toLocaleString()} for this corpus · ${rowEstimate?.toLocaleString() ?? 'unknown'} result rows · limit ${TREND_MAX_ROWS.toLocaleString()}.`}
          {' '}Changing bins recomputes trend results.
        </p>
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {tokenCounts === null
            ? 'Preparing corpus token extents before trend settings can be applied.'
            : 'Corpus token extents are ready.'}
        </p>
      </fieldset>

      <fieldset>
        <legend>Presentation</legend>
        <label>
          Measure
          <select
            value={draft.measure}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                measure: event.target.value as Draft['measure'],
              }));
              setStatus(null);
            }}
          >
            <option value="rate">Rate</option>
            <option value="count">Count per bin</option>
          </select>
        </label>
        <label>
          Rate denominator
          <select
            value={draft.denominator}
            disabled={draft.measure === 'count'}
            onChange={(event) => setDraft((current) => ({
              ...current,
              denominator: Number(event.target.value) as TrendRateDenominator,
            }))}
          >
            {TREND_RATE_DENOMINATORS.map((denominator) => (
              <option key={denominator} value={denominator}>
                per {denominator.toLocaleString()} tokens
              </option>
            ))}
          </select>
        </label>
        <label>
          Smoothing
          <select
            value={draft.measure === 'count' ? 0 : draft.smoothing}
            disabled={draft.measure === 'count'}
            onChange={(event) => setDraft((current) => ({
              ...current,
              smoothing: Number(event.target.value) as Draft['smoothing'],
            }))}
          >
            <option value={0}>None</option>
            {TREND_SMOOTHING_WINDOWS.map((window) => (
              <option key={window} value={window}>{window}-bin rolling mean</option>
            ))}
          </select>
        </label>
        <label className="trend-settings-check">
          <input
            type="checkbox"
            checked={draft.showRaw}
            disabled={draft.measure === 'count' || draft.smoothing === 0}
            onChange={(event) => setDraft((current) => ({
              ...current,
              showRaw: event.target.checked,
            }))}
          />
          Show raw line behind smoothed line
        </label>
        <p>Smoothing is centered, token-weighted, and never crosses book boundaries. Counts remain unsmoothed.</p>
      </fieldset>

      {status && <p className="trend-settings-status" role="status">{status}</p>}
      {!status && settingsNotice && (
        <p className="trend-settings-status">{settingsNotice}</p>
      )}
      <div className="trend-settings-actions">
        <button
          type="button"
          onClick={() => {
            setDraft({
              binMode: DEFAULT_TREND_BINS.mode,
              binCount: String(DEFAULT_TREND_BINS.count),
              measure: DEFAULT_TREND_MEASURE.kind,
              denominator: DEFAULT_TREND_MEASURE.kind === 'rate'
                ? DEFAULT_TREND_MEASURE.denominator
                : 10_000,
              smoothing: DEFAULT_TREND_MEASURE.kind === 'rate'
                ? DEFAULT_TREND_MEASURE.smoothing
                : 0,
              showRaw: DEFAULT_TREND_MEASURE.kind === 'rate'
                ? DEFAULT_TREND_MEASURE.showRaw
                : false,
            });
            setStatus(null);
          }}
        >
          Restore defaults
        </button>
        <button type="submit" disabled={tokenCounts === null}>Apply</button>
      </div>
    </form>
  );
}
