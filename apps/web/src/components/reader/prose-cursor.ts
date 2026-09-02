type CaretPointDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function offsetSpan(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  const span = element?.closest<HTMLElement>('[data-reader-offset]') ?? null;
  return span !== null && root.contains(span) ? span : null;
}

/** True only when a viewport point intersects a painted source span. */
export function hitsSourceToken(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const hit = document.elementFromPoint(clientX, clientY);
  const span = hit === null ? null : offsetSpan(root, hit);
  if (span === null) return false;
  return Array.from(span.getClientRects()).some(
    (rect) => clientX >= rect.left
      && clientX <= rect.right
      && clientY >= rect.top
      && clientY <= rect.bottom,
  );
}

/** Resolve a viewport point to an authenticated Reader-page UTF-16 offset. */
export function proseCharOffsetAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const pointDocument = document as CaretPointDocument;
  const caret = pointDocument.caretPositionFromPoint?.(clientX, clientY) ?? null;
  const legacy = caret === null
    ? pointDocument.caretRangeFromPoint?.(clientX, clientY) ?? null
    : null;
  const node = caret?.offsetNode ?? legacy?.startContainer ?? null;
  const offset = caret?.offset ?? legacy?.startOffset ?? null;
  if (node !== null && offset !== null) {
    const span = offsetSpan(root, node);
    const base = span === null ? Number.NaN : Number(span.dataset.readerOffset);
    if (span !== null && Number.isSafeInteger(base)) {
      const intra = node.nodeType === Node.TEXT_NODE
        ? offset
        : offset === 0 ? 0 : span.textContent?.length ?? 0;
      return base + intra;
    }
  }

  const hit = document.elementFromPoint(clientX, clientY);
  const span = hit === null ? null : offsetSpan(root, hit);
  const base = span === null ? Number.NaN : Number(span.dataset.readerOffset);
  return Number.isSafeInteger(base) ? base : null;
}
