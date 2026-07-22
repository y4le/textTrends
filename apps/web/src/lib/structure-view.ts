/**
 * Pure derivations over a `StructureQueryResultV1` for the preview UI and the
 * chart boundary rules (commit 8a). Kept DOM- and worker-free so the topology
 * rules — parent-root identification, top-level filtering, edge/dup exclusion —
 * are unit-tested without rendering.
 *
 * Hierarchy authority is the PARENT link, never `level` (the section validator
 * treats `level` as display metadata a user replacement can make disagree with
 * the parent graph). A "top-level" chapter is therefore a direct child of the
 * document root, not `level === 1`.
 */

import type { StructureQueryResultV1 } from '../worker/protocol-v4.ts';

export type StructureRow = StructureQueryResultV1['rows'][number];

/** The document root is the one parent-less row (origin `fixed`, key `root`);
 *  its bound SectionId is the parent every top-level chapter points at. */
export function rootSectionId(rows: readonly StructureRow[]): string | null {
  for (const r of rows) if (r.section.parent === undefined) return r.section.id;
  return null;
}

/** Top-level chapter START tokens for the chart's boundary rules: the token
 *  index at which each direct child of the root begins, EXCLUDING the root
 *  itself and the document-start edge (token 0 — already a book boundary),
 *  deduplicated and ascending. Deeper headings are panel-only (no barcode). */
export function topLevelBoundaryTokens(rows: readonly StructureRow[]): number[] {
  const rootId = rootSectionId(rows);
  if (rootId === null) return [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (r.section.id === rootId) continue;
    if (r.section.parent !== rootId) continue;
    const t = r.tokens.start;
    if (t > 0) seen.add(t); // token 0 duplicates the document edge
  }
  return [...seen].sort((a, b) => a - b);
}

/** A short human label for a section's detection provenance (§12.4 origin). */
export function provenanceLabel(origin: StructureRow['section']['origin']): string {
  switch (origin) {
    case 'source': return 'Markdown heading';
    case 'heuristic': return 'chapter heuristic';
    case 'user': return 'your correction';
    case 'fixed': return 'whole document';
  }
}
