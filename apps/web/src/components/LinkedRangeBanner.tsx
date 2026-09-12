import type { Place } from '../lib/places.ts';
import { selectionTokenCount } from '../lib/selection.ts';
import { useApp } from '../lib/store-instance.ts';

const integer = new Intl.NumberFormat();

export function LinkedRangeBanner({ place }: { readonly place: Place }) {
  const selection = useApp((state) => state.linkedSelection);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const setLinkedSelection = useApp((state) => state.setLinkedSelection);
  if (selection === null) return null;

  const tokens = selectionTokenCount(selection);
  const titleByDoc = new Map(
    (project?.data.docs ?? []).map((document) => [document.doc, document.meta.title]),
  );
  const first = selection.ranges[0]!;
  const label = selection.ranges.length === 1
    ? `Measuring ${integer.format(tokens)} ${tokens === 1 ? 'token' : 'tokens'} in ${titleByDoc.get(first.doc) ?? first.doc}`
    : `Measuring ${integer.format(tokens)} tokens across ${integer.format(selection.ranges.length)} texts`;

  return (
    <p className="linked-range-banner">
      <span>{label}</span>
      <button
        type="button"
        className="coarse-target"
        onClick={() => {
          setLinkedSelection(null);
          requestAnimationFrame(() => {
            document.getElementById(`place-${place}-heading`)?.focus({ preventScroll: true });
          });
        }}
      >
        Use all texts
      </button>
    </p>
  );
}
