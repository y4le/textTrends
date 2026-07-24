/**
 * A root-only V2 structure fixture bound to a shard's text — the replacement
 * for the deleted V1 `rootOnlyStructure` helper (the V1 lineage had no
 * production producer; V2 is the only sanctioned structure schema). Empty
 * candidates + an empty override compose to exactly one fixed root section
 * spanning the whole text.
 */
import {
  composeStructure,
  DEFAULT_STRUCTURE_RECIPE,
  emptyOverride,
  type StructureArtifactV2,
} from '../../src/structure/build.ts';

export function rootOnlyV2(text: string, textHash: string): StructureArtifactV2 {
  const candidates = 'fixture-candidates';
  const recipe = 'fixture-recipe';
  return composeStructure(text, [], DEFAULT_STRUCTURE_RECIPE, emptyOverride(textHash, candidates, recipe), {
    text: textHash,
    candidates,
    recipe,
    override: 'fixture-override',
  });
}
