import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEX_RECIPE,
  decodeDocumentSource,
  defaultExtractionRecipes,
  finalizeExtraction,
  hashExtractionRecipe,
  hashIndexRecipe,
  validateProjectManifest,
  type ProjectManifestV2,
} from '../src/index.ts';
import { ManifestInvalidError } from '../src/project/manifest.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function literalArtifact(text = '# Heading\n\nBody text.') {
  const recipe = (await defaultExtractionRecipes()).md;
  const document = await finalizeExtraction(
    { kind: 'literal', decoded: await decodeDocumentSource(utf8(text), recipe) },
    recipe,
  );
  return { ...document, recipe };
}

async function manifest(): Promise<ProjectManifestV2> {
  const { artifact, text, recipe } = await literalArtifact('Plain text');
  return {
    schema: 'texttrends/project/2',
    id: 'project',
    revision: 1,
    order: ['doc'],
    docs: [{
      doc: 'doc',
      sourceName: 'doc.md',
      meta: { title: 'Document', language: 'en', tags: [] },
      source: artifact.descriptor,
      sourceAvailability: 'external',
      extraction: {
        recipe,
        recipeHash: await hashExtractionRecipe(recipe),
        text: artifact.text,
        textLengthUtf16: text.length,
      },
    }],
    indexRecipe: DEFAULT_INDEX_RECIPE,
    indexRecipeHash: await hashIndexRecipe(DEFAULT_INDEX_RECIPE),
  };
}

describe('validateProjectManifest', () => {
  it('admits the exact project/2 schema and canonicalizes recipes', async () => {
    const input = await manifest();
    const admitted = await validateProjectManifest(input);
    expect(admitted).toEqual(input);
    expect(Object.isFrozen(admitted.docs[0]!.extraction.recipe)).toBe(true);
  });

  it('rejects stale schemas, hash disagreements, and order/doc disagreement', async () => {
    const input = await manifest();
    await expect(validateProjectManifest({ ...input, schema: 'texttrends/project/1' }))
      .rejects.toBeInstanceOf(ManifestInvalidError);
    await expect(validateProjectManifest({ ...input, indexRecipeHash: 'wrong' }))
      .rejects.toBeInstanceOf(ManifestInvalidError);
    await expect(validateProjectManifest({ ...input, order: ['missing'] }))
      .rejects.toBeInstanceOf(ManifestInvalidError);
  });

  it('rejects extra fields and invalid source quantities', async () => {
    const input = await manifest();
    await expect(validateProjectManifest({ ...input, extra: true }))
      .rejects.toBeInstanceOf(ManifestInvalidError);
    const doc = input.docs[0]!;
    await expect(validateProjectManifest({
      ...input,
      docs: [{ ...doc, source: { ...doc.source, byteLength: -1 } }],
    })).rejects.toBeInstanceOf(ManifestInvalidError);
  });
});
