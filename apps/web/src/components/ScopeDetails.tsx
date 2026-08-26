import type { ScopeVM } from '../lib/scope-view.ts';

const number = new Intl.NumberFormat();
export const SCOPE_DETAILS_ID = 'scope-details';

function PopoverAction({
  children,
  onClick,
}: {
  readonly children: React.ReactNode;
  readonly onClick?: () => void;
}) {
  return (
    <button
      className="coarse-target"
      type="button"
      popoverTarget={SCOPE_DETAILS_ID}
      popoverTargetAction="hide"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ScopeDetails({
  vm,
  canReviewRange,
  onUseAllTexts,
  onReviewRange,
  onReviewInputs,
}: {
  readonly vm: ScopeVM;
  readonly canReviewRange: boolean;
  readonly onUseAllTexts: () => void;
  readonly onReviewRange: () => void;
  readonly onReviewInputs: () => void;
}) {
  const selectedTokens = vm.range?.tokens ?? vm.tokensInScope;
  const selectedDocuments = vm.range?.documents ?? vm.docsInScope;

  return (
    <section
      id={SCOPE_DETAILS_ID}
      className="scope-details"
      popover="auto"
      aria-labelledby="scope-details-heading"
    >
      <header className="scope-details-header">
        <div>
          <h2 id="scope-details-heading">Current scope</h2>
          <p>{vm.range?.label ?? vm.corpusName}</p>
        </div>
        <PopoverAction>close</PopoverAction>
      </header>

      <dl className="scope-details-facts">
        {selectedDocuments !== null && (
          <div>
            <dt>Texts</dt>
            <dd>{number.format(selectedDocuments)}</dd>
          </div>
        )}
        {selectedTokens !== null && (
          <div>
            <dt>Tokens in scope</dt>
            <dd>{number.format(selectedTokens)}</dd>
          </div>
        )}
        {vm.totalCorpusTokens !== null && (
          <div>
            <dt>Corpus tokens</dt>
            <dd>{number.format(vm.totalCorpusTokens)}</dd>
          </div>
        )}
        <div>
          <dt>Readiness</dt>
          <dd>{vm.readyText}</dd>
        </div>
      </dl>

      {vm.partial && (
        <div className="scope-details-note" role="note">
          <strong>Partial corpus.</strong>{' '}
          {vm.missingDocTitles.length > 0
            ? `${vm.missingDocTitles.join(', ')} unavailable.`
            : 'One or more texts are unavailable.'}
        </div>
      )}
      {vm.exception !== null && <p className="scope-details-note">{vm.exception}</p>}

      <div className="scope-details-actions">
        {vm.range !== null && (
          <PopoverAction onClick={onUseAllTexts}>Use all texts</PopoverAction>
        )}
        {canReviewRange && (
          <PopoverAction onClick={onReviewRange}>Review range in Trends</PopoverAction>
        )}
        {vm.partial && (
          <PopoverAction onClick={onReviewInputs}>Review inputs</PopoverAction>
        )}
      </div>
    </section>
  );
}
