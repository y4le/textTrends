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

import { ROOT_KEY, STRUCTURE_LIMITS_V0, type EditableSectionValue } from '@texttrends/core';
import type { StructureQueryResultV1 } from '../shared/analysis-contract.ts';

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

/**
 * Recompute every draft row's `level` from its lineage-PARENT chain (root = 0)
 * so a re-parent keeps `level` consistent with the actual hierarchy — including
 * a moved subtree's descendants. `level` is display metadata the section
 * validator does NOT treat as depth authority (parent links are), so the editor
 * normalizes it here rather than persisting a mismatch. A row whose parent is
 * missing or forms a cycle collapses to level 0 (the section validator then
 * rejects the illegal parent on Apply).
 */
export function normalizeLevels(rows: readonly EditableSectionValue[]): EditableSectionValue[] {
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  const depth = new Map<string, number>();
  const depthOf = (key: string, seen: Set<string>): number => {
    const cached = depth.get(key);
    if (cached !== undefined) return cached;
    const row = byKey.get(key);
    if (!row || row.parent === undefined || !byKey.has(row.parent) || seen.has(key)) {
      depth.set(key, 0);
      return 0;
    }
    seen.add(key);
    const d = depthOf(row.parent, seen) + 1;
    depth.set(key, d);
    return d;
  };
  return rows.map((r) => ({ ...r, level: depthOf(r.key, new Set()) }));
}

/** The UI's own guard against the §5 section cap (the worker is the authority,
 *  but the editor should not let a user build an inevitably-rejected draft). */
export function canAddSection(rowCount: number): boolean {
  return rowCount < STRUCTURE_LIMITS_V0.maxSectionsPerTable;
}

/** A fresh top-level placeholder chapter for the editor's Add. The key comes
 *  from an injected allocator (production: `user-${crypto.randomUUID()}`) and is
 *  retained through subsequent edits; the range is a placeholder the user moves. */
export function newDraftSection(key: string, rootEnd: number): EditableSectionValue {
  return { key, parent: ROOT_KEY, level: 1, title: 'New chapter', chars: { start: 0, end: rootEnd > 0 ? 1 : 0 } };
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
