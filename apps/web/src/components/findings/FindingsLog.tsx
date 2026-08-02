import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  findingsRowControlId,
  findingsRowTarget,
  findingsRowTargetIsStale,
  reviewShareDraft,
  savedRangeRows,
  shareReviewTarget,
  type FindingsRowKind,
  type FindingsRowTarget,
  type ShareReviewTarget,
} from '../../lib/findings-view.ts';
import { groupIdentity } from '../../lib/notebook.ts';
import {
  pinTrackLegend,
} from '../../lib/pins.ts';
import {
  renderedRowDetailLayer,
  rowDetailSurface,
  rowDetailWrite,
} from '../../lib/row-detail.ts';
import { useApp } from '../../lib/store-instance.ts';
import type { SelectionCheck } from '../../lib/store.ts';
import { FormLayer } from '../FormLayer.tsx';
import { usePresentation } from '../PresentationProvider.tsx';
import { FindingsAttention, ResearchRecord } from './ResearchRecord.tsx';
import {
  RecordRows,
  type FindingsPinRow,
} from './RecordRows.tsx';
import { ShareReview } from './ShareReview.tsx';

type FindingsTarget = FindingsRowTarget | ShareReviewTarget;

function headingFor(kind: FindingsRowKind): string {
  switch (kind) {
    case 'range': return 'findings-ranges-heading';
    case 'pin': return 'findings-pins-heading';
    case 'anchor': return 'findings-anchors-heading';
  }
}

export function FindingsLog() {
  const presentation = usePresentation();
  const project = useApp((state) => state.projectSession?.project ?? null);
  const researchPersistence = useApp((state) => state.researchPersistence);
  const savedSelections = useApp((state) => state.savedSelections);
  const selectionChecks = useApp((state) => state.selectionChecks);
  const selectionError = useApp((state) => state.selectionError);
  const pins = useApp((state) => state.pins);
  const focusedPinId = useApp((state) => state.focusedPinId);
  const pinAnnouncement = useApp((state) => state.pinAnnouncement);
  const pinFeedbackOrigin = useApp((state) => state.pinFeedbackOrigin);
  const durablePins = useApp((state) => state.durablePins);
  const restoreIssues = useApp((state) => state.pinRestoreIssues);
  const notebook = useApp((state) => state.notebook);
  const styleSlots = useApp((state) => state.styleSlots);
  const shareNotice = useApp((state) => state.shareNotice);
  const layers = useApp((state) => state.layers);
  const saveNamedSelection = useApp((state) => state.saveNamedSelection);
  const previewNamedSelection = useApp((state) => state.previewNamedSelection);
  const applyNamedSelection = useApp((state) => state.applyNamedSelection);
  const removeNamedSelection = useApp((state) => state.removeNamedSelection);
  const showEvidenceAt = useApp((state) => state.showEvidenceAt);
  const removePin = useApp((state) => state.removePin);
  const setPinNote = useApp((state) => state.setPinNote);
  const retryPin = useApp((state) => state.retryPin);
  const focusPin = useApp((state) => state.focusPin);
  const openReader = useApp((state) => state.openReader);
  const reloadResearch = useApp((state) => state.reloadResearch);
  const overwriteResearch = useApp((state) => state.overwriteResearch);
  const saveProject = useApp((state) => state.saveProject);
  const createShareUrl = useApp((state) => state.createShareUrl);
  const importShareLink = useApp((state) => state.importShareLink);
  const clearResearchNotice = useApp((state) => state.clearResearchNotice);
  const setPlace = useApp((state) => state.setPlace);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const popLayer = useApp((state) => state.popLayer);

  const [rangeName, setRangeName] = useState('');
  const [rangeSaveAttempt, setRangeSaveAttempt] = useState<{
    readonly name: string;
    readonly savedCount: number;
  } | null>(null);
  const [shareUrl, setShareUrl] = useState('');
  const [shareError, setShareError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [incomingDraft, setIncomingDraft] = useState('');
  const [previewPending, setPreviewPending] = useState<{
    readonly id: string;
    readonly priorCheck: SelectionCheck | undefined;
  } | null>(null);
  const hashPrefilled = useRef(false);
  const stalePopRequested = useRef(false);

  const topLayer = layers.at(-1);
  const renderedLayer = useMemo(
    () => renderedRowDetailLayer(layers),
    [layers],
  );
  const rowTarget = useMemo(
    () => findingsRowTarget(renderedLayer?.target),
    [renderedLayer],
  );
  const shareOpen = shareReviewTarget(renderedLayer?.target) !== null;
  const compact = presentation.width === 'compact';

  const titleByDoc = useMemo(
    () => new Map(
      (project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title]),
    ),
    [project],
  );
  const textByDoc = useMemo(
    () => new Map(
      (project?.data.docs ?? []).map((doc) => [doc.doc, doc.extraction.text]),
    ),
    [project],
  );
  const ranges = useMemo(
    () => savedRangeRows(savedSelections, selectionChecks, titleByDoc),
    [savedSelections, selectionChecks, titleByDoc],
  );
  const pinRows = useMemo<readonly FindingsPinRow[]>(() => {
    const liveIdentity = new Map(
      notebook.groups.map((group) => [group.id, groupIdentity(group)]),
    );
    const liveSeries = notebook.groups.map((group) => ({
      id: group.id,
      label: group.name,
      styleSlot: styleSlots.get(group.id) ?? 0,
    }));
    return pins.map((pin) => {
      const durable = pin.kind !== 'ready'
        ? undefined
        : durablePins.find((candidate) => {
            const start = pin.evidence.docCharsUtf16.start
              + pin.evidence.anchorCharsUtf16.start;
            const end = pin.evidence.docCharsUtf16.start
              + pin.evidence.anchorCharsUtf16.end;
            return candidate.anchor.doc === pin.anchor.doc
              && candidate.anchor.text === textByDoc.get(pin.anchor.doc)
              && candidate.anchor.chars.start === start
              && candidate.anchor.chars.end === end;
          });
      return {
        pin,
        durable,
        title: titleByDoc.get(pin.anchor.doc) ?? pin.anchor.doc,
        legend: pinTrackLegend(
          pin.tracks,
          (id) => liveIdentity.get(id) ?? null,
          liveSeries,
        ),
      };
    });
  }, [durablePins, notebook, pins, styleSlots, textByDoc, titleByDoc]);
  const idsByKind = useMemo(() => ({
    range: new Set(savedSelections.map((selection) => selection.id)),
    pin: new Set(pins.map((pin) => pin.id)),
    anchor: new Set(restoreIssues.map((issue) => issue.pin.id)),
  }), [pins, restoreIssues, savedSelections]);
  const localDocuments = useMemo(
    () => [...textByDoc].map(([doc, text]) => ({ doc, text })),
    [textByDoc],
  );
  const shareReview = useMemo(
    () => reviewShareDraft(incomingDraft, localDocuments),
    [incomingDraft, localDocuments],
  );

  useEffect(() => {
    if (hashPrefilled.current) return;
    hashPrefilled.current = true;
    if (typeof location !== 'undefined' && location.hash.startsWith('#s=')) {
      setIncomingDraft(location.href);
    }
  }, []);

  useEffect(() => {
    if (rangeSaveAttempt === null) return;
    if (savedSelections.length > rangeSaveAttempt.savedCount) {
      setRangeName((current) =>
        current === rangeSaveAttempt.name ? '' : current);
      setRangeSaveAttempt(null);
    } else if (selectionError !== null) {
      // Keep the submitted name available for correction/retry.
      setRangeSaveAttempt(null);
    }
  }, [rangeSaveAttempt, savedSelections.length, selectionError]);

  useEffect(() => {
    stalePopRequested.current = false;
  }, [renderedLayer?.id]);

  useEffect(() => {
    if (
      rowTarget === null
      || !findingsRowTargetIsStale(rowTarget, idsByKind)
      || stalePopRequested.current
    ) return;
    const index = renderedLayer ? layers.indexOf(renderedLayer) : -1;
    stalePopRequested.current = popLayer(
      index < 0 ? 1 : layers.length - index,
      headingFor(rowTarget.kind),
    );
  }, [idsByKind, layers, popLayer, renderedLayer, rowTarget]);

  useEffect(() => {
    if (focusedPinId === null) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(findingsRowControlId('pin', focusedPinId))
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedPinId, pinAnnouncement]);

  const showEvidenceSheet = (returnFocusTo: string) => {
    if (presentation.width === 'wide') {
      requestAnimationFrame(() => {
        document.getElementById('evidence-region')?.focus({ preventScroll: true });
      });
      return;
    }
    pushLayer(
      'sheet',
      Object.freeze({ surface: 'evidence' }),
      returnFocusTo,
      { detent: 'tall' },
    );
  };

  useEffect(() => {
    if (previewPending === null) return;
    const check = selectionChecks.get(previewPending.id);
    if (check === previewPending.priorCheck) return;
    setPreviewPending(null);
    if (check?.status === 'ok') {
      showEvidenceSheet(findingsRowControlId('range', previewPending.id));
    }
  }, [presentation.width, previewPending, selectionChecks]);

  const writeTarget = (next: FindingsTarget, returnFocusTo: string): boolean => {
    if (
      (renderedLayer && topLayer?.id !== renderedLayer.id)
      || topLayer?.kind === 'sheet'
      || topLayer?.kind === 'reader'
    ) return false;
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail'
        ? rowDetailSurface(topLayer.target)
        : null,
      next.surface,
    );
    if (write === 'replace') {
      replaceLayer('row-detail', Object.freeze(next), returnFocusTo);
    } else {
      pushLayer('row-detail', Object.freeze(next), returnFocusTo);
    }
    return true;
  };

  const openRow = (kind: FindingsRowKind, id: string) => {
    if (rowTarget?.kind === kind && rowTarget.id === id) {
      if (topLayer?.id === renderedLayer?.id) popLayer();
      return;
    }
    if (writeTarget(
      { surface: 'findings-row', kind, id },
      findingsRowControlId(kind, id),
    ) && kind === 'pin') {
      focusPin(id);
    }
  };

  const openShareReview = () => {
    if (shareOpen) return;
    writeTarget({ surface: 'share-review' }, 'findings-review-share');
  };

  const closeShareReview = () => {
    if (shareOpen && topLayer?.id === renderedLayer?.id) popLayer();
  };

  const removeOpenRow = (
    kind: FindingsRowKind,
    id: string,
    survivingFocus: string,
    remove: () => void,
  ) => {
    if (rowTarget?.kind === kind && rowTarget.id === id) {
      const index = renderedLayer ? layers.indexOf(renderedLayer) : -1;
      stalePopRequested.current = popLayer(
        index < 0 ? 1 : layers.length - index,
        survivingFocus,
      );
    }
    remove();
  };

  const rangeAuthoring = (
    <form
      className="findings-range-form"
      aria-label="Save the linked range"
      onSubmit={(event) => {
        event.preventDefault();
        setRangeSaveAttempt({
          name: rangeName,
          savedCount: savedSelections.length,
        });
        saveNamedSelection(rangeName);
      }}
    >
      <label>
        range name
        <input
          className="exact-input"
          aria-label="Saved range name"
          value={rangeName}
          maxLength={256}
          onChange={(event) => setRangeName(event.currentTarget.value)}
          placeholder="name the linked range"
        />
      </label>
      <button type="submit">save range</button>
      {selectionError && <p role="alert">{selectionError}</p>}
    </form>
  );

  const reviewBody = (
    <ShareReview
      draft={incomingDraft}
      review={shareReview}
      onDraft={setIncomingDraft}
      onCancel={closeShareReview}
      onReplace={() => {
        if (shareReview.status !== 'ready') return;
        importShareLink(incomingDraft);
        closeShareReview();
      }}
    />
  );

  return (
    <div className="findings-log">
      <FindingsAttention
        project={project}
        research={researchPersistence}
        onReload={reloadResearch}
        onOverwrite={overwriteResearch}
        onSaveProject={saveProject}
      />

      <RecordRows
        ranges={ranges}
        pins={pinRows}
        issues={restoreIssues}
        target={rowTarget}
        pinAnnouncement={pinFeedbackOrigin === null ? pinAnnouncement : null}
        rangeAuthoring={rangeAuthoring}
        onOpen={openRow}
        onRangePreview={(id) => {
          setPreviewPending({
            id,
            priorCheck: selectionChecks.get(id),
          });
          previewNamedSelection(id);
        }}
        onRangeApply={applyNamedSelection}
        onRangeRemove={(id) => removeOpenRow(
          'range',
          id,
          'findings-ranges-heading',
          () => removeNamedSelection(id),
        )}
        onPinShow={(pin) => {
          showEvidenceAt(pin.anchor.doc, pin.anchor.token);
          showEvidenceSheet(findingsRowControlId('pin', pin.id));
        }}
        onPinRead={(pin) => {
          if (pin.kind !== 'ready') return;
          openReader({
            snapshot: pin.anchor.snapshot,
            doc: pin.anchor.doc,
            token: pin.anchor.token,
            from: 'pin',
          }, findingsRowControlId('pin', pin.id));
        }}
        onPinRetry={retryPin}
        onPinNote={setPinNote}
        onPinRemove={(id) => {
          const index = pins.findIndex((pin) => pin.id === id);
          const survivors = pins.filter((pin) => pin.id !== id);
          const neighbour = index < 0 || survivors.length === 0
            ? null
            : survivors[Math.min(index, survivors.length - 1)]?.id ?? null;
          removeOpenRow(
            'pin',
            id,
            neighbour === null
              ? 'findings-pins-heading'
              : findingsRowControlId('pin', neighbour),
            () => removePin(id),
          );
        }}
        onIssueRepair={() => setPlace('corpus')}
        onIssueRemove={(id) => {
          const index = restoreIssues.findIndex((issue) => issue.pin.id === id);
          const survivors = restoreIssues.filter((issue) => issue.pin.id !== id);
          const neighbour = index < 0 || survivors.length === 0
            ? null
            : survivors[Math.min(index, survivors.length - 1)]?.pin.id ?? null;
          removeOpenRow(
            'anchor',
            id,
            neighbour === null
              ? 'findings-pins-heading'
              : findingsRowControlId('anchor', neighbour),
            () => removePin(id),
          );
        }}
      />

      <section className="findings-group" aria-labelledby="findings-sharing-heading">
        <header className="findings-group-heading">
          <h3 id="findings-sharing-heading">Sharing</h3>
          <span>source-free</span>
        </header>
        <p className="findings-record-note">
          Share links include the notebook, active tracks, saved ranges, and
          view settings. Pins and source text stay on this device.
        </p>
        <div className="findings-share-actions">
          <button
            type="button"
            onClick={() => {
              setShareError(null);
              setCopyStatus(null);
              try {
                setShareUrl(createShareUrl());
              } catch (error) {
                setShareUrl('');
                setShareError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            preview share link
          </button>
          {shareUrl && (
            <>
              <textarea
                aria-label="Share link preview"
                readOnly
                value={shareUrl}
                rows={3}
              />
              <button
                type="button"
                onClick={() => {
                  if (!navigator.clipboard) {
                    setCopyStatus('Clipboard access is unavailable.');
                    return;
                  }
                  void navigator.clipboard.writeText(shareUrl)
                    .then(() => setCopyStatus('Share link copied.'))
                    .catch(() => setCopyStatus('Clipboard access is unavailable.'));
                }}
              >
                copy share link
              </button>
            </>
          )}
          {shareError && <p className="findings-record-error" role="alert">{shareError}</p>}
          {copyStatus && <p className="findings-record-note" role="status">{copyStatus}</p>}
        </div>
      </section>

      <section className="findings-group" aria-labelledby="findings-incoming-heading">
        <header className="findings-group-heading">
          <h3 id="findings-incoming-heading">Incoming shared state</h3>
          <span>review, then replace</span>
        </header>
        {!shareOpen && (
          <div className="findings-incoming-start">
            <label className="findings-share-field">
              textTrends share link
              <textarea
                className="exact-input"
                aria-label="Share link to import"
                value={incomingDraft}
                rows={3}
                onChange={(event) => setIncomingDraft(event.currentTarget.value)}
                placeholder="paste a textTrends share link"
              />
            </label>
            <button
              id="findings-review-share"
              type="button"
              aria-haspopup={compact ? 'dialog' : undefined}
              onClick={openShareReview}
            >
              review shared state
            </button>
          </div>
        )}
        {shareOpen && !compact && (
          <div
            className="share-review-inline"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeShareReview();
              }
            }}
          >
            {reviewBody}
          </div>
        )}
        {shareOpen && compact && (
          <FormLayer
            label="Review shared state"
            focusKey={renderedLayer?.id ?? 'share-review'}
            onClose={closeShareReview}
          >
            {reviewBody}
          </FormLayer>
        )}
        {shareNotice && (
          <p className="findings-share-notice" role="status">
            {shareNotice}{' '}
            <button type="button" onClick={clearResearchNotice}>dismiss</button>
          </p>
        )}
      </section>

      <ResearchRecord
        project={project}
        research={researchPersistence}
        onSaveProject={saveProject}
      />
    </div>
  );
}
